'use strict'
// New versions of Écho: the APKs of the newest GitHub release (one per version). Downloaded
// here; the app hands the file to Android's installer.
const fs = require('fs')
const path = require('path')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const { dataDir } = require('./paths')

const RELEASE = process.env.ECHO_RELEASE_API || 'https://api.github.com/repos/OPGTR/echo/releases/latest'
let cache = null
let job = { state: 'idle', progress: 0, file: null, error: null }

/** Echo-0.0.2.17-arm64-v8a.apk -> { version: '0.0.2', build: 17, abi: 'arm64-v8a' } */
function parseName(name) {
  const m = /^Echo-(\d+(?:\.\d+)*)\.(\d+)-([\w-]+)\.apk$/.exec(name || '')
  return m ? { version: m[1], build: Number(m[2]), abi: m[3] } : null
}

async function check({ build = 0, force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < 30 * 60 * 1000) return { ...cache.value, available: cache.value.build > Number(build || 0) }
  const res = await fetch(RELEASE, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Echo' } })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const rel = await res.json()
  const apks = (rel.assets || []).map(a => ({ ...parseName(a.name), url: a.browser_download_url, size: a.size })).filter(a => a.build)
  const top = apks.reduce((m, a) => (a.build > (m?.build || 0) ? a : m), null)
  const value = {
    version: top?.version || null, build: top?.build || 0,
    notes: String(rel.body || '').slice(0, 4000),
    assets: Object.fromEntries(apks.filter(a => a.build === top?.build).map(a => [a.abi, { url: a.url, size: a.size }])),
  }
  cache = { at: Date.now(), value }
  return { ...value, available: value.build > Number(build || 0) }
}

async function download({ abi = 'arm64-v8a', build = 0 } = {}) {
  if (job.state === 'downloading') return job
  const info = await check({ build })
  const asset = info.assets[abi] || info.assets['arm64-v8a'] || Object.values(info.assets)[0]
  if (!asset) throw new Error('Aucun APK pour ce téléphone')
  const dir = path.join(dataDir(), 'update')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'Echo.apk')
  job = { state: 'downloading', progress: 0, file: null, error: null, version: info.version, size: asset.size }
  ;(async () => {
    try {
      const res = await fetch(asset.url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || asset.size || 0
      let done = 0
      const counter = new (require('stream').Transform)({ transform(chunk, _, cb) { done += chunk.length; if (total) job.progress = Math.round(done / total * 100); cb(null, chunk) } })
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(file))
      job = { ...job, state: 'ready', progress: 100, file }
    } catch (e) {
      job = { ...job, state: 'error', error: e.message }
    }
  })()
  return job
}

const status = () => job

module.exports = { check, download, status, parseName }
