'use strict'
// Écho in the car (Android Auto): what the car screen lists and what a touch
// plays. Android Auto draws the screens itself; the phone's player service
// (PlaybackService) asks here for the content: the tabs (Pour toi,
// Playlists, Bibliothèque), the collections in them, their songs, a search,
// and, when something is picked, the queue with addresses its player can
// play by itself (the app may be asleep, or not started at all).
//
// Ids are paths: "home", "pl/<id>", "mix/<id>", "alb/<album>/<artist>"…
// Inside a collection: "play|<node>", "shuf|<node>" and "s|<node>|<index>".
const { getJSON, setSetting } = require('./db')
const library = require('./library')
const playlists = require('./playlists')
const follows = require('./follows')
const sources = require('./sources')
const deezer = require('./deezer')
const { forYou, artistMix } = require('./foryou')
const PRESETS = require('../app/src/eq-presets.json')
// Songs from the catalogue you already have get their library id (set by routes()).
let markOwned = songs => songs

const AUTHORITY = process.env.ECHO_ART_AUTHORITY || 'com.opgtr.echo.art'
const MAX_SONGS = 300 // what one collection lists, and what the player gets at once
const enc = encodeURIComponent
const dec = s => { try { return decodeURIComponent(s) } catch { return '' } }

// ------------------------------------------------------------------ art
// Covers become content:// addresses served by the phone's ArtProvider
// (Android Auto can't fetch web addresses): a library song's own art, a
// cover on the web, a mix's rings, a playlist's 4 covers, Écho's icons.
const b64 = s => Buffer.from(String(s)).toString('base64url')
const refOf = cover => {
  if (!cover) return null
  const c = String(cover)
  if (c.startsWith('local:')) return `t:${c.slice(6)}`
  if (/^https?:\/\//.test(c)) return `u:${b64(c)}`
  return null
}
const songRef = s => (s?.local_id && s.has_art !== 0 && s.has_art !== false ? `t:${s.local_id}` : refOf(s?.cover))
const art = {
  ref: r => (r ? `content://${AUTHORITY}/${r.replace(':', '/')}` : null),
  song: s => art.ref(songRef(s)),
  rings: (seed, label, center) => `content://${AUTHORITY}/r?${new URLSearchParams({ s: seed || '', l: label || '', ...(center ? { c: center } : {}) })}`,
  mosaic: refs => {
    const list = refs.filter(Boolean)
    if (!list.length) return art.icon('list')
    if (list.length < 4) return art.ref(list[0])
    return `content://${AUTHORITY}/m?c=${enc(list.slice(0, 4).join(','))}`
  },
  icon: name => `content://${AUTHORITY}/i/${name}`,
}

// ------------------------------------------------------------- helpers
const prefs = () => getJSON('prefs', {})
const shown = key => (prefs().sections || {})[key] !== false
const titles = n => (n <= 1 ? `${n} titre` : `${n} titres`)
const fromLibrary = r => ({ local_id: r.id, deezer_id: r.deezer_id || null, title: r.title, artist: r.artist, album: r.album || '', duration: r.duration || 0, cover: null, has_art: r.has_art })
/** The same song lists as the app's screens show. */
const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms).unref?.())])

/** Mix titles as on the phone (Home.jsx). */
const mixTitle = m => (m.kind === 'daily' ? `Mix du jour ${m.index}` : m.kind === 'discover' ? 'Découvertes' : m.kind === 'rediscover' ? 'À redécouvrir' : m.kind === 'artist' ? `Mix ${m.seed}` : 'Populaire en ce moment')
const mixWho = m => (m.kind === 'rediscover' ? 'Tes anciens favoris' : m.kind === 'discover' ? 'Des artistes que tu n’as pas encore' : (m.artists || []).slice(0, 3).join(', '))
const mixCenter = m => m.picture || (m.covers || []).find(c => c && !String(c).startsWith('local:')) || m.tracks?.find(x => x.cover)?.cover || null
const mixLabel = m => (m.kind === 'daily' || m.kind === 'artist' ? m.seed || '' : m.kind === 'rediscover' ? 'À redécouvrir' : '')
const mixShown = m => (m.kind === 'daily' ? shown('daily') : m.kind === 'discover' ? shown('discover') : m.kind === 'rediscover' ? shown('rediscover') : shown('chart'))

async function mixesOfDay() {
  const r = await withTimeout(forYou().catch(() => null), 9000, null)
  return (r?.mixes || []).filter(mixShown)
}

