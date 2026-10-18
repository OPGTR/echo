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
const { getDB } = require('./db')
const { dataDir } = require('./paths')

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
  for (const t of items) { const c = t.cover || (t.local_id ? `local:${t.local_id}` : null); if (c && !seen.has(c)) { seen.add(c); covers.push(c) } if (covers.length === 4) break }
  return covers
}

/** A song you have, in the mix's shape. */
const localSong = t => ({ local_id: t.id, title: t.title, artist: t.artist, album: t.album || '', duration: t.duration, cover: null, deezer_id: t.deezer_id || null })

async function build(db, { now = Date.now() } = {}) {
  const date = new Date(now).toISOString().slice(0, 10)
  const random = rng(date)
  const { owned, byArtist } = library(db)
  const used = new Set()
  const fresh = t => { const k = songKey(t.artist, t.title); return t.title && t.artist && !owned.has(k) && !used.has(k) }
  const take = t => { used.add(songKey(t.artist, t.title)); return t }

  const top = seeds(db, now).slice(0, 12)
  const found = (await mapLimited(top, async s => { const a = await deezer.findArtist(s.name); return a ? { seed: s, artist: a } : null })).filter(Boolean)
  const relatedBy = await mapLimited(found, f => deezer.related(f.artist.id))

  const mixes = []
  await mapLimited(found.slice(0, MAX_DAILY), async ({ seed, artist }, index) => {
    const around = shuffle((relatedBy[index] || []).slice(0, 10), random).slice(0, 7)
    const groups = await mapLimited([artist, ...around], a => deezer.topTracks(a.id), 4)
    const picks = []
    groups.forEach((g, i) => picks.push(...shuffle((g || []).map(t => deezer.song(t)).filter(fresh), random).slice(0, i === 0 ? 3 : 4)))
    const mine = shuffle(byArtist.get(norm(seed.name)) || [], random).slice(0, OWNED_PER_MIX).map(localSong)
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
  ;(await mapLimited(candidates, c => deezer.topTracks(c.artist.id), 4)).forEach(list => {
    const options = (list || []).map(t => deezer.song(t)).filter(fresh)
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
  return { date, generatedAt: now, basedOn: found.map(f => f.artist.name).slice(0, 6), mixes: out }
}

/** Today's mixes (built once a day, or when `force`). Songs you got since are marked as yours. */
async function forYou({ force = false, now = Date.now() } = {}) {
  const db = getDB()
  const file = path.join(dataDir(), 'foryou.json')
  const today = new Date(now).toISOString().slice(0, 10)
  let result = null
  if (!force) {
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved?.date === today && Array.isArray(saved.mixes)) result = { ...saved, cached: true } } catch {}
  }
  if (!result) {
    result = await build(db, { now })
    if (result.mixes.length) { try { fs.writeFileSync(file, JSON.stringify(result)) } catch {} }
  }
  // Downloaded since: the song is now yours (plays offline, from the library).
  const { owned } = library(db)
  const byDeezer = new Map(db.prepare('SELECT id, deezer_id FROM tracks WHERE deezer_id IS NOT NULL').all().map(r => [r.deezer_id, r.id]))
  for (const mix of result.mixes) {
    for (const t of mix.tracks) {
      if (t.local_id) continue
      const id = (t.deezer_id && byDeezer.get(t.deezer_id)) || owned.get(songKey(t.artist, t.title))?.id
      if (id) t.local_id = id
    }
  }
  return result
}

module.exports = { forYou, build, seeds, songKey }
