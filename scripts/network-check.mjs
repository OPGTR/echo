// With the real network (CI report, never fails the build): Deezer's
// catalogue, "Pour toi" built from a small library, the Deezer source
// installed, and one real download attempt.
//
//   node scripts/network-check.mjs <music folder> [Node 18 binary]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const music = process.argv[2]
const nodeBin = process.argv[3] || process.execPath
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-net-'))
const shared = path.join(tmp, 'Music')
fs.mkdirSync(shared)
const PORT = 3950
const B = `http://127.0.0.1:${PORT}/api`
const server = spawn(nodeBin, ['-r', path.join(here, 'simulate-android.cjs'), path.join(root, 'www', 'nodejs', 'index.js')], {
  env: { ...process.env, ECHO_DEV: '1', ECHO_PORT: String(PORT), ECHO_DATA_ROOT: path.join(tmp, 'app'), ECHO_MUSIC_DIR: shared, ECHO_MEDIA_DIR: path.join(tmp, 'media'), PATH: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (p, body, method) => {
  const res = await fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { status: res.status, text } }
}
const show = (name, v) => console.log(`\n== ${name}\n${JSON.stringify(v, null, 1).slice(0, 1500)}`)

try {
  for (let i = 0; i < 60; i++) { try { if ((await api('/health')).ok) break } catch {} await sleep(500) }
  await api('/settings', { music_folders: [music] }, 'PUT')
  await api('/library/scan', {})
  for (let i = 0; i < 60; i++) { const s = await api('/library/status'); if (!s.scanning && s.total) break; await sleep(500) }
  const search = await api('/search?q=daft%20punk%20around%20the%20world')
  show('search', { library: search.library?.length, tracks: search.catalogue?.tracks?.slice(0, 3), error: search.error })
  const fy = await api('/foryou?force=1')
  show('pour toi', { basedOn: fy.basedOn, mixes: fy.mixes?.map(m => ({ kind: m.kind, seed: m.seed, tracks: m.tracks.length, local: m.tracks.filter(t => t.local_id).length })), error: fy.error })
  show('source install', await api('/source/install', {}))
  show('verify info', await api('/source/verify-info', {}))
  const song = search.catalogue?.tracks?.[0]
  if (song) {
    await api('/downloads', { items: [song] })
    let d
    for (let i = 0; i < 120; i++) { d = (await api('/downloads'))[0]; if (d && ['done', 'error'].includes(d.status)) break; await sleep(1000) }
    show('download', d)
  }
} catch (e) {
  console.log('check failed:', e.message)
} finally {
  server.kill()
  console.log('\n== server log (end)\n' + log.slice(-3000))
}
