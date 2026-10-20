'use strict'
// "Pour toi": daily mixes built from what you listen to.
//
// The artists you play most (listening time, plays, recent listening weighs
// more, likes) lead, through Deezer's catalogue, to similar artists and their
// best songs. Each Daily Mix is one of your favourite artists and those around
// them: a few songs you already have (they play at once, offline) among songs
// you don't have yet (downloaded when played). "Découvertes" only holds
// artists you don't have at all. Rebuilt once a day, or on request.
const fs = require('fs')
const path = require('path')
const deezer = require('./deezer')
const { getDB, getSetting } = require('./db')
const { dataDir } = require('./paths')
const dislikes = require('./dislikes')

const DAY = 24 * 60 * 60 * 1000
const MIX_SIZE = 30
const OWNED_PER_MIX = 4
const MAX_DAILY = 6

const norm = v => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\s*[([].*?(feat|ft|with|remaster|version|edit|live|mono|stereo)[^)\]]*[)\]]/g, '')
  .replace(/[^a-z0-9Ѐ-ӿ֐-׿؀-ۿ぀-ヿ一-鿿]+/g, ' ').trim()
const mainArtist = a => String(a || '').split(/\s*(?:,|&|;|\/|\bfeat\.?|\bft\.?|\bx\b|\bwith\b)\s*/i)[0]
const songKey = (artist, title) => `${norm(mainArtist(artist))}\u0000${norm(title)}`

async function mapLimited(items, fn, limit = 4) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i) } catch { out[i] = null } }
  }))
  return out
}

/** Your artists, best first: [{ name, score }]. */
function seeds(db, now = Date.now()) {
  const scores = new Map()
  const add = (name, score) => {
    for (const part of String(name || '').split(/\s*(?:,|&|;|\bfeat\.?|\bft\.?)\s*/i)) {
      const clean = part.trim()
      if (!clean || /^(unknown|artiste inconnu|various artists|divers)$/i.test(clean)) continue
      const k = norm(clean)
      const e = scores.get(k) || { name: clean, score: 0 }
      e.score += score
      scores.set(k, e)
    }
  }
  const since = now - 90 * DAY
  const rows = db.prepare(`SELECT artist, SUM(seconds) AS secs, COUNT(*) AS plays, MAX(played_at) AS last FROM plays WHERE played_at >= ? GROUP BY artist`).all(since)
  for (const r of rows) {
    const age = Math.max(0, (now - (r.last || 0)) / DAY)
    const recency = 1 + 2 * Math.exp(-age / 14)
    add(r.artist, (Math.min(r.secs || 0, 3 * 3600) / 60 + (r.plays || 0) * 2) * recency)
  }
  for (const r of db.prepare('SELECT artist FROM tracks WHERE liked = 1').all()) add(r.artist, 8)
  if (scores.size < 3) {
    for (const r of db.prepare('SELECT COALESCE(album_artist, artist) AS artist, COUNT(*) AS n, SUM(play_count) AS p FROM tracks GROUP BY 1 ORDER BY n + p * 3 DESC LIMIT 20').all()) add(r.artist, (r.n || 0) + (r.p || 0) * 3)
  }
  return [...scores.values()].sort((a, b) => b.score - a.score)
}

function library(db) {
  const owned = new Map() // songKey -> track
  const byArtist = new Map() // norm(artist) -> [track]
  for (const t of db.prepare('SELECT id, title, artist, album, duration, art IS NOT NULL AS has_art, play_count, deezer_id FROM tracks').all()) {
    owned.set(songKey(t.artist, t.title), t)
    const k = norm(mainArtist(t.artist))
    if (!byArtist.has(k)) byArtist.set(k, [])
    byArtist.get(k).push(t)
  }
  return { owned, byArtist }
}

