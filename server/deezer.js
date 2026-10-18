'use strict'
// Deezer's public catalogue (no account): search, artists, albums, related
// artists, charts. Recommendations and search use it; the songs it returns are
// downloaded by the Deezer SpotiFLAC addon from their exact id.
// ECHO_DEEZER_API: a stand-in catalogue for the tests.
const API = process.env.ECHO_DEEZER_API || 'https://api.deezer.com'
const memo = new Map()
const TTL = 6 * 60 * 60 * 1000

let fetchImpl = (...args) => fetch(...args)
function setFetch(fn) { fetchImpl = fn; memo.clear() }

async function get(pathname, { timeoutMs = 10000, fresh = false } = {}) {
  const url = `${API}${pathname}`
  const hit = memo.get(url)
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`Deezer answered ${res.status}`)
    const value = await res.json()
    if (value?.error) throw new Error(value.error.message || 'Deezer error')
    if (memo.size > 3000) memo.clear()
    memo.set(url, { at: Date.now(), value })
    return value
  } finally { clearTimeout(timer) }
}

const list = r => (Array.isArray(r?.data) ? r.data : [])

function cover(album, size = 'xl') {
  return album?.[`cover_${size}`] || album?.cover_big || album?.cover_medium || album?.cover || null
}

/** A catalogue song, in the shape the app uses everywhere. */
function song(t, album = null) {
  const a = t.album || album || {}
  return {
    deezer_id: String(t.id),
    title: t.title_short || t.title || '',
    version: t.title_version || '',
    artist: t.artist?.name || '',
    artist_id: t.artist?.id ? String(t.artist.id) : null,
    album: a.title || '',
    album_id: a.id ? String(a.id) : null,
    cover: cover(a),
    cover_small: cover(a, 'medium'),
    duration: Number(t.duration) || null,
    explicit: !!t.explicit_lyrics,
    track_no: t.track_position || null,
    disc_no: t.disk_number || null,
    preview: t.preview || null,
  }
}

function artistOf(a) {
  return { id: String(a.id), name: a.name, picture: a.picture_xl || a.picture_big || a.picture_medium || null, fans: a.nb_fan || null }
}
function albumOf(a) {
  return { id: String(a.id), title: a.title, artist: a.artist?.name || '', cover: cover(a), year: a.release_date ? Number(String(a.release_date).slice(0, 4)) : null, release_date: a.release_date || null, type: a.record_type || null, tracks: a.nb_tracks || null }
}

async function search(q, { limit = 25 } = {}) {
  const query = encodeURIComponent(String(q || '').slice(0, 200))
  const [tracks, artists, albums] = await Promise.all([
    get(`/search/track?q=${query}&limit=${limit}`).catch(() => null),
    get(`/search/artist?q=${query}&limit=8`).catch(() => null),
    get(`/search/album?q=${query}&limit=12`).catch(() => null),
  ])
  if (!tracks && !artists && !albums) throw new Error('Deezer is unreachable')
  return { tracks: list(tracks).map(t => song(t)), artists: list(artists).map(artistOf), albums: list(albums).map(albumOf) }
}

async function album(id) {
  const a = await get(`/album/${encodeURIComponent(id)}`)
  const base = albumOf(a)
  return { ...base, label: a.label || null, tracks: list(a.tracks).map(t => song(t, a)) }
}

async function artist(id) {
  const [a, top, albums, related] = await Promise.all([
    get(`/artist/${encodeURIComponent(id)}`),
    get(`/artist/${encodeURIComponent(id)}/top?limit=20`).catch(() => null),
    get(`/artist/${encodeURIComponent(id)}/albums?limit=60`).catch(() => null),
    get(`/artist/${encodeURIComponent(id)}/related?limit=12`).catch(() => null),
  ])
  return { ...artistOf(a), top: list(top).map(t => song(t)), albums: list(albums).map(albumOf).sort((x, y) => (y.year || 0) - (x.year || 0)), related: list(related).map(artistOf) }
}

async function findArtist(name) {
  const r = await get(`/search/artist?q=${encodeURIComponent(name)}&limit=5`)
  const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  const wanted = norm(name)
  const found = list(r)
  return found.find(a => norm(a.name) === wanted) || (found[0] && norm(found[0].name).includes(wanted) ? found[0] : null)
}

const related = id => get(`/artist/${id}/related?limit=12`).then(list)
const topTracks = id => get(`/artist/${id}/top?limit=10`).then(list)
const chart = () => get('/chart/0/tracks?limit=50').then(list)
const trackInfo = id => get(`/track/${encodeURIComponent(id)}`)
/** An artist's releases, newest first. */
const artistAlbums = (id, opts) => get(`/artist/${encodeURIComponent(id)}/albums?limit=100`, opts).then(r => list(r).map(albumOf).sort((x, y) => String(y.release_date || '').localeCompare(String(x.release_date || ''))))
const artistInfo = id => get(`/artist/${encodeURIComponent(id)}`).then(artistOf)

module.exports = { artistAlbums, artistInfo, get, setFetch, search, album, artist, findArtist, related, topTracks, chart, song, artistOf, albumOf, trackInfo }
