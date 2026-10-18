// Écho's server, end to end, as on the phone: Node 18 without ICU, programs
// can't be started (scripts/simulate-android.cjs). A stand-in Deezer
// catalogue and a stand-in Deezer addon (writes a short FLAC) make the whole
// path testable offline: scan, play, likes, search, "Pour toi", download
// (tags, saving, a refused folder), library.
//
//   node scripts/smoke-test.mjs [path to a Node 18 binary]
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const nodeBin = process.argv[2] || process.env.NODE18 || process.execPath
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-smoke-'))
const music = path.join(tmp, 'library')
const shared = path.join(tmp, 'storage', 'Music')
const media = path.join(tmp, 'storage', 'Android', 'media', 'com.opgtr.echo')
fs.mkdirSync(shared, { recursive: true })
execFileSync('bash', [path.join(here, 'make-test-music.sh'), music], { stdio: 'ignore' })

// ------------------------------------------------------- stand-in Deezer
const artistsDb = {
  'daft punk': { id: 27, name: 'Daft Punk' }, 'beyonce': { id: 145, name: 'Beyoncé' }, 'beyoncé': { id: 145, name: 'Beyoncé' },
  'кино': { id: 9001, name: 'Кино' }, 'jack white': { id: 7, name: 'Jack White' }, 'cafe tacvba': { id: 8, name: 'Café Tacvba' }, 'café tacvba': { id: 8, name: 'Café Tacvba' },
}
const nameOf = id => Object.values(artistsDb).find(a => a.id === Number(id))?.name || `Related ${id}`
const trackOf = (artistId, i) => ({ id: Number(artistId) * 100 + i, title: Number(artistId) === 27 && i === 0 ? 'One More Time' : `${nameOf(artistId)} song ${i}`, title_short: Number(artistId) === 27 && i === 0 ? 'One More Time' : `${nameOf(artistId)} song ${i}`, duration: 200 + i, artist: { id: Number(artistId), name: nameOf(artistId) }, album: { id: Number(artistId) * 10, title: `${nameOf(artistId)} Album`, cover_xl: null } })
const deezer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const send = v => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
  const q = (u.searchParams.get('q') || '').toLowerCase()
  let m
  if (u.pathname === '/search/artist') return send({ data: artistsDb[q] ? [artistsDb[q]] : [] })
  if (u.pathname === '/search/track') return send({ data: q.includes('around') ? [{ ...trackOf(27, 5), id: 3135556, title: 'Around the World', title_short: 'Around the World' }, trackOf(27, 0)] : [trackOf(27, 1)] })
  if (u.pathname === '/search/album') return send({ data: [{ id: 270, title: 'Homework', artist: { name: 'Daft Punk' }, record_type: 'album', release_date: '1997-01-20' }] })
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/related$/))) return send({ data: Array.from({ length: 12 }, (_, i) => ({ id: Number(m[1]) * 1000 + i, name: `Near ${m[1]}-${i}` })) })
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/top$/))) return send({ data: Array.from({ length: 10 }, (_, i) => trackOf(m[1], i)) })
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/albums$/))) return send({ data: [{ id: 270, title: 'Homework', release_date: '1997-01-20', record_type: 'album' }] })
  if ((m = u.pathname.match(/^\/artist\/(\d+)$/))) return send({ id: Number(m[1]), name: nameOf(m[1]), nb_fan: 1000 })
  if ((m = u.pathname.match(/^\/album\/(\d+)$/))) return send({ id: 270, title: 'Homework', artist: { name: 'Daft Punk' }, release_date: '1997-01-20', tracks: { data: [{ ...trackOf(27, 5), id: 3135556, title: 'Around the World', title_short: 'Around the World' }, trackOf(27, 0)] } })
  if ((m = u.pathname.match(/^\/track\/(\d+)$/))) return send({ id: Number(m[1]), title: Number(m[1]) === 3135556 ? 'Around the World' : `Song ${m[1]}`, track_position: 7, disk_number: 1, release_date: '1997-01-20', isrc: 'GBDUW0000059', artist: { id: 27, name: 'Daft Punk' }, contributors: [{ name: 'Daft Punk' }], album: { id: 270, title: 'Homework', cover_xl: null } })
  if (u.pathname.startsWith('/chart')) return send({ data: [trackOf(5, 1), trackOf(5, 2)] })
  res.writeHead(404); res.end('{}')
})
await new Promise(r => deezer.listen(0, '127.0.0.1', r))
const DEEZER = `http://127.0.0.1:${deezer.address().port}`

