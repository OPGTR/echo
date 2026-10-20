'use strict'
// Downloads: a song from Deezer's catalogue is fetched by the Deezer SpotiFLAC
// addon (exactly that song, by its id), tagged (title, artists, album, track,
// year, cover), saved under <download folder>/<Artist>/<Album>/ and added to
// the library. Two at a time; the queue survives a restart.
//
// Saving: Android's shared storage refuses some operations a plain copy does
// (setting file permissions: "EACCES ... copyfile"), and some folders can't be
// written at all (an SD card, a folder another app made). The file is written
// as a stream, and when a folder refuses it the next one is tried, down to
// one the app can always write to.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { getDB, getSetting, setSetting } = require('./db')
const { downloadDirs } = require('./paths')
const library = require('./library')
const deezer = require('./deezer')
const sources = require('./sources')
const { sniff } = require('./platform/tools')

const CONCURRENCY = 2
const active = new Map() // job id -> AbortController
let pumping = false

const now = () => Date.now()
const changes = new (require('events'))()
changes.setMaxListeners(100)
function update(id, fields) {
  const keys = Object.keys(fields)
  getDB().prepare(`UPDATE downloads SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({ ...fields, updated_at: now(), id })
  changes.emit('change', id)
}

/**
 * Waits until the download of `deezerId` ends (done, error, cancelled), up
 * to `timeoutMs`; answers with its job. The player waits this way instead of
 * asking again and again: a phone in a pocket slows the app's timers down to
 * once a minute, an answer arriving still wakes it at once.
 */
function waitFor(deezerId, timeoutMs = 60000) {
  const id = String(deezerId)
  const latest = () => {
    const owned = ownedTrack(id)
    const j = getDB().prepare('SELECT * FROM downloads WHERE deezer_id = ? ORDER BY updated_at DESC LIMIT 1').get(id)
    if (j?.status === 'done' && (j.track_id || owned)) return { ...j, track_id: j.track_id || owned }
    if (!j && owned) return { deezer_id: id, status: 'done', track_id: owned }
    return j || null
  }
  const ended = j => j && ['done', 'error', 'cancelled'].includes(j.status)
  const first = latest()
  if (ended(first) || !first) return Promise.resolve(first)
  return new Promise(resolve => {
    const done = j => { clearTimeout(timer); changes.off('change', check); resolve(j) }
    const check = () => { const j = latest(); if (ended(j)) done(j) }
    const timer = setTimeout(() => done(latest()), Math.max(1000, Math.min(120000, Number(timeoutMs) || 60000)))
    changes.on('change', check)
  })
}
const job = id => getDB().prepare('SELECT * FROM downloads WHERE id = ?').get(id)

function list() {
  return getDB().prepare(`SELECT d.*, t.path AS path FROM downloads d LEFT JOIN tracks t ON t.id = d.track_id ORDER BY CASE d.status WHEN 'downloading' THEN 0 WHEN 'saving' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, d.updated_at DESC LIMIT 300`).all()
}

/** The library track for a Deezer song, if you have it. */
function ownedTrack(deezerId) {
  return getDB().prepare('SELECT id FROM tracks WHERE deezer_id = ?').get(String(deezerId))?.id || null
}

/** Queues songs ([{ deezer_id, title, artist, album, cover, duration }]). Returns their jobs. */
function enqueue(items) {
  const db = getDB()
  const out = []
  for (const item of (Array.isArray(items) ? items : []).slice(0, 500)) {
    const deezerId = String(item?.deezer_id || '').replace(/^deezer:/, '')
    if (!/^\d{1,20}$/.test(deezerId)) continue
    const have = ownedTrack(deezerId)
    if (have) { out.push({ deezer_id: deezerId, status: 'done', track_id: have }); continue }
    const existing = db.prepare(`SELECT * FROM downloads WHERE deezer_id = ? AND status IN ('queued', 'downloading', 'saving')`).get(deezerId)
    // Wanted for playing now: it goes before a long "download all".
    if (existing) { if (item.play && existing.status === 'queued') db.prepare('UPDATE downloads SET created_at = 0 WHERE id = ?').run(existing.id); out.push(existing); continue }
    const row = {
      id: crypto.randomUUID(), deezer_id: deezerId,
      title: String(item.title || '').slice(0, 300), artist: String(item.artist || '').slice(0, 300),
      album: String(item.album || '').slice(0, 300), cover: typeof item.cover === 'string' && /^https:\/\//.test(item.cover) ? item.cover : null,
      duration: Number(item.duration) || null, status: 'queued', progress: 0, created_at: item.play ? 0 : now(), updated_at: now(),
    }
    db.prepare(`INSERT INTO downloads (id, deezer_id, title, artist, album, cover, duration, status, progress, created_at, updated_at)
      VALUES (@id, @deezer_id, @title, @artist, @album, @cover, @duration, @status, @progress, @created_at, @updated_at)`).run(row)
    out.push(row)
  }
  setImmediate(pump)
  return out
}

function cancel(id) {
  active.get(id)?.abort()
  const j = job(id)
  if (j && ['queued', 'downloading', 'saving'].includes(j.status)) update(id, { status: 'cancelled', message: null })
  return { ok: true }
}
function retry(id) {
  const j = job(id)
  if (j && ['error', 'cancelled'].includes(j.status)) { update(id, { status: 'queued', progress: 0, error: null, message: null }); setImmediate(pump) }
  return { ok: true }
}
function clearFinished() {
  getDB().prepare(`DELETE FROM downloads WHERE status IN ('done', 'cancelled', 'error')`).run()
  return { ok: true }
}

async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (active.size < CONCURRENCY) {
      const next = getDB().prepare(`SELECT * FROM downloads WHERE status = 'queued' ORDER BY created_at LIMIT 1`).get()
      if (!next) break
      const controller = new AbortController()
      active.set(next.id, controller)
      update(next.id, { status: 'downloading', progress: 0, message: null, error: null })
      run(next, controller.signal)
        .catch(error => {
          if (controller.signal.aborted) return
          const verify = error?.needsVerification ?? /VERIFY_REQUIRED|verification|captcha|session/i.test(error?.message || '')
          update(next.id, { status: 'error', error: String(error?.message || error).slice(0, 500), message: verify ? `verify:${error?.verifySource || ''}` : null })
        })
        .finally(() => { active.delete(next.id); setImmediate(pump) })
    }
  } finally { pumping = false }
}

const safeName = (s, fallback) => (String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120) || fallback)

/**
 * Creates `dir` one level at a time. Node 18's recursive mkdir can wait
 * forever on a folder it isn't allowed to create (an SD card, /proc): this
 * fails at once instead.
 */
async function makeDir(dir) {
  const parts = path.resolve(dir).split(path.sep)
  let current = parts[0] || path.sep
  for (const part of parts.slice(1)) {
    if (!part) continue
    current = path.join(current, part)
    try {
      const st = await fsp.stat(current)
      if (!st.isDirectory()) throw Object.assign(new Error(`${current} is not a folder`), { code: 'ENOTDIR' })
      continue
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try { await fsp.mkdir(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
}

/** Writes `source` into the first download folder that accepts it. */
async function saveInto(source, relative) {
  const errors = []
  for (const dir of downloadDirs(getSetting('download_dir'))) {
    let target = path.join(dir, relative)
    try {
      await makeDir(path.dirname(target))
      const ext = path.extname(target)
      for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, relative.slice(0, -ext.length) + ` (${n})` + ext)
      // A stream, not copyFile: no permission change on the new file (Android's
      // shared storage refuses it).
      await pipeline(fs.createReadStream(source), fs.createWriteStream(target, { flags: 'wx' }))
      if (getSetting('download_dir_used') !== dir) setSetting('download_dir_used', dir)
      return target
    } catch (error) {
      errors.push(`${dir}: ${error.code || error.message}`)
      try { if (fs.existsSync(target) && fs.statSync(target).size === 0) fs.unlinkSync(target) } catch {}
    }
  }
  throw new Error(`No folder accepted the file (${errors.join('; ')})`)
}

async function fetchBuffer(url, signal) {
  if (!url) return null
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch { return null }
}

let taglib = null
function tags() { if (taglib === null) { try { taglib = require('node-taglib-sharp') } catch { taglib = false } } return taglib || null }

/** Title, artists, album, numbers, year and cover, written into the file (best effort). */
function writeTags(file, meta, coverBytes) {
  const T = tags()
  if (!T) return false
  let f
  try {
    f = T.File.createFromPath(file)
    const tag = f.tag
    tag.title = meta.title
    tag.performers = meta.artists.length ? meta.artists : [meta.artist]
    tag.albumArtists = [meta.album_artist || meta.artist]
    if (meta.album) tag.album = meta.album
    if (meta.track_no) tag.track = meta.track_no
    if (meta.track_count) tag.trackCount = meta.track_count
    if (meta.disc_no) tag.disc = meta.disc_no
    if (meta.year) tag.year = meta.year
    if (meta.genre) tag.genres = [meta.genre]
    if (meta.isrc) { try { tag.isrc = meta.isrc } catch {} }
    if (coverBytes?.length) {
      const pic = T.Picture.fromData(T.ByteVector.fromByteArray(coverBytes))
      pic.type = T.PictureType.FrontCover
      pic.mimeType = 'image/jpeg'
      tag.pictures = [pic]
    }
    f.save()
    return true
  } catch (error) {
    console.warn('[download] tags:', error.message)
    return false
  } finally { try { f?.dispose() } catch {} }
}

/** One source's attempt: its id for the song, then the qualities in your order. */
async function fromSource(source, j, meta, signal, onProgress) {
  const id = source.id === 'deezer' ? `deezer:${j.deezer_id}` : await sources.findOn(source, meta)
  if (!id) throw new Error('introuvable')
  const wanted = getSetting('quality_tier') || 'cd'
  let lastError = null
  for (const quality of sources.qualityChoices(source, wanted)) {
    try {
      return await sources.service().download(source.key, id, { signal, quality, onProgress })
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
      // Only "this quality isn't there" is worth another quality.
      if (!/quality|not available|unavailable|format|bitrate|lossless|hi-?res/i.test(error?.message || '')) break
    }
  }
  throw lastError || new Error('download failed')
}

async function run(j, signal) {
  const chain = sources.downloadChain()
  if (!chain.length) throw new Error('NO_SOURCE')
  // Exactly that song's details from the catalogue.
  let info = null
  try { info = await deezer.trackInfo(j.deezer_id) } catch {}
  const contributors = Array.isArray(info?.contributors) ? info.contributors.map(c => c.name).filter(Boolean) : []
  const meta = {
    title: info?.title || j.title || 'Sans titre',
    artist: info?.artist?.name || j.artist || 'Artiste inconnu',
    artists: [...new Set(contributors.length ? contributors : [info?.artist?.name || j.artist].filter(Boolean))],
    album: info?.album?.title || j.album || '',
    album_artist: info?.artist?.name || j.artist,
    track_no: info?.track_position || null,
    disc_no: info?.disk_number || null,
    year: info?.release_date ? Number(String(info.release_date).slice(0, 4)) : null,
    isrc: info?.isrc || null,
    duration: Number(info?.duration || j.duration) || null,
    cover: info?.album?.cover_xl || j.cover,
  }
  let artifact = null
  let via = null
  const errors = []
  for (const source of chain) {
    if (errors.length) update(j.id, { message: `try:${source.name}`, progress: 0 })
    try {
      artifact = await fromSource(source, j, meta, signal, u => { if (!signal.aborted && typeof u?.percent === 'number') update(j.id, { progress: Math.max(0, Math.min(99, u.percent)) }) })
      via = source
      break
    } catch (error) {
      if (signal.aborted) throw error
      const verify = /VERIFY_REQUIRED|verification|captcha|session/i.test(error?.message || '') || error?.needsVerification
      errors.push({ source: source.name, id: source.id, message: String(error?.message || error).slice(0, 200), verify })
    }
  }
  if (!artifact) {
    const err = new Error(errors.map(e => `${e.source} : ${e.message}`).join(' · '))
    err.needsVerification = errors.length > 0 && errors.every(e => e.verify)
    err.verifySource = errors.find(e => e.verify)?.id || null
    throw err
  }
  try {
    signal.throwIfAborted()
    update(j.id, { status: 'saving', progress: 99 })
    // The file's real format, whatever its name says (an addon may write AAC
    // into "audio.flac"): tags and the saved name follow the content.
    let work = artifact.file
    const kind = sniff(work)
    if (kind && path.extname(work).toLowerCase() !== kind.ext) {
      const fixed = work.replace(/\.[^./\\]*$/, '') + '-real' + kind.ext
      await fsp.rename(work, fixed)
      work = fixed
    }
    writeTags(work, meta, await fetchBuffer(meta.cover, signal))
    const ext = path.extname(work).toLowerCase() || '.flac'
    const albumDir = safeName(meta.album || 'Singles', 'Singles')
    const name = `${meta.track_no ? String(meta.track_no).padStart(2, '0') + ' ' : ''}${safeName(meta.title, 'Titre')}${ext}`
    const saved = await saveInto(work, path.join(safeName(meta.album_artist, 'Artiste'), albumDir, name))
    const { id } = await library.indexFile(saved, { deezerId: j.deezer_id })
    update(j.id, { status: 'done', progress: 100, track_id: id, message: `via:${via.name}`, error: null })
    return id
  } finally {
    try { await artifact?.cleanup() } catch {}
  }
}

/** Downloads interrupted by a restart start again. */
function resume() {
  getDB().prepare(`UPDATE downloads SET status = 'queued', progress = 0 WHERE status IN ('downloading', 'saving')`).run()
  setImmediate(pump)
}

module.exports = { waitFor, makeDir, enqueue, list, cancel, retry, clearFinished, resume, pump, ownedTrack, saveInto, writeTags }