function rng(seedText) {
  let h = 2166136261
  for (const ch of String(seedText)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e9) / 1e9 }
}
const shuffle = (items, random) => { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
function spread(items) {
  const out = [], rest = [...items]
  while (rest.length) { const prev = out[out.length - 1]?.artist; const i = rest.findIndex(t => t.artist !== prev); out.push(rest.splice(i < 0 ? 0 : i, 1)[0]) }
  return out
}
function coversOf(items) {
  const seen = new Set(), covers = []
  for (const t of items) { const c = t.cover || (t.local_id && t.has_art ? `local:${t.local_id}` : null); if (c && !seen.has(c)) { seen.add(c); covers.push(c) } if (covers.length === 4) break }
  return covers
}

// ------------------------------------------------------------------ eras
// "Récentes": from the artist's releases of the last 3 years; "Anciennes":
// from releases more than a year old; "Les deux": their best songs.
function inEra(when, era, now = Date.now()) {
  if (!when || era === 'both') return true
  // A release date ("2025-11-03") when there is one, else a year.
  const time = /^\d{4}-\d{2}-\d{2}/.test(String(when)) ? Date.parse(String(when).slice(0, 10)) : Date.UTC(Number(when), 6, 1)
  if (!Number.isFinite(time)) return true
  const months = Number(getSetting('mix_recent_months')) || 12
  const recent = now - time < months * 30.44 * DAY
  return era === 'recent' ? recent : !recent
}

/** An artist's songs for a mix, in the chosen era. */
async function artistSongs(artistId, era = 'both', { now = Date.now(), want = 10 } = {}) {
  const top = (await deezer.topTracks(artistId)) || []
  if (era === 'both') return top.map(t => deezer.song(t))
  let albums = []
  try { albums = await deezer.artistAlbums(artistId) } catch {}
  const dates = new Map(albums.map(a => [a.id, a.release_date || a.year]))
  const out = top.filter(t => inEra(dates.get(String(t.album?.id)), era, now)).map(t => deezer.song(t))
  if (out.length < want) {
    const pick = albums.filter(a => inEra(a.release_date || a.year, era, now) && a.type !== 'compile')
    const chosen = era === 'recent' ? pick.slice(0, 2) : shuffle(pick, rng(`${artistId}${new Date(now).toISOString().slice(0, 10)}`)).slice(0, 2)
    for (const a of chosen) {
      try { const full = await deezer.album(a.id); out.push(...full.tracks) } catch {}
      if (out.length >= want * 2) break
    }
  }
  return out
}

/** A song you have, in the mix's shape. */
const localSong = t => ({ local_id: t.id, has_art: t.has_art, title: t.title, artist: t.artist, album: t.album || '', duration: t.duration, cover: null, deezer_id: t.deezer_id || null })

async function build(db, { now = Date.now(), era = 'both' } = {}) {
  const date = new Date(now).toISOString().slice(0, 10)
  const random = rng(date)
  const { owned, byArtist } = library(db)
  const used = new Set()
  const disliked = dislikes.filter()
  const fresh = t => { const k = songKey(t.artist, t.title); return t.title && t.artist && !owned.has(k) && !used.has(k) && !disliked(t) }
  const take = t => { used.add(songKey(t.artist, t.title)); return t }

  const top = seeds(db, now).slice(0, 12)
  const found = (await mapLimited(top, async s => { const a = await deezer.findArtist(s.name); return a ? { seed: s, artist: a } : null })).filter(Boolean)
  const relatedBy = await mapLimited(found, f => deezer.related(f.artist.id))

  const mixes = []
  await mapLimited(found.slice(0, MAX_DAILY), async ({ seed, artist }, index) => {
    const around = shuffle((relatedBy[index] || []).slice(0, 10), random).slice(0, 7)
    const groups = await mapLimited([artist, ...around], a => artistSongs(a.id, era, { now }), 4)
    const picks = []
    groups.forEach((g, i) => picks.push(...shuffle((g || []).filter(fresh), random).slice(0, i === 0 ? 3 : 4)))
    const mine = shuffle((byArtist.get(norm(seed.name)) || []).filter(t => !disliked(t)), random).slice(0, OWNED_PER_MIX).map(localSong)
    const tracks = spread(shuffle([...picks.slice(0, MIX_SIZE - mine.length), ...mine], random)).map(take)
    if (tracks.length >= 6) {
      mixes[index] = { id: `daily-${index + 1}`, kind: 'daily', index: index + 1, seed: seed.name, artists: [artist.name, ...around.map(a => a.name)].slice(0, 4), covers: coversOf(tracks), tracks }
    }
  }, 2)

  // Artists close to yours that you don't have at all.
  const pool = new Map()
  relatedBy.forEach(list => (list || []).forEach(a => {
    if (byArtist.has(norm(a.name)) || found.some(f => norm(f.artist.name) === norm(a.name))) return
    const e = pool.get(a.id) || { artist: a, hits: 0 }
    e.hits++
    pool.set(a.id, e)
  }))
  const candidates = shuffle([...pool.values()], random).sort((x, y) => y.hits - x.hits).slice(0, 30)
  const discover = []
  ;(await mapLimited(candidates, c => artistSongs(c.artist.id, era, { now, want: 3 }), 4)).forEach(list => {
    const options = (list || []).filter(fresh)
    const pick = options[Math.floor(random() * Math.min(3, options.length))]
    if (pick) discover.push(take(pick))
  })
  const out = mixes.filter(Boolean)
  if (discover.length >= 6) out.push({ id: 'discover', kind: 'discover', index: 0, seed: null, artists: candidates.slice(0, 4).map(c => c.artist.name), covers: coversOf(discover), tracks: spread(discover) })

  // Nothing to go on yet: what's popular now.
  if (!out.length) {
    const tracks = (await deezer.chart().catch(() => [])).map(t => deezer.song(t)).filter(fresh).slice(0, 40).map(take)
    if (tracks.length) out.push({ id: 'chart', kind: 'chart', index: 0, seed: null, artists: [...new Set(tracks.map(t => t.artist))].slice(0, 4), covers: coversOf(tracks), tracks })
  }
  return { date, era, generatedAt: now, basedOn: found.map(f => f.artist.name).slice(0, 6), mixes: out }
}

/** Today's mixes (built once a day, or when `force`). Songs you got since are marked as yours. */
async function forYou({ force = false, now = Date.now(), era = null } = {}) {
  const db = getDB()
  const file = path.join(dataDir(), 'foryou.json')
  const today = new Date(now).toISOString().slice(0, 10)
  const wanted = ['recent', 'old', 'both'].includes(era) ? era : (getSetting('mix_era') || 'both')
  let result = null
  if (!force) {
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved?.date === today && (saved.era || 'both') === wanted && Array.isArray(saved.mixes)) result = { ...saved, cached: true } } catch {}
  }
  if (!result) {
    result = await build(db, { now, era: wanted })
    if (result.mixes.length) { try { fs.writeFileSync(file, JSON.stringify(result)) } catch {} }
  }
  // Downloaded since: the song is now yours (plays offline, from the library).
  const { owned } = library(db)
  const disliked = dislikes.filter()
  result = { ...result, mixes: result.mixes.map(m => ({ ...m, tracks: m.tracks.filter(t => !disliked(t)) })) }
  const byDeezer = new Map(db.prepare('SELECT id, deezer_id, art IS NOT NULL AS has_art FROM tracks WHERE deezer_id IS NOT NULL').all().map(r => [r.deezer_id, r]))
  const sameSong = require('./playlists').libraryIndex()
  for (const mix of result.mixes) {
    for (const t of mix.tracks) {
      if (t.local_id) continue
      const own = (t.deezer_id && byDeezer.get(t.deezer_id)) || owned.get(songKey(t.artist, t.title)) || sameSong(t)
      if (own) { t.local_id = own.id; t.has_art = own.has_art }
    }
  }
  // "À redécouvrir" is one of the mixes too, right after "Découvertes".
  const again = rediscover(db, { now }).filter(t => !disliked(t))
  let mixes = result.mixes.filter(m => m.kind !== 'rediscover')
  if (again.length >= 3) {
    const at = mixes.findIndex(m => m.kind === 'discover')
    const mix = { id: 'rediscover', kind: 'rediscover', index: 0, seed: null, artists: [...new Set(again.map(t => t.artist))].slice(0, 4), covers: [], tracks: again }
    mixes = at >= 0 ? [...mixes.slice(0, at + 1), mix, ...mixes.slice(at + 1)] : [...mixes, mix]
  }
  return { ...result, mixes, rediscover: again }
}

