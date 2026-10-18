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
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    const line = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const m of stamps) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), line })
  }
  return lines.sort((a, b) => a.t - b.t)
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
  const key = crypto.createHash('sha1').update(`${artist}\u0000${title}`.toLowerCase()).digest('hex')
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
    hit = list.find(r => r.syncedLyrics && (!duration || Math.abs((r.duration || 0) - duration) < 4)) || list.find(r => r.syncedLyrics) || list[0] || null
  }
  const out = { found: !!(hit?.syncedLyrics || hit?.plainLyrics), synced: parseLrc(hit?.syncedLyrics), plain: hit?.plainLyrics || null, at: Date.now() }
  try { fs.writeFileSync(file, JSON.stringify(out)) } catch {}
  return out
}

module.exports = { find, parseLrc }
