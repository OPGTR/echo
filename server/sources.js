'use strict'
// Where Écho downloads from: Mornye (formerly SpotiFLAC) addons (engine adapted from Lokal,
// MIT). Écho's catalogue is Deezer's; a song is fetched from the first source
// in your order that has it: Deezer by its exact id, the others by matching
// title, artist and length (ISRC when the source gives it).
// Spotify has no download addon: its addon only reads playlist links.
const { getDB, getJSON, setSetting } = require('./db')
const packages = require('./spotiflac/packages')
const { dispatch } = require('./spotiflac/api')

const service = () => packages.service(getDB())

/** Download sources Écho offers, in their default order. */
const KNOWN = [
  { id: 'deezer', name: 'Deezer' },
  { id: 'tidal-web', name: 'Tidal' },
  { id: 'qobuz-web', name: 'Qobuz' },
  { id: 'ytmusic-spotiflac', name: 'YouTube Music' },
  { id: 'soundcloud', name: 'SoundCloud' },
  { id: 'amazon', name: 'Amazon Music' },
]
/** Addons that only read playlist links, for imports. */
const LINK_READERS = { spotify: 'spotify-web', ytmusic: 'ytmusic-spotiflac', deezer: 'deezer' }

function installed() {
  try { return service().list() } catch { return [] }
}

function order() {
  const saved = getJSON('source_order', null)
  const ids = KNOWN.map(k => k.id)
  const list = Array.isArray(saved) ? saved.filter(id => ids.includes(id)) : []
  return [...list, ...ids.filter(id => !list.includes(id))]
}

const ready = a => !!a && (a.access ? a.access.ready !== false : true)

/** Every known source: installed or not, enabled, ready, in your order. */
function sources() {
  const all = installed()
  return order().map(id => {
    const known = KNOWN.find(k => k.id === id)
    const a = all.find(x => x.id === id)
    return {
      id, name: known.name,
      installed: !!a, enabled: !!a?.enabled, ready: ready(a),
      key: a?.key || null, version: a?.version || null,
      access: a?.access || null, quality: a?.qualityOptions || [],
    }
  })
}

/** The sources a download may use, in order. */
function downloadChain() {
  return sources().filter(s => s.installed && s.enabled)
}

/** First source (compatibility with 0.0.1: "the source"). */
function downloadSource() {
  return downloadChain()[0] || null
}

/** The summary the app shows (0.0.1 shape, plus every source). */
function state() {
  const list = sources()
  const deezer = list.find(s => s.id === 'deezer')
  const first = list.find(s => s.installed && s.enabled) || deezer
  return {
    installed: list.some(s => s.installed && s.enabled),
    enabled: !!first?.enabled,
    key: first?.key || null,
    id: first?.id || null,
    version: first?.version || null,
    ready: !!first && first.installed && first.ready,
    access: first?.access || null,
    quality: first?.quality || null,
    sources: list,
  }
}

async function catalogueEntry(id) {
  const s = service()
  await s.refreshDue(0).catch(() => null)
  return s.catalogue().find(e => e.id === id) || null
}

/** Installs (or updates) an addon from Mornye’s catalogue (formerly SpotiFLAC). */
async function install(id = 'deezer') {
  const entry = await catalogueEntry(id)
  if (!entry) throw new Error(`« ${id} » n’est pas dans le catalogue Mornye pour l’instant`)
  if (!entry.installed || entry.updateAvailable) await service().install({ repositoryId: entry.repositoryId, id })
  return state()
}
const installDeezer = () => install('deezer')

function setEnabled(id, enabled) {
  const s = sources().find(x => x.id === id)
  if (!s?.key) throw new Error('not installed')
  service().setEnabled(s.key, !!enabled)
  return state()
}
function setOrder(ids) {
  if (Array.isArray(ids)) setSetting('source_order', JSON.stringify(ids.filter(id => KNOWN.some(k => k.id === id))))
  return state()
}

const keyOf = id => sources().find(s => s.id === (id || order()[0]))?.key
  || downloadSource()?.key

/**
 * Checks the sources that need a verification, quietly: a session that
 * expired (or that an addon update lost) is often given back without anyone
 * having to verify again. Run at start, then every few hours.
 */