/**
 * "À redécouvrir": songs you played a lot, and not lately.
 * Played at least 3 times, not in the last 3 weeks.
 */
function rediscover(db, { now = Date.now(), limit = 30 } = {}) {
  const since = now - 21 * DAY
  return db.prepare(`
    SELECT id, title, artist, album, duration, art IS NOT NULL AS has_art, deezer_id, play_count, last_played
      FROM tracks
     WHERE play_count >= 3 AND last_played IS NOT NULL AND last_played < ?
     ORDER BY play_count DESC, last_played ASC
     LIMIT ?`).all(since, limit).map(t => ({ ...localSong(t), play_count: t.play_count, last_played: t.last_played }))
}

/** Your most listened artists (for "Ton mix"): [{ name, score }]. */
function topArtists(limit = 20) {
  return seeds(getDB()).slice(0, limit)
}

/**
 * "Ton mix": 2 or 3 artists you pick, their songs and their neighbours'
 * (in the chosen era), a few of yours among them.
 */
async function customMix(picked = [], { era = 'both', now = Date.now() } = {}) {
  const db = getDB()
  const random = rng(`${now}${picked.map(p => p.name || p.id).join()}`)
  const { owned, byArtist } = library(db)
  const artists = (await mapLimited(picked.slice(0, 3), async p => (p.id ? { id: String(p.id), name: p.name } : await deezer.findArtist(p.name)))).filter(Boolean)
  if (!artists.length) throw Object.assign(new Error('Choisis au moins un artiste.'), { status: 400 })
  const relatedBy = await mapLimited(artists, a => deezer.related(a.id))
  const neighbours = []
  relatedBy.forEach(list => shuffle((list || []).slice(0, 8), random).slice(0, 3).forEach(a => { if (!artists.some(x => String(x.id) === String(a.id)) && !neighbours.some(n => n.id === a.id)) neighbours.push(a) }))
  const used = new Set()
  const disliked = dislikes.filter()
  const fresh = t => { const k = songKey(t.artist, t.title); if (used.has(k) || disliked(t)) return false; used.add(k); return true }
  const groups = await mapLimited([...artists, ...neighbours], a => artistSongs(a.id, era, { now }), 4)
  const picks = []
  groups.forEach((g, i) => picks.push(...shuffle((g || []).filter(fresh), random).slice(0, i < artists.length ? 7 : 3)))
  const mine = artists.flatMap(a => shuffle((byArtist.get(norm(a.name)) || []).filter(t => !disliked(t)), random).slice(0, 2)).map(localSong)
  const tracks = spread(shuffle([...picks.slice(0, 30 - mine.length), ...mine], random)).map(t => {
    const own = !t.local_id && owned.get(songKey(t.artist, t.title))
    return own ? { ...t, local_id: own.id, has_art: own.has_art } : t
  })
  return { artists: artists.map(a => ({ id: String(a.id), name: a.name })), era, tracks }
}


