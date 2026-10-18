'use strict'
// Playlists: yours (made in Écho, or imported from Spotify, YouTube Music or
// Deezer) and the mixes you keep. A song in a playlist is either yours
// (local_id) or from the catalogue (deezer_id, downloaded when played).
const crypto = require('crypto')
const { getDB } = require('./db')
const deezer = require('./deezer')
const sources = require('./sources')

const now = () => Date.now()
const SORTS = new Set(['custom', 'title', 'artist', 'added', 'played', 'duration'])

function row(id) {
  return getDB().prepare('SELECT * FROM playlists WHERE id = ?').get(id)
}
function notFound() { return Object.assign(new Error('not found'), { status: 404 }) }

/** Songs of a playlist with what the library knows (yours, art, plays). */
function itemsOf(pl) {
  const db = getDB()
  const items = db.prepare(`
    SELECT i.id AS item_id, i.pos, i.local_id AS item_local, i.deezer_id, i.title, i.artist, i.album, i.cover, i.duration, i.added_at,
           t.id AS lid, t.art IS NOT NULL AS has_art, t.play_count
      FROM playlist_items i
      LEFT JOIN tracks t ON t.id = i.local_id OR (i.local_id IS NULL AND i.deezer_id IS NOT NULL AND t.deezer_id = i.deezer_id)
     WHERE i.playlist_id = ?`).all(pl.id)
  const seen = new Set()
  const songs = []
  for (const r of items) {
    if (seen.has(r.item_id)) continue
    seen.add(r.item_id)
    songs.push({
      item_id: r.item_id, pos: r.pos, local_id: r.lid || null, deezer_id: r.deezer_id || null,
      title: r.title, artist: r.artist || '', album: r.album || '', cover: r.cover || null, duration: r.duration || null,
      has_art: r.has_art ? 1 : 0, play_count: r.play_count || 0, added_at: r.added_at,
    })
  }
  const dir = pl.sort_dir === 'desc' ? -1 : 1
  const text = (a, b) => String(a || '').localeCompare(String(b || ''), 'fr', { sensitivity: 'base' })
  const by = {
    custom: (a, b) => a.pos - b.pos,
    title: (a, b) => text(a.title, b.title),
    artist: (a, b) => text(a.artist, b.artist) || text(a.title, b.title),
    added: (a, b) => a.added_at - b.added_at,
    played: (a, b) => a.play_count - b.play_count,
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
  }[pl.sort] || ((a, b) => a.pos - b.pos)
  return songs.sort((a, b) => by(a, b) * dir || a.pos - b.pos)
}

function view(pl, withItems = false) {
  const db = getDB()
  const stats = db.prepare('SELECT COUNT(*) AS n, SUM(duration) AS secs FROM playlist_items WHERE playlist_id = ?').get(pl.id)
  const covers = db.prepare(`SELECT i.cover, t.id AS lid, t.art IS NOT NULL AS has_art FROM playlist_items i LEFT JOIN tracks t ON t.id = i.local_id WHERE i.playlist_id = ? ORDER BY i.pos LIMIT 12`).all(pl.id)
    .map(r => r.cover || (r.lid && r.has_art ? `local:${r.lid}` : null)).filter(Boolean)
  let meta = null
  try { meta = pl.meta ? JSON.parse(pl.meta) : null } catch {}
  const out = {
    id: pl.id, name: pl.name, kind: pl.kind, source: pl.source, source_url: pl.source_url,
    sort: pl.sort, sort_dir: pl.sort_dir, meta,
    count: stats.n || 0, duration: Math.round(stats.secs || 0),
    covers: [...new Set(covers)].slice(0, 4),
    created_at: pl.created_at, updated_at: pl.updated_at,
  }
  if (withItems) out.tracks = itemsOf(pl)
  return out
}

function list() {
  return getDB().prepare('SELECT * FROM playlists ORDER BY position, created_at DESC').all().map(p => view(p))
}
function get(id) { const pl = row(id); if (!pl) throw notFound(); return view(pl, true) }

