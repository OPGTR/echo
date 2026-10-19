'use strict'
// Song lyrics from LRCLIB (free, open): synced lines when there are some, for
// the karaoke screen. Kept on the phone once found (and "none" for a week).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { dataDir } = require('./paths')

const API = process.env.ECHO_LYRICS_API || 'https://lrclib.net/api'
const WEEK = 7 * 24 * 60 * 60 * 1000

function parseLrc(text) {
  const lines = []
  let offset = 0
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw)
    if (off) { offset = Number(off[1]) / 1000; continue }
    // [mm:ss.xx], [mm:ss:xx] and [mm:ss] all happen.
    const stamps = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)]
    if (!stamps.length) continue
    const line = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim()
    for (const m of stamps) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0
      const t = Number(m[1]) * 60 + Number(m[2]) + frac
      if (Number.isFinite(t)) lines.push({ t, line })
    }
  }
  // [offset:+500] means the lyrics come 0.5 s earlier.
  return lines.map(l => ({ ...l, t: Math.max(0, Math.round((l.t - offset) * 100) / 100) })).sort((a, b) => a.t - b.t)
}

async function ask(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': `Echo/${require('./version').version} (https://github.com/OPGTR/echo)` } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`LRCLIB ${res.status}`)
    return res.json()
  } finally { clearTimeout(timer) }
}

async function find({ title, artist, album, duration }) {
  if (!title || !artist) return { synced: [], plain: null, found: false }
  const dir = path.join(dataDir(), 'lyrics')
  fs.mkdirSync(dir, { recursive: true })
  const key = crypto.createHash('sha1').update(`v2\u0000${artist}\u0000${title}\u0000${Math.round(duration || 0)}`.toLowerCase()).digest('hex')
  const file = path.join(dir, `${key}.json`)
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved.found || Date.now() - saved.at < WEEK) return saved
  } catch {}
  const q = new URLSearchParams({ artist_name: artist, track_name: title })
  if (album) q.set('album_name', album)
  if (duration) q.set('duration', String(Math.round(duration)))
  let hit = await ask(`${API}/get?${q}`).catch(() => null)
  if (!hit?.syncedLyrics && !hit?.plainLyrics) {
    const results = await ask(`${API}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`).catch(() => null)
    const list = Array.isArray(results) ? results : []
    // Synced lines only from the same version of the song (same length):
    // a radio edit's timings don't fit the album version.
    const close = r => !duration || !r.duration || Math.abs(r.duration - duration) < 4
    hit = list.find(r => r.syncedLyrics && close(r)) || list.find(r => r.plainLyrics && close(r)) || null
    if (!hit) { const any = list.find(r => r.plainLyrics || r.syncedLyrics); hit = any ? { plainLyrics: any.plainLyrics || any.syncedLyrics.replace(/\[[^\]]*\]/g, '').trim() } : null }
  } else if (hit.syncedLyrics && duration && hit.duration && Math.abs(hit.duration - duration) >= 4) {
    hit = { plainLyrics: hit.plainLyrics || hit.syncedLyrics.replace(/\[[^\]]*\]/g, '').trim() }
  }
  const out = { found: !!(hit?.syncedLyrics || hit?.plainLyrics), synced: parseLrc(hit?.syncedLyrics), plain: hit?.plainLyrics || null, at: Date.now() }
  try { fs.writeFileSync(file, JSON.stringify(out)) } catch {}
  return out
}

module.exports = { find, parseLrc }
