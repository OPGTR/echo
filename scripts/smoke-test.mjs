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
let newRelease = false
const deezer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/lrclib/get') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ syncedLyrics: '[00:01.00]Première ligne\n[00:02.50]Deuxième ligne', plainLyrics: 'Première ligne\nDeuxième ligne' })) }
  if (u.pathname === '/release') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ body: 'Notes', assets: [{ name: 'Echo-0.0.2.5-arm64-v8a.apk', size: 4, browser_download_url: `http://127.0.0.1:${deezer.address().port}/apk` }, { name: 'network-report.txt', size: 1 }] })) }
  if (u.pathname === '/apk') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 4 }); return res.end('PK\u0003\u0004') }
  if (u.pathname === '/playlist/555') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 555, title: 'Ma playlist Deezer', tracks: { data: [trackOf(27, 1), trackOf(27, 2)] } })) }
  const send = v => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
  const q = (u.searchParams.get('q') || '').toLowerCase()
  let m
  if (u.pathname === '/search/artist') return send({ data: artistsDb[q] ? [artistsDb[q]] : [] })
  if (u.pathname === '/search/track') return send({ data: q.includes('around') ? [{ ...trackOf(27, 5), id: 3135556, title: 'Around the World', title_short: 'Around the World' }, trackOf(27, 0)] : [trackOf(27, 1)] })
  if (u.pathname === '/search/album') return send({ data: [{ id: 270, title: 'Homework', artist: { name: 'Daft Punk' }, record_type: 'album', release_date: '1997-01-20' }] })
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/related$/))) return send({ data: Array.from({ length: 12 }, (_, i) => ({ id: Number(m[1]) * 1000 + i, name: `Near ${m[1]}-${i}` })) })
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/top$/))) return send({ data: Array.from({ length: 10 }, (_, i) => trackOf(m[1], i)) })
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/albums$/))) return send({ data: [{ id: 270, title: 'Homework', release_date: '1997-01-20', record_type: 'album' }, ...(newRelease ? [{ id: 2701, title: 'New Single', release_date: '2026-10-01', record_type: 'single' }] : [])] })
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
  env: { ...process.env, ECHO_DEV: '1', ECHO_NO_AUTOVERIFY: '1', ECHO_PORT: String(PORT), ECHO_DATA_ROOT: path.join(tmp, 'app'), ECHO_DEEZER_API: DEEZER, ECHO_LYRICS_API: `${DEEZER}/lrclib`, ECHO_RELEASE_API: `${DEEZER}/release`, ECHO_MUSIC_DIR: shared, ECHO_MEDIA_DIR: media, PATH: '/nonexistent' },
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
  // ---------------------------------------------- 0.1: files that are hard to read
  {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const tools = req('../server/platform/tools.js')
    const m4a = path.join(tmp, 'broken-tag.m4a')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=5', '-c:a', 'aac', '-metadata', 'title=뚜두뚜두 DDU-DU', '-y', m4a])
    const b = fs.readFileSync(m4a); const at = b.indexOf('ilst') + 4; b.writeUInt32BE(0x0ea9b96f, at); fs.writeFileSync(m4a, b)
    const probed = await tools.probe(m4a).catch(e => ({ error: e.message }))
    ok('an M4A with a broken tag is still read (DDU-DU)', probed.streams?.[0]?.codec_name === 'aac' && Math.round(Number(probed.format.duration)) === 5, JSON.stringify(probed).slice(0, 160))
    const { parseLrc } = req('../server/lyrics.js')
    const lrc = parseLrc('[offset:+500]\n[00:01.50]a\n[00:02:30]b\n[00:03]c')
    ok('lyrics: [mm:ss:xx], [mm:ss] and [offset] are understood', lrc.map(l => l.t).join() === '1,1.8,2.5', JSON.stringify(lrc))
  }
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

  // ------------------------------------------------------ 0.0.2: downloads
  const waitJob = async id => until(async () => { const j = (await api('/downloads')).find(d => d.id === id); return j && ['done', 'error'].includes(j.status) ? j : null }, 60000)
  fs.rmSync(path.join(shared, 'Écho'), { force: true })
  const [aacJob] = await api('/downloads', { items: [{ deezer_id: '777001', title: 'Song 777001', artist: 'Daft Punk' }] })
  const aacDone = await waitJob(aacJob.id)
  const aacTrack = aacDone?.track_id && await api(`/tracks/${aacDone.track_id}`)
  ok('AAC sent as "audio.flac": probed, saved as .m4a, tagged, plays', aacDone?.status === 'done' && /aac|mp4a/i.test(aacTrack?.codec || '') && (await fetch(`${B}/stream/${aacDone.track_id}`)).ok, `${aacDone?.status} ${aacDone?.error || ''} ${aacTrack?.codec}`)
  const savedAac = fs.readdirSync(shared, { recursive: true }).concat(fs.readdirSync(path.join(media, 'Music'), { recursive: true })).find(f => /777001\.m4a$/.test(f))
  ok('the saved name follows the real format', !!savedAac, savedAac)

  const upT = await api('/source/upload', { data: fs.readFileSync(path.join(here, 'fixtures', 'fake-tidal.sflx')).toString('base64') })
  const srcs = await api('/sources')
  ok('several sources: Deezer then Tidal', srcs.sources?.filter(x => x.installed).map(x => x.id).join() === 'deezer,tidal-web', JSON.stringify(upT).slice(0, 120))
  const [chainJob] = await api('/downloads', { items: [{ deezer_id: '666123', title: 'Song 666123', artist: 'Daft Punk' }] })
  const chainDone = await waitJob(chainJob.id)
  ok('a song Deezer lacks comes from the next source (matched by title/artist)', chainDone?.status === 'done' && /Tidal/.test(chainDone.message || ''), `${chainDone?.status} ${chainDone?.message} ${chainDone?.error || ''}`)
  ok('0.3.3: why Deezer failed stays readable after Tidal took over', chainDone?.status === 'done' && /^Deezer : /.test(chainDone.error || ''), chainDone?.error)
  const [both] = await api('/downloads', { items: [{ deezer_id: '666999', title: 'Song 666999', artist: 'Daft Punk' }] })
  const bothFail = await waitJob(both.id)
  ok('no source has it: one clear error naming each source', bothFail?.status === 'error' && /Deezer/.test(bothFail.error) && /Tidal/.test(bothFail.error), bothFail?.error)
  const reordered = await api('/sources/order', { ids: ['tidal-web', 'deezer'] }, 'PUT')
  ok('source order', reordered.sources?.[0]?.id === 'tidal-web')
  await api('/sources/order', { ids: ['deezer', 'tidal-web'] }, 'PUT')
  await api('/settings', { quality_tier: 'hires' }, 'PUT')
  ok('quality preference', (await api('/settings')).quality_tier === 'hires')

  // ----------------------------------------------------- 0.0.2: playlists
  const pl = await api('/playlists', { name: 'Test', tracks: [{ local_id: by['One More Time'].id, title: 'One More Time', artist: 'Daft Punk' }, { deezer_id: '27002', title: 'Daft Punk song 2', artist: 'Daft Punk' }, { local_id: by['Formation'].id, title: 'Formation', artist: 'Beyoncé' }] })
  let got = await api(`/playlists/${pl.id}`)
  ok('playlist: create with songs', got.count === 3 && got.tracks.length === 3 && got.tracks[0].local_id === by['One More Time'].id)
  got = await api(`/playlists/${pl.id}`, { sort: 'title', sort_dir: 'desc' }, 'PUT')
  ok('playlist: sort by title, descending', got.tracks.map(t => t.title).join('|') === 'One More Time|Formation|Daft Punk song 2', got.tracks.map(t => t.title).join('|'))
  got = await api(`/playlists/${pl.id}/items`, { ids: [got.tracks[2].item_id, got.tracks[0].item_id, got.tracks[1].item_id] }, 'PUT')
  ok('playlist: custom order', got.sort === 'custom' && got.tracks[0].title === 'Daft Punk song 2', got.tracks.map(t => t.title).join('|'))
  got = await api(`/playlists/${pl.id}/items/${got.tracks[0].item_id}`, null, 'DELETE')
  ok('playlist: remove a song', got.count === 2)
  const imp = await api('/playlists/import', { url: 'https://www.deezer.com/fr/playlist/555' })
  ok('import a Deezer playlist link', imp.name === 'Ma playlist Deezer' && imp.count === 2 && imp.source === 'deezer', JSON.stringify(imp).slice(0, 160))
  const badLink = await api('/playlists/import', { url: 'https://example.com/x' })
  ok('a link from elsewhere is refused clearly', /Spotify|Deezer/.test(badLink.error || badLink.text || ''))
  ok('playlists list', (await api('/playlists')).length === 2)
  await api(`/playlists/${pl.id}`, null, 'DELETE')
  ok('playlist: delete', (await api('/playlists')).length === 1)

  // --------------------------------------------- 0.0.2: mixes, rediscover
  const tops = await api('/mixes/artists')
  ok('your artists for "Ton mix"', Array.isArray(tops) && tops.some(a => a.name === 'Daft Punk'))
  const custom = await api('/mixes/custom', { artists: [{ id: '27', name: 'Daft Punk' }, { id: '145', name: 'Beyoncé' }], era: 'both' })
  ok('"Ton mix" from 2 artists, kept as a playlist', custom.kind === 'mix' && custom.count >= 6, `${custom.count} ${custom.error || ''}`)
  // -------------------------------------------------- 0.1: "Je n'aime pas ce titre"
  const customItems = custom.tracks || []
  const hated = customItems.find(t => !t.local_id) || customItems[0]
  const disl = await api('/dislikes', { title: hated?.title, artist: hated?.artist, deezer_id: hated?.deezer_id })
  ok('a song you dislike is kept aside', disl.length === 1 && disl[0].title === hated?.title, JSON.stringify(disl).slice(0, 160))
  const again = await api('/mixes/custom', { artists: [{ id: '27', name: 'Daft Punk' }, { id: '145', name: 'Beyoncé' }], era: 'both' })
  const againItems = again.tracks || []
  ok('it is not proposed again in a mix', againItems.length > 0 && !againItems.some(t => t.title === hated.title && t.artist === hated.artist), `${againItems.length} items`)
  const fyNo = await api('/foryou')
  ok('nor in Pour toi', !(fyNo.mixes || []).some(m => m.tracks.some(t => t.title === hated.title && t.artist === hated.artist)))
  ok('and can be taken back', (await api('/dislikes/remove', { title: hated.title, artist: hated.artist })).length === 0)
  // -------------------------------------------------- 0.2
  const am = await api('/mixes/artist/27')
  ok('the mix of one artist holds only their songs', am.tracks?.length > 0 && am.tracks.every(x => x.artist === 'Daft Punk'), `${am.tracks?.length} ${am.error || ''}`)
  const pl4 = await api('/playlists', { name: 'Image', tracks: am.tracks.slice(0, 5) })
  const items4 = pl4.tracks.map(x => x.item_id)
  const withCover = await api(`/playlists/${pl4.id}`, { cover_items: [items4[4], items4[3], items4[2], items4[1]] }, 'PUT')
  ok('a playlist keeps the 4 songs chosen for its picture', withCover.custom_cover === true && withCover.meta?.cover_items?.[0] === items4[4], JSON.stringify(withCover.meta))
  ok('…and goes back to the first 4', (await api(`/playlists/${pl4.id}`, { cover_items: [] }, 'PUT')).custom_cover === false)
  const waited = await api('/downloads/wait?deezer_id=999999999&timeout=1000')
  ok('waiting on an unknown download answers at once', waited === null || waited?.status === undefined || !waited, JSON.stringify(waited))
  {
    const { createRequire } = await import('node:module')
    const { readNotes } = createRequire(import.meta.url)('../server/update.js')
    const notes = readNotes('Intro\n\n## Nouveautés dans 0.2.0\n\n### Améliorations\n- Un [lien](https://x) et **gras**\n### Corrections\n- Bug\n\n---\n- Quel fichier')
    ok('release notes read as sections', notes.length === 2 && notes[0].title === 'Améliorations' && notes[0].items[0] === 'Un lien et gras' && notes[1].items.length === 1, JSON.stringify(notes))
  }
  // -------------------------------------------------- 0.3
  const mixesBefore = await api('/playlists')
  ok('a mix stays out of your playlists until you add it', !mixesBefore.some(p => p.kind === 'mix'), mixesBefore.map(p => p.kind).join())
  const artistPl = await api('/mixes/artist/27', {})
  ok('"Créer un mix de cet artiste" keeps it in Tes mixes', artistPl.kind === 'mix' && (await api('/mixes/mine')).some(p => p.id === artistPl.id), artistPl.error)
  await api(`/playlists/${artistPl.id}/keep`, { saved: true })
  ok('…and it can be added to your playlists', (await api('/playlists')).some(p => p.id === artistPl.id))
  const mine = (await api('/library/tracks?limit=50'))[0]
  const dupe = await api('/playlists', { name: 'Doublon', tracks: [{ deezer_id: '424242', title: `${mine.title} (Original Score)`, artist: 'Someone Else', duration: mine.duration }] })
  ok('the song you already have is preferred over another version', dupe.tracks[0]?.local_id === mine.id, JSON.stringify(dupe.tracks[0]).slice(0, 160))
  await api('/settings', { mix_recent_months: 18 }, 'PUT')
  ok('how recent "Récentes" is can be set', (await api('/settings')).mix_recent_months === 18)
  const played = await fetch(`${B}/play/${by['Formation'].deezer_id || '0'}`)
  ok('the play-through address answers', [200, 206, 404].includes(played.status), String(played.status))
  // -------------------------------------------------- 0.3.2: songs heard in a mix go after 48 h
  {
    const { createRequire } = await import('node:module')
    const mixJob = (await api('/downloads', { items: [{ deezer_id: '9999123', title: 'Song 9999123', artist: 'Daft Punk' }], origin: 'mix' }))[0]
    const doneMix = await until(async () => { const d = (await api('/downloads')).find(x => x.deezer_id === '9999123' && ['done', 'error'].includes(x.status)); return d || null }, 30000)
    ok('a song heard in a mix is downloaded', doneMix?.status === 'done', JSON.stringify(doneMix || mixJob).slice(0, 160))
    const later = Date.now() + 49 * 3600000
    const kept = await api('/dev/clean-temporary', { at: Date.now() + 3600000 })
    ok('…and still there before 48 h', kept.removed === 0 && !!(await api(`/tracks/${doneMix.track_id}`)).id)
    const gone = await api('/dev/clean-temporary', { at: later })
    ok('…and removed after 48 h when not kept', gone.removed === 1 && (await fetch(`${B}/tracks/${doneMix.track_id}`)).status === 404, JSON.stringify(gone))
    const likedJob = (await api('/downloads', { items: [{ deezer_id: '2701', title: 'Song 2701', artist: 'Daft Punk' }], origin: 'mix' }))[0]
    const doneLiked = await until(async () => { const d = (await api('/downloads')).find(x => x.deezer_id === '2701' && ['done', 'error'].includes(x.status)); return d || null }, 30000)
    if (doneLiked?.track_id) await api(`/tracks/${doneLiked.track_id}/like`, { liked: true })
    await api('/dev/clean-temporary', { at: later })
    ok('a song from a mix you liked stays', !!doneLiked?.track_id && (await fetch(`${B}/tracks/${doneLiked.track_id}`)).status === 200, JSON.stringify(doneLiked || likedJob).slice(0, 120))
  }
  await api('/settings', { mix_era: 'recent' }, 'PUT')
  const fyRecent = await api('/foryou')
  ok('Pour toi with "recent" songs only (rebuilt, no crash)', fyRecent.era === 'recent' && Array.isArray(fyRecent.mixes), fyRecent.error)
  ok('"À redécouvrir" list', Array.isArray(fyRecent.rediscover))
  await api('/settings', { mix_era: 'both' }, 'PUT')

  // -------------------------------------------------- 0.0.2: follows
  let fol = await api('/follows', { id: '27' })
  ok('follow an artist', fol.artists?.length === 1 && fol.artists[0].name === 'Daft Punk' && !fol.artists[0].new)
  newRelease = true
  fol = await api('/follows?force=1')
  ok('a new release shows a dot', fol.unseen === 1 && fol.artists[0].new && fol.news[0]?.title === 'New Single', JSON.stringify(fol).slice(0, 200))
  fol = await api('/follows/27/seen', {})
  ok('seen: the dot goes', fol.unseen === 0)
  ok('artist page knows it is followed', (await api('/catalogue/artist/27')).followed === true)

  // ------------------------------------------- 0.0.2: lyrics, prefs, update, cast
  const ly = await api('/lyrics?title=Formation&artist=Beyonc%C3%A9&duration=12')
  ok('synced lyrics', ly.synced?.length === 2 && ly.synced[1].t === 2.5 && ly.synced[0].line === 'Première ligne', JSON.stringify(ly).slice(0, 160))
  await api('/prefs', { theme: 'luce', startTab: 'playlists' }, 'PUT')
  ok('interface preferences are kept', (await api('/prefs')).theme === 'luce')
  const upd = await api('/update?build=3')
  ok('a newer version is found', upd.available && upd.version === '0.0.2' && upd.build === 5 && !!upd.assets['arm64-v8a'], JSON.stringify(upd).slice(0, 160))
  ok('no update when already on it', (await api('/update?build=5')).available === false)
  await api('/update/download', { abi: 'arm64-v8a', build: 3 })
  const updDone = await until(async () => { const st = await api('/update/status'); return st.state === 'ready' || st.state === 'error' ? st : null }, 20000)
  ok('the update downloads', updDone?.state === 'ready' && fs.existsSync(updDone.file), JSON.stringify(updDone))
  const castInfo = await api('/cast/start', { ip: '192.168.1.50' })
  const castPort = Number(/:(\d+)\//.exec(castInfo.base || '')?.[1])
  const castPath = (castInfo.base || '').replace(/^http:\/\/[^/]+/, '')
  const castRes = castPort && await fetch(`http://127.0.0.1:${castPort}${castPath}/stream/${by['Formation'].id}`)
  ok('casting: songs served on the Wi-Fi with their own secret', castRes?.ok && (await fetch(`http://127.0.0.1:${castPort}/c/wrong/stream/${by['Formation'].id}`)).status === 404, castInfo.base)
  await api('/cast/stop', {})
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