function create({ name, kind = 'user', source = null, source_url = null, meta = null } = {}) {
  const id = crypto.randomUUID()
  const clean = String(name || '').trim().slice(0, 120) || 'Nouvelle playlist'
  const db = getDB()
  db.prepare('UPDATE playlists SET position = position + 1').run()
  db.prepare('INSERT INTO playlists (id, name, kind, source, source_url, meta, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, clean, kind, source, source_url, meta ? JSON.stringify(meta) : null, now(), now())
  return view(row(id))
}

function update(id, body = {}) {
  const pl = row(id)
  if (!pl) throw notFound()
  const db = getDB()
  if (typeof body.name === 'string' && body.name.trim()) db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(body.name.trim().slice(0, 120), now(), id)
  if (SORTS.has(body.sort)) db.prepare('UPDATE playlists SET sort = ?, updated_at = ? WHERE id = ?').run(body.sort, now(), id)
  if (body.sort_dir === 'asc' || body.sort_dir === 'desc') db.prepare('UPDATE playlists SET sort_dir = ? WHERE id = ?').run(body.sort_dir, id)
  return get(id)
}

function remove(id) {
  getDB().prepare('DELETE FROM playlists WHERE id = ?').run(id)
  return { ok: true }
}

/** Puts the playlists in this order (ids). */
function arrange(ids) {
  const db = getDB()
  db.transaction(() => (ids || []).forEach((id, i) => db.prepare('UPDATE playlists SET position = ? WHERE id = ?').run(i, id)))()
  return list()
}

const clean = s => ({
  local_id: s.local_id || null,
  deezer_id: s.deezer_id ? String(s.deezer_id).replace(/^deezer:/, '') : null,
  title: String(s.title || '').slice(0, 300) || 'Sans titre',
  artist: String(s.artist || '').slice(0, 300),
  album: String(s.album || '').slice(0, 300),
  cover: typeof s.cover === 'string' && /^https:\/\//.test(s.cover) ? s.cover : null,
  duration: Number(s.duration) || null,
})

function addItems(id, songs = []) {
  const pl = row(id)
  if (!pl) throw notFound()
  const db = getDB()
  const max = db.prepare('SELECT MAX(pos) AS m FROM playlist_items WHERE playlist_id = ?').get(id).m || 0
  const insert = db.prepare('INSERT INTO playlist_items (playlist_id, pos, local_id, deezer_id, title, artist, album, cover, duration, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  db.transaction(() => songs.filter(s => s && (s.local_id || s.deezer_id)).slice(0, 5000).forEach((s, i) => {
    const c = clean(s)
    insert.run(id, max + i + 1, c.local_id, c.deezer_id, c.title, c.artist, c.album, c.cover, c.duration, now())
  }))()
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), id)
  return get(id)
}

function removeItem(id, itemId) {
  getDB().prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?').run(id, itemId)
  return get(id)
}

/** Custom order: the items' ids, in their new order. */
function reorder(id, itemIds = []) {
  const db = getDB()
  db.transaction(() => itemIds.forEach((itemId, i) => db.prepare('UPDATE playlist_items SET pos = ? WHERE playlist_id = ? AND id = ?').run(i + 1, id, itemId)))()
  db.prepare("UPDATE playlists SET sort = 'custom', sort_dir = 'asc', updated_at = ? WHERE id = ?").run(now(), id)
  return get(id)
}

// ---------------------------------------------------------------- import
/** Which service a link belongs to. */
function serviceOf(url) {
  const u = String(url || '')
  if (/open\.spotify\.com|spotify:/.test(u)) return 'spotify'
  if (/music\.youtube\.com|youtube\.com\/playlist|youtu\.be/.test(u)) return 'ytmusic'
  if (/deezer\.com|deezer\.page\.link|dzr\.page\.link/.test(u)) return 'deezer'
  return null
}

/** A Deezer link: the public API reads it directly. */
async function readDeezer(url) {
  let target = url
  if (/page\.link/.test(url)) {
    try { const res = await fetch(url, { redirect: 'follow' }); target = res.url } catch {}
  }
  const m = /playlist\/(\d+)/.exec(target)
  if (!m) throw new Error('lien Deezer non reconnu')
  const head = await deezer.get(`/playlist/${m[1]}`)
  let tracks = Array.isArray(head?.tracks?.data) ? head.tracks.data : []
  let next = head?.tracks?.next
  while (next && tracks.length < 2000) {
    const page = await deezer.get(next.replace(/^https?:\/\/[^/]+/, ''))
    tracks = tracks.concat(page?.data || [])
    next = page?.next
  }
  return { name: head?.title || 'Playlist Deezer', songs: tracks.map(t => deezer.song(t)) }
}

/** Another service's songs, found in the catalogue (ISRC first, then by search). */
async function matchAll(found) {
  const out = []
  const missing = []
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < found.length) {
      const i = next++
      const t = found[i]
      let song = null
      if (t.isrc) { try { const r = await deezer.get(`/track/isrc:${encodeURIComponent(t.isrc)}`); if (r?.id) song = deezer.song(r) } catch {} }
      if (!song) {
        try {
          const r = await deezer.search(`${t.artist} ${t.title}`, { limit: 5 })
          const norm = v => String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
          song = r.tracks.find(x => norm(x.title) === norm(t.title)) || r.tracks.find(x => norm(t.title).includes(norm(x.title)) && norm(x.artist).includes(norm(t.artist).split(' ')[0])) || null
        } catch {}
      }
      if (song) out[i] = song
      else missing.push({ title: t.title, artist: t.artist })
    }
  }))
  return { songs: out.filter(Boolean), missing }
}

async function importLink(url, { name } = {}) {
  const kind = serviceOf(url)
  if (!kind) throw Object.assign(new Error('Ce lien n’est pas un lien de playlist Spotify, YouTube Music ou Deezer.'), { status: 400 })
  let title = name || null
  let songs = []
  let missing = []
  if (kind === 'deezer') {
    const r = await readDeezer(url)
    title = title || r.name
    songs = r.songs
  } else {
    const found = await sources.readLink(kind, url)
    const r = await matchAll(found)
    songs = r.songs
    missing = r.missing
  }
  if (!songs.length) throw new Error('Aucun titre trouvé dans cette playlist.')
  const label = { spotify: 'Spotify', ytmusic: 'YouTube Music', deezer: 'Deezer' }[kind]
  const pl = create({ name: title || `Playlist ${label}`, source: kind, source_url: url, meta: { missing: missing.slice(0, 200), found: songs.length } })
  return addItems(pl.id, songs)
}

module.exports = { list, get, create, update, remove, arrange, addItems, removeItem, reorder, importLink, serviceOf, view }
