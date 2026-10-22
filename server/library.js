'use strict'
// The music on the phone: folders are walked, each audio file's tags read
// (music-metadata) and its cover saved once per album. A rescan only reads
// files that are new or changed (size and date), and forgets removed ones.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { getDB, getJSON, setSetting } = require('./db')
const { dataDir } = require('./paths')

const AUDIO = /\.(mp3|flac|m4a|mp4|aac|ogg|oga|opus|wav|aiff?|wma|ape|wv)$/i
const SKIP_DIRS = /^(\.|Android$|Notifications$|Ringtones$|Alarms$)/
const MAX_DEPTH = 12

const status = { scanning: false, total: 0, done: 0, added: 0, removed: 0, errors: 0, finishedAt: null }

const idOf = (file) => 't' + crypto.createHash('sha1').update(file).digest('hex').slice(0, 16)
const artDir = () => { const d = path.join(dataDir(), 'art'); fs.mkdirSync(d, { recursive: true }); return d }

function folders() {
  const list = getJSON('music_folders', [])
  return Array.isArray(list) ? list.filter(f => typeof f === 'string' && f) : []
}
function setFolders(list) {
  const clean = [...new Set((list || []).filter(f => typeof f === 'string' && path.isAbsolute(f)).map(f => path.resolve(f)))]
  setSetting('music_folders', JSON.stringify(clean))
  return clean
}

async function walk(dir, out, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return
  let real
  try { real = await fsp.realpath(dir) } catch { return }
  if (seen.has(real)) return
  seen.add(real)
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  // A folder with ".nomedia" is one Android itself leaves out (WhatsApp voice notes, …).
  if (depth > 0 && entries.some(e => e.name === '.nomedia')) return
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) await walk(full, out, depth + 1, seen) }
    else if (AUDIO.test(e.name)) out.push(full)
  }
}

let mm = null
function metadata() { if (!mm) mm = require('music-metadata'); return mm }

function first(value) { return Array.isArray(value) ? value[0] : value }
function cleanText(value) { return String(value ?? '').replace(/\u0000/g, '').trim() }

/** The song's details from its tags, with the folder names as fallback. */
async function readFile(file) {
  const meta = await metadata().parseFile(file, { duration: true, skipCovers: false })
  const c = meta.common || {}, f = meta.format || {}
  const base = path.basename(file).replace(/\.[^.]+$/, '')
  const parent = path.basename(path.dirname(file))
  const grand = path.basename(path.dirname(path.dirname(file)))
  // "01 Title" / "Artist - Title" file names when the tags are empty.
  let fallbackTitle = base.replace(/^\d{1,3}[\s._-]+/, '')
  let fallbackArtist = grand && grand !== '.' ? grand : parent
  const dash = fallbackTitle.match(/^(.+?)\s+-\s+(.+)$/)
  if (dash && !c.artist) { fallbackArtist = dash[1]; fallbackTitle = dash[2] }
  const picture = (c.picture || []).find(p => /front/i.test(p.type || '')) || (c.picture || [])[0]
  return {
    title: cleanText(c.title) || fallbackTitle,
    artist: cleanText(c.artist) || cleanText(c.albumartist) || fallbackArtist || 'Artiste inconnu',
    album: cleanText(c.album) || null,
    album_artist: cleanText(c.albumartist) || null,
    track_no: c.track?.no || null,
    disc_no: c.disk?.no || null,
    year: c.year || null,
    genre: cleanText(first(c.genre)) || null,
    duration: f.duration || null,
    codec: String(f.codec || f.container || '').toLowerCase() || null,
    lossless: f.lossless ? 1 : 0,
    bitrate: f.bitrate ? Math.round(f.bitrate) : null,
    sample_rate: f.sampleRate || null,
    bits: f.bitsPerSample || null,
    picture,
  }
}

/** The cover once per album (or per file without an album), as a JPEG/PNG file. */
async function saveArt(info, file) {
  const pic = info.picture
  if (!pic?.data?.length) return findFolderArt(file)
  const key = crypto.createHash('sha1').update(info.album ? `${info.album_artist || info.artist}\u0000${info.album}` : file).digest('hex').slice(0, 20)
  const ext = /png/i.test(pic.format || '') ? 'png' : 'jpg'
  const out = path.join(artDir(), `${key}.${ext}`)
  if (!fs.existsSync(out)) await fsp.writeFile(out, Buffer.from(pic.data))
  return out
}