async function autoVerify() {
  const out = []
  for (const s of sources().filter(x => x.installed && x.enabled && x.access?.kind === 'verification')) {
    try {
      const status = await dispatch(getDB(), { action: 'package.verifyAndWait', key: s.key })
      out.push({ id: s.id, ready: !!status?.authenticated })
    } catch (error) { out.push({ id: s.id, ready: false, error: error.message }) }
  }
  return out
}
let autoTimer = null
function startAutoVerify(every = 4 * 3600000) {
  if (autoTimer) return
  const run = () => autoVerify().then(r => { if (r.length) console.log('[sources] auto-check', JSON.stringify(r)) }).catch(() => {})
  setTimeout(run, 3000)
  autoTimer = setInterval(run, every)
  autoTimer.unref?.()
}

/** What the phone's verification window needs (page, callback, allowed domains). */
async function verifyInfo(id) {
  const key = keyOf(id)
  if (!key) throw new Error('NO_SOURCE')
  return dispatch(getDB(), { action: 'package.authInfo', key })
}
async function verifyComplete({ id, url, cookies } = {}) {
  const key = keyOf(id)
  if (!key) throw new Error('NO_SOURCE')
  return dispatch(getDB(), { action: 'package.authComplete', key, url: url || null, cookies: Array.isArray(cookies) ? cookies : [] })
}

// ------------------------------------------------------------- qualities
// Your preference, and what to try when a source doesn't have it: one step
// lower first, then one step higher.
const TIERS = ['hires', 'cd', 'lossy']
const FALLBACK = { hires: ['hires', 'cd', 'lossy'], cd: ['cd', 'lossy', 'hires'], lossy: ['lossy', 'cd', 'hires'] }
function tierOf(option) {
  const text = `${option.id} ${option.label || ''} ${option.description || ''}`.toLowerCase()
  if (/24[ -]?bit|hi-?res|hires|max|192|96 ?k|studio/.test(text)) return 'hires'
  if (/flac|lossless|16[ -]?bit|cd|44\.?1/.test(text)) return 'cd'
  return 'lossy'
}
/** The addon's quality option ids, best match for `wanted` first. */
function qualityChoices(source, wanted = 'cd') {
  const options = source.quality || []
  if (!options.length) return [undefined]
  const out = []
  for (const tier of FALLBACK[wanted] || FALLBACK.cd) for (const o of options) if (tierOf(o) === tier && !out.includes(o.id)) out.push(o.id)
  return out.length ? out : [options[0].id]
}

// --------------------------------------------------------------- matching
const norm = v => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\s*[([].*?(feat|ft|with|remaster|version|edit|mono|stereo)[^)\]]*[)\]]/g, '')
  .replace(/[^a-z0-9Ѐ-ӿ֐-׿؀-ۿ぀-ヿ一-鿿]+/g, ' ').trim()

/** The source's id for this song, or null. */
async function findOn(source, meta) {
  const results = await service().search(source.key, `${meta.artist} ${meta.title}`, { limit: 10 })
  let best = null, bestScore = 0
  for (const r of results || []) {
    let score = 0
    if (meta.isrc && r.isrc && String(r.isrc).toUpperCase() === String(meta.isrc).toUpperCase()) score += 10
    if (norm(r.title) === norm(meta.title)) score += 4
    else if (norm(r.title).includes(norm(meta.title)) || norm(meta.title).includes(norm(r.title))) score += 2
    const artists = norm(r.artist)
    if (artists && norm(meta.artist).split(' ').filter(Boolean).every(w => artists.includes(w))) score += 3
    if (meta.duration && r.duration) score += Math.abs(r.duration - meta.duration) <= 3 ? 2 : Math.abs(r.duration - meta.duration) > 15 ? -6 : 0
    if (score > bestScore) { best = r; bestScore = score }
  }
  return bestScore >= 6 ? best.id : null
}

/** Reads a playlist link with the addon that knows it (installed on the way). */
async function readLink(kind, url) {
  const id = LINK_READERS[kind]
  if (!id) throw new Error('unknown service')
  let addon = installed().find(a => a.id === id)
  if (!addon) { await install(id); addon = installed().find(a => a.id === id) }
  if (!addon) throw new Error('addon not installed')
  return service().search(addon.key, url, { limit: 2000 })
}

module.exports = {
  service, KNOWN, sources, downloadChain, downloadSource, state, install, installDeezer,
  autoVerify, startAutoVerify, setEnabled, setOrder, verifyInfo, verifyComplete, qualityChoices, tierOf, TIERS, findOn, readLink, list: installed,
}