/**
 * The mix of one artist: only their songs. Their best known, then songs from
 * their albums and singles (the ones you never played first), a few of yours
 * among them. Different each day.
 */
async function artistMix(artistId, { now = Date.now() } = {}) {
  const db = getDB()
  const id = String(artistId)
  const random = rng(`${id}${new Date(now).toISOString().slice(0, 10)}`)
  const { owned } = library(db)
  const disliked = dislikes.filter()
  const info = await deezer.artistInfo(id).catch(() => null)
  const top = ((await deezer.topTracks(id).catch(() => [])) || []).map(t => deezer.song(t))
  let albums = []
  try { albums = (await deezer.artistAlbums(id)).filter(a => a.type !== 'compile') } catch {}
  const deep = []
  for (const a of shuffle(albums, random).slice(0, 5)) {
    try { const full = await deezer.album(a.id); deep.push(...full.tracks) } catch {}
  }
  const used = new Set()
  const mine = t => String(t.artist_id || '') === id || norm(mainArtist(t.artist)) === norm(info?.name || '')
  const fresh = t => { const k = songKey(t.artist, t.title); if (!t.title || used.has(k) || disliked(t) || !mine(t)) return false; used.add(k); return true }
  const unheard = t => !owned.has(songKey(t.artist, t.title))
  const best = top.filter(fresh).slice(0, 12)
  const rest = shuffle(deep.filter(fresh), random)
  const tracks = spread(shuffle([...best, ...rest.filter(unheard).slice(0, 14), ...rest.filter(t => !unheard(t)).slice(0, 4)], random)).slice(0, 30).map(t => {
    const own = !t.local_id && owned.get(songKey(t.artist, t.title))
    return own ? { ...t, local_id: own.id, has_art: own.has_art } : t
  })
  return { artist: { id, name: info?.name || tracks[0]?.artist || '' , picture: info?.picture || null }, tracks }
}

module.exports = { artistMix, forYou, build, seeds, songKey, rediscover, topArtists, customMix, artistSongs }