/** cover.jpg / folder.jpg next to the song. */
function findFolderArt(file) {
  const dir = path.dirname(file)
  for (const name of ['cover.jpg', 'folder.jpg', 'cover.png', 'folder.png', 'front.jpg', 'Cover.jpg', 'Folder.jpg', 'AlbumArt.jpg']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** Reads one file into the library (new or changed). Returns the track id. */
async function indexFile(file, { deezerId = null, stat = null } = {}) {
  const db = getDB()
  stat = stat || await fsp.stat(file)
  const info = await readFile(file)
  const art = await saveArt(info, file).catch(() => null)
  const id = idOf(file)
  const existing = db.prepare('SELECT id, added_at, liked, play_count, last_played, deezer_id FROM tracks WHERE path = ?').get(file)
  const row = {
    id, path: file, size: stat.size, mtime: Math.round(stat.mtimeMs),
    title: info.title, artist: info.artist, album: info.album, album_artist: info.album_artist,
    track_no: info.track_no, disc_no: info.disc_no, year: info.year, genre: info.genre,
    duration: info.duration, codec: info.codec, lossless: info.lossless, bitrate: info.bitrate,
    sample_rate: info.sample_rate, bits: info.bits, art,
    deezer_id: deezerId || existing?.deezer_id || null,
    liked: existing?.liked || 0, play_count: existing?.play_count || 0, last_played: existing?.last_played || null,
    added_at: existing?.added_at || Date.now(),
  }
  db.prepare(`INSERT INTO tracks (id, path, size, mtime, title, artist, album, album_artist, track_no, disc_no, year, genre, duration, codec, lossless, bitrate, sample_rate, bits, art, deezer_id, liked, play_count, last_played, added_at)
    VALUES (@id, @path, @size, @mtime, @title, @artist, @album, @album_artist, @track_no, @disc_no, @year, @genre, @duration, @codec, @lossless, @bitrate, @sample_rate, @bits, @art, @deezer_id, @liked, @play_count, @last_played, @added_at)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, title = excluded.title, artist = excluded.artist, album = excluded.album,
      album_artist = excluded.album_artist, track_no = excluded.track_no, disc_no = excluded.disc_no, year = excluded.year, genre = excluded.genre,
      duration = excluded.duration, codec = excluded.codec, lossless = excluded.lossless, bitrate = excluded.bitrate, sample_rate = excluded.sample_rate,
      bits = excluded.bits, art = excluded.art, deezer_id = excluded.deezer_id`).run(row)
  return { id, isNew: !existing }
}

let running = null
let again = null
/**
 * Scans the music folders (and the download folder). Resolves with the
 * status. Asked during a scan: one more scan follows it (the folders may
 * have just changed).
 */
function scan({ extraFolders = [] } = {}) {
  if (running) {
    if (!again) again = running.catch(() => {}).then(() => { again = null; return scan({ extraFolders }) })
    return again
  }
  const current = (async () => {
    // Never finish synchronously: `running` must be set before the end clears it.
    await null
    const db = getDB()
    Object.assign(status, { scanning: true, total: 0, done: 0, added: 0, removed: 0, errors: 0 })
    try {
      const roots = [...new Set([...folders(), ...extraFolders].filter(f => { try { return fs.statSync(f).isDirectory() } catch { return false } }))]
      const files = []
      for (const root of roots) await walk(root, files)
      status.total = files.length
      const known = new Map(db.prepare('SELECT path, size, mtime FROM tracks').all().map(r => [r.path, r]))
      const present = new Set()
      for (const file of files) {
        present.add(file)
        try {
          const stat = await fsp.stat(file)
          const k = known.get(file)
          if (!k || k.size !== stat.size || k.mtime !== Math.round(stat.mtimeMs)) {
            const { isNew } = await indexFile(file, { stat })
            if (isNew) status.added++
          }
        } catch (error) {
          status.errors++
          if (status.errors <= 5) console.warn('[scan]', file, error.message)
        }
        status.done++
        // Let the server answer requests during a long scan.
        if (status.done % 25 === 0) await new Promise(r => setImmediate(r))
      }
      // Songs whose file is gone (only inside folders that were scanned).
      const inScanned = p => roots.some(r => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep))
      for (const r of known.keys()) {
        if (!present.has(r) && inScanned(r) && !fs.existsSync(r)) {
          db.prepare('DELETE FROM tracks WHERE path = ?').run(r)
          status.removed++
        }
      }
    } finally {
      status.scanning = false
      status.finishedAt = Date.now()
      if (running === current) running = null
    }
    return { ...status }
  })()
  running = current
  return current
}

// ------------------------------------------------------------------ queries
const TRACK_FIELDS = 'id, title, artist, album, album_artist, track_no, disc_no, year, genre, duration, codec, lossless, bits, sample_rate, art IS NOT NULL AS has_art, deezer_id, liked, play_count, last_played, added_at'
const SORTS = {
  added: 'added_at DESC',
  title: 'title COLLATE NOCASE ASC',
  artist: 'artist COLLATE NOCASE ASC, album COLLATE NOCASE, disc_no, track_no',
  played: 'play_count DESC, last_played DESC',
  recent: 'last_played DESC',
  // Best first: hi-res, then the other lossless files, then the rest.
  quality: '(bits > 16 OR sample_rate > 48000) DESC, lossless DESC, bits DESC, sample_rate DESC, added_at DESC',
}

function words(q) { return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6) }
function like(text) { return `%${String(text).replace(/[\\%_]/g, c => '\\' + c)}%` }