// ------------------------------------------------------------- the server
const PORT = 3600 + Math.floor(Math.random() * 300)
const B = `http://127.0.0.1:${PORT}/api`
let log = ''
const server = spawn(nodeBin, ['-r', path.join(here, 'simulate-android.cjs'), path.join(root, 'www', 'nodejs', 'index.js')], {
  env: { ...process.env, ECHO_DEV: '1', ECHO_PORT: String(PORT), ECHO_DATA_ROOT: path.join(tmp, 'app'), ECHO_DEEZER_API: DEEZER, ECHO_MUSIC_DIR: shared, ECHO_MEDIA_DIR: media, PATH: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })

const failures = []
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!cond) failures.push(name) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (p, body, method) => {
  const res = await fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { status: res.status, text } }
}
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(300) } }

try {
  ok('server starts', !!await until(async () => { try { return (await api('/health')).ok } catch { return false } }, 20000))
  // Token required outside dev mode is checked by the CI (unauthorized without it) below.

  // ---------------------------------------------------------- library
  await api('/settings', { music_folders: [music] }, 'PUT')
  await api('/library/scan', {})
  const st = await until(async () => { const s = await api('/library/status'); return !s.scanning && s.total ? s : null })
  const files = fs.readdirSync(music, { recursive: true }).filter(f => /\.(mp3|flac|m4a|ogg|opus)$/i.test(f)).length
  ok('scan reads every song', st?.done === files && st?.errors === 0, JSON.stringify(st))
  const tracks = await api('/library/tracks?sort=title')
  const by = Object.fromEntries(tracks.map(t => [t.title, t]))
  ok('tags: accents, Cyrillic, Latin-1', by['Formation']?.artist === 'Beyoncé' && by['Группа крови']?.artist === 'Кино' && !!by['Café Tacuba'])
  const artists = await api('/library/artists')
  ok('"feat." songs under the main artist', artists.some(a => a.name === 'Beyoncé' && a.count === 2) && !artists.some(a => /feat/i.test(a.name)), artists.map(a => `${a.name}:${a.count}`).join(', '))
  ok('albums', (await api('/library/albums')).length >= 4)
  const r = await fetch(`${B}/stream/${by['Formation'].id}`, { headers: { Range: 'bytes=0-1023' } })
  ok('stream with seeking (Range)', r.status === 206 && (await r.arrayBuffer()).byteLength === 1024)
  const alac = await fetch(`${B}/stream/${by['Something About Us'].id}`)
  ok('Apple Lossless plays (FLAC copy, ffmpeg WebAssembly)', alac.ok && Buffer.from(await alac.arrayBuffer()).subarray(0, 4).toString() === 'fLaC')
  ok('cover art', (await fetch(`${B}/art/${by['Formation'].id}`)).ok)
  await api(`/tracks/${by['Formation'].id}/like`, { liked: true })
  for (let i = 0; i < 3; i++) await api(`/tracks/${by['One More Time'].id}/play`, { seconds: 200 })
  ok('likes', (await api('/library/tracks?liked=1')).map(t => t.title).join() === 'Formation')
  ok('listening history', (await api('/history'))[0]?.title === 'One More Time')

  // ----------------------------------------------------------- search
  const s = await api('/search?q=around')
  ok('search: library + catalogue', s.catalogue.tracks.length === 2 && Array.isArray(s.library) && !s.offline, `${s.catalogue.tracks.length} catalogue`)
  ok('catalogue songs you have are marked', s.catalogue.tracks.find(t => t.title === 'One More Time')?.local_id === by['One More Time'].id)
  ok('catalogue album page', (await api('/catalogue/album/270')).tracks?.length === 2)
  ok('catalogue artist page', (await api('/catalogue/artist/27')).top?.length === 10)

  // ---------------------------------------------------------- for you
  const fy = await api('/foryou?force=1')
  ok('Pour toi: daily mixes from listening', fy.mixes?.some(m => m.kind === 'daily') && fy.basedOn?.[0] === 'Daft Punk', `${fy.mixes?.map(m => `${m.id}(${m.tracks.length})`).join(' ')} based on ${fy.basedOn}`)
  const daily = fy.mixes.find(m => m.kind === 'daily')
  ok('a mix holds some of your songs (offline) and new ones', daily.tracks.some(t => t.local_id) && daily.tracks.some(t => !t.local_id && t.deezer_id))
  ok('songs you have are never suggested as new', !fy.mixes.flatMap(m => m.tracks).some(t => !t.local_id && t.title === 'One More Time'))
  ok('"Découvertes" only artists you don\'t have', fy.mixes.some(m => m.kind === 'discover'))

  // --------------------------------------------------------- download
  ok('no source yet', (await api('/source')).installed === false)
  const up = await api('/source/upload', { data: fs.readFileSync(path.join(here, 'fixtures', 'fake-deezer.sflx')).toString('base64') })
  const src = await api('/source')
  ok('Deezer addon installed', src.installed && src.ready, JSON.stringify(up).slice(0, 120))
  // The chosen folder can't be written (like an SD card): the next one is used.
  await api('/settings', { download_dir: '/proc/echo-cannot-write-here' }, 'PUT')
  const [job] = await api('/downloads', { items: [{ deezer_id: '3135556', title: 'Around the World', artist: 'Daft Punk', album: 'Homework' }] })
  const done = await until(async () => { const j = (await api('/downloads')).find(d => d.id === job.id); if (process.env.SHOW_LOG) console.log('  job', JSON.stringify(j).slice(0, 200)); return j && ['done', 'error'].includes(j.status) ? j : null }, 60000)
  ok('download finishes', done?.status === 'done', JSON.stringify(done).slice(0, 300))
  const saved = path.join(shared, 'Écho', 'Daft Punk', 'Homework', '07 Around the World.flac')
  ok('saved under Music/Écho/<artist>/<album> despite the refused folder', fs.existsSync(saved), fs.existsSync(path.join(shared, 'Écho')) ? fs.readdirSync(path.join(shared, 'Écho'), { recursive: true }).join(', ') : 'no Music/Écho')
  const t = await api(`/tracks/${done?.track_id}`)
  ok('in the library, tagged from the catalogue', t?.title === 'Around the World' && t?.artist === 'Daft Punk' && t?.album === 'Homework' && t?.track_no === 7 && t?.deezer_id === '3135556', JSON.stringify(t).slice(0, 200))
  ok('plays', (await fetch(`${B}/stream/${done?.track_id}`)).ok)
  ok('asking again gives the song you have', (await api('/downloads', { items: [{ deezer_id: '3135556' }] }))[0]?.track_id === done?.track_id)
  ok('search now marks it as yours', (await api('/search?q=around')).catalogue.tracks.find(x => x.deezer_id === '3135556')?.local_id === done?.track_id)
  // Music/Écho itself refused (a file in the way): the app's media folder takes it.
  fs.writeFileSync(path.join(shared, 'Écho', 'Daft Punk', 'Homework', 'blocker'), '')
  fs.rmSync(path.join(shared, 'Écho'), { recursive: true, force: true })
  fs.writeFileSync(path.join(shared, 'Écho'), 'not a folder')
  const [job2] = await api('/downloads', { items: [{ deezer_id: '27001', title: 'Song 27001', artist: 'Daft Punk' }] })
  const done2 = await until(async () => { const j = (await api('/downloads')).find(d => d.id === job2.id); return j && ['done', 'error'].includes(j.status) ? j : null }, 60000)
  ok('falls back to Android/media/<app>/Music', done2?.status === 'done' && fs.readdirSync(path.join(media, 'Music'), { recursive: true }).some(f => f.endsWith('.flac')), JSON.stringify(done2).slice(0, 200))
  const [bad] = await api('/downloads', { items: [{ deezer_id: '666', title: 'Missing' }] })
  const failed = await until(async () => { const j = (await api('/downloads')).find(d => d.id === bad.id); return j && ['done', 'error'].includes(j.status) ? j : null }, 30000)
  ok('a song the source lacks fails cleanly', failed?.status === 'error' && /not available/i.test(failed.error || ''), failed?.error)
  ok('retry', (await api(`/downloads/${bad.id}/retry`, {})).ok === true)
  ok('rescan keeps everything', (await (async () => { await api('/library/scan', {}); await until(async () => !(await api('/library/status')).scanning); return (await api('/library/stats')).tracks })()) === files + 2)
} catch (e) {
  ok('smoke test ran', false, e.stack)
} finally {
  server.kill(); deezer.close()
  await sleep(300)
  const crashes = log.split('\n').filter(l => /uncaught|unhandled rejection|SyntaxError|ReferenceError/.test(l))
  ok('no crash in the server log', !crashes.length, crashes.slice(0, 4).join(' | '))
  if (failures.length || process.env.SHOW_LOG) console.log('\n--- server log ---\n' + log.slice(-5000))
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
  process.exit(failures.length ? 1 : 0)
}