/** A playlist's picture: rings for a mix, else its covers (4 in a square). */
function playlistArt(pl) {
  if (pl.kind === 'mix' && !pl.custom_cover) return art.rings(pl.id, pl.meta?.artist?.name || '', refOf(pl.meta?.artist?.picture || (pl.covers || []).find(c => c && !String(c).startsWith('local:'))))
  return art.mosaic((pl.covers || []).map(refOf))
}

// ------------------------------------------------------------- nodes
const folder = (id, title, extra = {}) => ({ id, title, browsable: true, playable: false, ...extra })

/** Where a song stands: on the phone, or to download (and whether a source can). */
function sourceState() {
  try {
    const s = sources.state()
    const usable = (s.sources || []).filter(x => x.installed && x.enabled)
    return { installed: usable.length > 0, ready: usable.some(x => x.ready) }
  } catch { return { installed: false, ready: false } }
}

function songNode(node, i, s, source) {
  const local = !!s.local_id
  let subtitle = s.artist || ''
  if (!local && source.installed && !source.ready) subtitle = `${subtitle} · À vérifier sur ton téléphone`
  return {
    id: `s|${node}|${i}`, title: s.title || '', subtitle, album: s.album || '', art: art.song(s),
    playable: true, browsable: false, downloaded: local, duration: s.duration || 0,
  }
}

/** The rows of a collection: Lire, Aléatoire, then its songs. */
function collectionRows(node, songs, sub) {
  const source = sourceState()
  const list = songs.slice(0, MAX_SONGS)
  if (!list.length) return [{ id: `empty|${node}`, title: 'Aucun titre pour l’instant', subtitle: 'Ajoute des titres depuis ton téléphone', playable: false, browsable: false, art: art.icon('list') }]
  return [
    { id: `play|${node}`, title: 'Lire', subtitle: sub || titles(songs.length), art: art.icon('play'), playable: true, browsable: false, action: true },
    { id: `shuf|${node}`, title: 'Aléatoire', subtitle: 'Dans un ordre au hasard', art: art.icon('shuffle'), playable: true, browsable: false, action: true },
    ...list.map((s, i) => songNode(node, i, s, source)),
  ]
}