function tracks({ sort = 'added', q = '', liked = false, limit = 500, offset = 0 } = {}) {
  const where = []
  const params = []
  for (const w of words(q)) { where.push(`(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\')`); params.push(like(w), like(w), like(w)) }
  if (liked) where.push('liked = 1')
  if (sort === 'recent') where.push('last_played IS NOT NULL')
  const sql = `SELECT ${TRACK_FIELDS} FROM tracks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${SORTS[sort] || SORTS.added} LIMIT ? OFFSET ?`
  return getDB().prepare(sql).all(...params, Math.min(Number(limit) || 500, 5000), Number(offset) || 0)
}

function albums({ q = '' } = {}) {
  const params = []
  let where = 'album IS NOT NULL'
  for (const w of words(q)) { where += ` AND (album LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album_artist LIKE ? ESCAPE '\\')`; params.push(like(w), like(w), like(w)) }
  return getDB().prepare(`SELECT album, COALESCE(album_artist, artist) AS artist, MIN(year) AS year, COUNT(*) AS count,
      MAX(added_at) AS added_at, (SELECT id FROM tracks t2 WHERE t2.album = t.album AND COALESCE(t2.album_artist, t2.artist) = COALESCE(t.album_artist, t.artist) AND t2.art IS NOT NULL LIMIT 1) AS art_id
    FROM tracks t WHERE ${where} GROUP BY album COLLATE NOCASE, COALESCE(album_artist, artist) COLLATE NOCASE ORDER BY MAX(added_at) DESC`).all(...params)
}

function albumTracks(album, artist) {
  return getDB().prepare(`SELECT ${TRACK_FIELDS} FROM tracks WHERE album = ? AND COALESCE(album_artist, artist) = ? ORDER BY disc_no, track_no, title COLLATE NOCASE`).all(album, artist)
}

/** "Daft Punk feat. Pharrell Williams" -> "Daft Punk". */
const mainArtist = a => String(a || '').split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s*[,;&\/]\s*|\s+x\s+/i)[0].trim() || String(a || '')

function artists({ q = '' } = {}) {
  const params = []
  let where = '1 = 1'
  for (const w of words(q)) { where += ` AND artist LIKE ? ESCAPE '\\'`; params.push(like(w)) }
  const rows = getDB().prepare(`SELECT COALESCE(album_artist, artist) AS name, COUNT(*) AS count, SUM(play_count) AS plays,
      MAX(CASE WHEN art IS NOT NULL THEN id END) AS art_id
    FROM tracks WHERE ${where} GROUP BY COALESCE(album_artist, artist)`).all(...params)
  // One entry per main artist (their "feat." songs included).
  const merged = new Map()
  for (const r of rows) {
    const name = mainArtist(r.name)
    const key = name.toLowerCase()
    const e = merged.get(key) || { name, count: 0, plays: 0, art_id: null }
    e.count += r.count; e.plays += r.plays || 0; e.art_id = e.art_id || r.art_id
    merged.set(key, e)
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
}

function artistTracks(name) {
  const rows = getDB().prepare(`SELECT ${TRACK_FIELDS} FROM tracks WHERE COALESCE(album_artist, artist) LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' ORDER BY play_count DESC, album, disc_no, track_no`).all(like(name), like(name))
  // Only songs where they're a credited artist (not "Daft Punkers" for "Daft Punk").
  const wanted = String(name).toLowerCase()
  const credited = t => [t.album_artist, t.artist].some(a => String(a || '').toLowerCase().split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s*[,;&\/]\s*|\s+x\s+/i).map(x => x.trim()).includes(wanted))
  return rows.filter(credited)
}

function track(id) { return getDB().prepare(`SELECT ${TRACK_FIELDS}, path, art FROM tracks WHERE id = ?`).get(id) }

function setLiked(id, liked) { getDB().prepare('UPDATE tracks SET liked = ? WHERE id = ?').run(liked ? 1 : 0, id); return !!liked }

/** A listen: counted once it lasted 30 s or half the song. */
function recordPlay(id, seconds) {
  const t = track(id)
  if (!t) return false
  const secs = Math.max(0, Math.round(Number(seconds) || 0))
  if (secs < 10) return false
  const db = getDB()
  db.prepare('INSERT INTO plays (track_id, artist, title, seconds, played_at) VALUES (?, ?, ?, ?, ?)').run(id, t.artist, t.title, secs, Date.now())
  if (secs >= 30 || (t.duration && secs >= t.duration / 2)) db.prepare('UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?').run(Date.now(), id)
  return true
}

function stats() {
  const db = getDB()
  return db.prepare('SELECT COUNT(*) AS tracks, COUNT(DISTINCT COALESCE(album_artist, artist)) AS artists, COUNT(DISTINCT album) AS albums, SUM(liked) AS liked FROM tracks').get()
}

module.exports = { mainArtist, status, folders, setFolders, scan, indexFile, tracks, albums, albumTracks, artists, artistTracks, track, setLiked, recordPlay, stats, idOf, AUDIO }