/** The songs of a collection, as the app's player wants them. */
async function songsOf(node) {
  const [kind, ...rest] = String(node).split('/')
  const a = rest.map(dec)
  switch (kind) {
    case 'liked': return library.tracks({ liked: true, sort: 'added', limit: 5000 }).map(fromLibrary)
    case 'all': return library.tracks({ sort: 'added', limit: 5000 }).map(fromLibrary)
    case 'recent': return library.tracks({ sort: 'recent', limit: 100 }).map(fromLibrary)
    case 'pl': return markOwned((playlists.get(a[0])?.tracks || []).map(x => ({ ...x })))
    case 'mix': { const m = (await mixesOfDay()).find(x => x.id === a[0]); return m ? markOwned(m.tracks) : [] }
    case 'alb': return library.albumTracks(a[0], a[1]).map(fromLibrary)
    case 'art': return library.artistTracks(a[0]).map(fromLibrary)
    case 'fol': { const r = await deezer.artist(a[0]); return markOwned(r.top || []) }
    case 'amix': { const r = await artistMix(a[0]); return markOwned(r.tracks || []) }
    case 'q': return (await searchSongs(a[0])).songs
    default: return []
  }
}
const contextOf = node => (/^(mix|amix)\//.test(node) ? 'mix' : node.startsWith('pl/') ? 'playlist' : 'list')

// --------------------------------------------------------------- the tree
async function children(id) {
  const node = String(id || 'root')
  if (node === 'root') {
    return [
      folder('home', 'Pour toi', { style: 'grid' }),
      folder('lists', 'Playlists', { style: 'grid' }),
      folder('lib', 'Bibliothèque', { style: 'list' }),
    ]
  }
  if (node === 'home') {
    const out = []
    if (['daily', 'discover', 'rediscover', 'chart'].some(shown)) {
      for (const m of await mixesOfDay()) {
        out.push(folder(`mix/${enc(m.id)}`, mixTitle(m), { subtitle: mixWho(m), art: art.rings(m.id + (m.seed || '') + m.kind, mixLabel(m), refOf(mixCenter(m))), group: 'Tes mixes du jour', style: 'list' }))
      }
    }
    if (shown('follows')) {
      const artists = [...follows.list().artists].sort((x, y) => (y.new ? 1 : 0) - (x.new ? 1 : 0))
      for (const a of artists.slice(0, 20)) out.push(folder(`fol/${enc(a.id)}`, a.name, { subtitle: a.new ? 'Nouveau titre' : 'Artiste suivi', art: art.ref(refOf(a.picture)) || art.icon('artist'), group: 'Du nouveau chez tes artistes', style: 'list' }))
    }
    if (shown('custom')) {
      for (const pl of playlists.mixes(10)) out.push(folder(`pl/${enc(pl.id)}`, pl.name.replace(/^Ton mix · /, ''), { subtitle: titles(pl.count), art: playlistArt(pl), group: 'Tes mixes', style: 'list' }))
    }
    if (!out.length) out.push({ id: 'empty|home', title: 'Rien pour l’instant', subtitle: 'Écoute quelques titres : tes mixes se construiront autour', playable: false, browsable: false, art: art.icon('list') })
    return out
  }
  if (node === 'lists') {
    const { tracks: all = 0, liked = 0 } = library.stats() || {}
    return [
      folder('liked', 'Titres aimés', { subtitle: titles(liked || 0), art: art.icon('heart'), style: 'list' }),
      folder('all', 'Téléchargés', { subtitle: `Sur ton téléphone · ${titles(all)}`, art: art.icon('phone'), style: 'list' }),
      ...playlists.list().map(pl => folder(`pl/${enc(pl.id)}`, pl.name, { subtitle: titles(pl.count), art: playlistArt(pl), style: 'list' })),
    ]
  }
  if (node === 'lib') {
    return [
      folder('albums', 'Albums', { art: art.icon('album'), style: 'grid' }),
      folder('artists', 'Artistes', { art: art.icon('artist'), style: 'list' }),
      folder('recent', 'Écoutés récemment', { art: art.icon('recent'), style: 'list' }),
      folder('follows', 'Artistes suivis', { art: art.icon('follow'), style: 'grid' }),
    ]
  }
  if (node === 'albums') return library.albums().slice(0, 500).map(a => folder(`alb/${enc(a.album)}/${enc(a.artist)}`, a.album, { subtitle: a.artist, art: art.ref(a.art_id ? `t:${a.art_id}` : null) || art.icon('album'), style: 'list' }))
  if (node === 'artists') return library.artists().slice(0, 500).map(a => folder(`art/${enc(a.name)}`, a.name, { subtitle: titles(a.count), art: art.ref(a.art_id ? `t:${a.art_id}` : null) || art.icon('artist'), style: 'list' }))
  if (node === 'follows') return follows.list().artists.map(a => folder(`fol/${enc(a.id)}`, a.name, { subtitle: a.new ? 'Nouveau titre' : 'Artiste suivi', art: art.ref(refOf(a.picture)) || art.icon('artist'), style: 'list' }))
  // A collection: Lire, Aléatoire, its songs.
  const songs = await songsOf(node)
  return collectionRows(node, songs)
}

// ----------------------------------------------------------------- search
const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
// "Mets du Stromae", "joue Road trip"…: what's left is what to play.
const cleanQuery = q => String(q || '').trim().replace(/^(mets|met|joue|lance|écoute|ecoute|play|passe)\s+(moi\s+)?((du|de la|de l'|de l’|des|de|la|le|les|l'|l’)\s*)?/i, '').replace(/\s+(sur|on)\s+(é|e)cho$/i, '').trim()

async function searchSongs(query) {
  const q = cleanQuery(query)
  const mine = q ? library.tracks({ q, sort: 'played', limit: 30 }).map(fromLibrary) : []
  let catalogue = { tracks: [], artists: [] }
  if (q) { try { catalogue = await withTimeout(deezer.search(q), 8000, catalogue) } catch {} }
  const seen = new Set(mine.map(s => s.deezer_id).filter(Boolean))
  const songs = [...mine, ...markOwned(catalogue.tracks || []).filter(s => !seen.has(s.deezer_id) && !mine.some(m => m.local_id && m.local_id === s.local_id))]
  return { q, songs, artists: catalogue.artists || [] }
}

async function search(query) {
  const { q, songs, artists } = await searchSongs(query)
  if (!q) return []
  const out = []
  const wanted = norm(q)
  const artist = artists.find(a => norm(a.name) === wanted) || artists[0]
  if (artist && norm(artist.name).includes(wanted)) {
    out.push(folder(`amix/${enc(artist.id)}`, `Mix ${artist.name}`, { subtitle: 'Que ses titres, comme sur ton téléphone', art: art.rings(`artist-${artist.id}${artist.name}artist`, artist.name, refOf(artist.picture)), group: follows.list().artists.some(x => String(x.id) === String(artist.id)) ? 'Artiste suivi' : 'Artiste', style: 'list' }))
  }
  for (const pl of playlists.list()) if (norm(pl.name).includes(wanted)) out.push(folder(`pl/${enc(pl.id)}`, pl.name, { subtitle: titles(pl.count), art: playlistArt(pl), group: 'Playlists', style: 'list' }))
  const source = sourceState()
  const node = `q/${enc(q)}`
  songs.slice(0, 40).forEach((s, i) => out.push({ ...songNode(node, i, s, source), group: 'Titres' }))
  return out
}

// ------------------------------------------------------------------ play
function shuffleList(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

/** The quality line under the artist in the car: "FLAC 24 bits · Basses+". */
function qualityOf(track) {
  const c = String(track?.codec || '').toLowerCase()
  let label = ''
  if (/flac/.test(c)) label = (track.bits || 0) > 16 ? `FLAC ${track.bits} bits` : 'FLAC'
  else if (/alac/.test(c)) label = 'ALAC'
  else if (/layer 3|mp3/.test(c)) label = 'MP3'
  else if (/aac|mp4a/.test(c)) label = 'AAC'
  else if (/opus/.test(c)) label = 'Opus'
  else if (/vorbis/.test(c)) label = 'OGG'
  const eq = prefs().eq
  const preset = eq?.enabled ? (PRESETS[eq.preset]?.name || 'Perso') : null
  return [label, preset].filter(Boolean).join(' · ')
}

/**
 * What the phone's player plays for these songs, from `index` on: your songs
 * from the library, the others downloaded first (by /api/play), in order,
 * up to a song that can't be got.
 */
function itemsFor(songs, index, { base, mediaToken, origin = null } = {}) {
  const withToken = url => (mediaToken ? `${url}${url.includes('?') ? '&' : '?'}t=${mediaToken}` : url)
  const canDownload = sourceState().installed
  const items = []
  const list = songs.slice(index, index + MAX_SONGS)
  for (const [k, s] of list.entries()) {
    if (s.local_id) {
      const tr = library.track(s.local_id)
      if (!tr) continue
      items.push({ id: s.local_id, url: withToken(`${base}/api/stream/${enc(s.local_id)}`), title: s.title || tr.title || '', artist: s.artist || tr.artist || '', album: s.album || tr.album || '', artwork: art.song({ ...s, has_art: tr.has_art }), duration: s.duration || tr.duration || 0, quality: qualityOf(tr) })
    } else if (s.deezer_id && canDownload) {
      const ahead = list.slice(k + 1).filter(x => !x.local_id && x.deezer_id).slice(0, 2).map(x => x.deezer_id)
      const q = new URLSearchParams({ title: s.title || '', artist: s.artist || '', album: s.album || '', duration: String(s.duration || ''), cover: s.cover || '', ...(origin ? { origin } : {}), ...(ahead.length ? { ahead: ahead.join(',') } : {}) })
      items.push({ id: `d:${s.deezer_id}`, url: withToken(`${base}/api/play/${enc(s.deezer_id)}?${q}`), title: s.title || '', artist: s.artist || '', album: s.album || '', artwork: art.song(s), duration: s.duration || 0, quality: qualityOf(null) })
    } else break
  }
  return items
}

/**
 * Something picked in the car. `id`: a song ("s|node|i"), "Lire"/"Aléatoire"
 * ("play|node", "shuf|node"), a collection itself, or nothing with a voice
 * `query` ("Mets du Stromae"). Returns the queue for the app (songs, index)
 * and for the player (items, from the song to start with).
 */
async function play({ id = '', query = '', shuffle = false } = {}, opts = {}) {
  let node = '', index = 0, shuffled = !!shuffle
  const parts = String(id || '').split('|')
  if (parts[0] === 's') { node = parts[1]; index = Number(parts[2]) || 0 }
  else if (parts[0] === 'play') node = parts[1]
  else if (parts[0] === 'shuf') { node = parts[1]; shuffled = true }
  else if (id && !id.includes('|')) node = id
  let songs = []
  if (node) songs = await songsOf(node)
  else {
    const found = await voice(query)
    node = found.node; songs = found.songs; shuffled = shuffled || found.shuffle
  }
  if (!songs.length) throw Object.assign(new Error('Rien à lire ici.'), { status: 404 })
  index = Math.max(0, Math.min(index, songs.length - 1))
  if (shuffled) { const first = parts[0] === 's' ? songs[index] : null; songs = first ? [first, ...shuffleList(songs.filter((_, i) => i !== index))] : shuffleList(songs); index = 0 }
  const context = contextOf(node)
  const items = itemsFor(songs, index, { ...opts, origin: context === 'mix' ? 'mix' : null })
  if (!items.length) throw Object.assign(new Error('Ce titre n’est pas sur ton téléphone et aucune source n’est prête.'), { status: 409 })
  return { node, context, shuffle: shuffled, index, songs: songs.slice(0, 2000), items }
}

/** "Mets du Stromae": a playlist by its name, an artist's mix, or songs. Nothing said: your liked songs, shuffled. */
async function voice(query) {
  const q = cleanQuery(query)
  if (!q) {
    const liked = await songsOf('liked')
    return liked.length ? { node: 'liked', songs: liked, shuffle: true } : { node: 'all', songs: await songsOf('all'), shuffle: true }
  }
  const wanted = norm(q)
  const exact = playlists.list().find(p => norm(p.name) === wanted)
  if (exact) return { node: `pl/${enc(exact.id)}`, songs: await songsOf(`pl/${enc(exact.id)}`) }
  const { songs, artists } = await searchSongs(q)
  const artist = artists.find(a => norm(a.name) === wanted)
  if (artist) {
    const mix = await withTimeout(artistMix(artist.id).catch(() => null), 12000, null)
    if (mix?.tracks?.length) return { node: `amix/${enc(artist.id)}`, songs: markOwned(mix.tracks) }
  }
  const pl = playlists.list().find(p => norm(p.name).includes(wanted))
  if (pl) return { node: `pl/${enc(pl.id)}`, songs: await songsOf(`pl/${enc(pl.id)}`) }
  const mine = library.artists({ q }).find(a => norm(a.name) === wanted)
  if (mine) return { node: `art/${enc(mine.name)}`, songs: await songsOf(`art/${enc(mine.name)}`), shuffle: true }
  return { node: `q/${enc(q)}`, songs }
}

/** Again what was playing (the app's last queue, saved by the player service). */
function resume({ songs = [], index = 0 } = {}, opts = {}) {
  const list = (Array.isArray(songs) ? songs : []).filter(s => s && (s.local_id || s.deezer_id)).slice(0, 2000)
  if (!list.length) return null
  const i = Math.max(0, Math.min(Number(index) || 0, list.length - 1))
  return { node: '', context: 'list', shuffle: false, index: i, songs: list, items: itemsFor(list, i, opts) }
}

// ------------------------------------------------------------ equalizer
/** The car's equalizer button: the next preset (Perso when you made one). */
function nextPreset() {
  const all = prefs()
  const eq = { enabled: false, preset: 'flat', bands: PRESETS.flat.bands, preamp: 0, ...(all.eq || {}) }
  const order = Object.keys(PRESETS).filter(k => k !== 'custom' || eq.custom)
  const at = eq.enabled ? order.indexOf(eq.preset) : order.indexOf('flat')
  const id = order[(at + 1) % order.length]
  const next = { ...eq, preset: id, enabled: id !== 'flat', bands: id === 'custom' ? eq.custom : PRESETS[id].bands }
  setSetting('prefs', JSON.stringify({ ...all, eq: next }))
  return { eq: next, name: next.enabled ? PRESETS[id].name : 'Désactivé' }
}
const presetName = () => { const eq = prefs().eq; return eq?.enabled ? (PRESETS[eq.preset]?.name || 'Perso') : 'Désactivé' }

// --------------------------------------------------------------- routes
function routes(app, { wrap, port, mediaToken, owned }) {
  if (owned) markOwned = owned
  const opts = () => ({ base: `http://127.0.0.1:${port()}`, mediaToken })
  app.get('/api/auto/children', wrap(req => children(String(req.query.id || 'root'))))
  app.get('/api/auto/search', wrap(req => search(String(req.query.q || ''))))
  app.post('/api/auto/play', wrap(req => play(req.body || {}, opts())))
  app.post('/api/auto/resume', wrap(req => resume(req.body || {}, opts())))
  app.get('/api/auto/eq', wrap(() => ({ eq: prefs().eq || null, name: presetName() })))
  app.post('/api/auto/eq/next', wrap(() => nextPreset()))
}

module.exports = { routes, children, search, play, resume, nextPreset, cleanQuery, qualityOf, art }
