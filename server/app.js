'use strict'
const express = require('express')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { getDB, getSetting, setSetting, getJSON } = require('./db')
const { dataDir, setPlatformDirs, downloadDirs, platform } = require('./paths')
const library = require('./library')
const deezer = require('./deezer')
const downloads = require('./downloads')
const sources = require('./sources')
const { forYou, songKey, topArtists, customMix, artistMix } = require('./foryou')
const playlists = require('./playlists')
const follows = require('./follows')
const dislikes = require('./dislikes')
const lyrics = require('./lyrics')
const updates = require('./update')
const http = require('http')
const { version } = require('./version')

const TOKEN = process.env.ECHO_TOKEN || crypto.randomBytes(24).toString('hex')

function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: process.env.ECHO_DEV === '1' ? '40mb' : '2mb' }))
  // The app's page (http://localhost) calls this server (http://127.0.0.1).
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'content-type, x-echo-token, range')
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.set('Access-Control-Expose-Headers', 'content-length, content-range, accept-ranges')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })
  // Only Écho itself: every request carries the secret it got at start-up.
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next()
    if (process.env.ECHO_DEV === '1') return next()
    const token = req.get('x-echo-token') || req.query.t
    if (typeof token === 'string' && token.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) return next()
    res.status(401).json({ error: 'unauthorized' })
  })

  const wrap = fn => async (req, res) => {
    try { res.json(await fn(req, res)) } catch (error) { res.status(error.status || 500).json({ error: error.message || String(error) }) }
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, version }))

  // ------------------------------------------------------------ settings
  const settingsView = () => ({
    music_folders: library.folders(),
    download_dir: getSetting('download_dir'),
    download_dir_used: getSetting('download_dir_used') || downloadDirs(getSetting('download_dir'))[0],
    download_quality: getSetting('download_quality'),
    quality_tier: getSetting('quality_tier') || 'cd',
    mix_era: getSetting('mix_era') || 'both',
    onboarded: getSetting('onboarded') === '1',
    mix_recent_months: Number(getSetting('mix_recent_months')) || 12,
    platform,
  })
  app.get('/api/settings', wrap(settingsView))
  app.put('/api/settings', wrap(req => {
    const b = req.body || {}
    if (Array.isArray(b.music_folders)) library.setFolders(b.music_folders)
    if ('download_dir' in b) setSetting('download_dir', b.download_dir && path.isAbsolute(b.download_dir) ? b.download_dir : null)
    if ('download_quality' in b) setSetting('download_quality', b.download_quality || null)
    if ('onboarded' in b) setSetting('onboarded', b.onboarded ? '1' : '0')
    if (['hires', 'cd', 'lossy'].includes(b.quality_tier)) setSetting('quality_tier', b.quality_tier)
    if (['recent', 'old', 'both'].includes(b.mix_era)) setSetting('mix_era', b.mix_era)
    // How recent "Récentes" is, in months (3 to 60); the mixes are made again.
    if (Number.isFinite(Number(b.mix_recent_months)) && 'mix_recent_months' in b) {
      setSetting('mix_recent_months', String(Math.max(3, Math.min(60, Math.round(Number(b.mix_recent_months))))))
      try { fs.rmSync(path.join(require('./paths').dataDir(), 'foryou.json'), { force: true }) } catch {}
    }
    return settingsView()
  }))
  // The interface's own choices (theme, start page, sections, equalizer…).
  app.get('/api/prefs', wrap(() => getJSON('prefs', {})))
  app.put('/api/prefs', wrap(req => {
    const next = { ...getJSON('prefs', {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) }
    const text = JSON.stringify(next)
    if (text.length > 200000) throw Object.assign(new Error('too large'), { status: 413 })
    setSetting('prefs', text)
    return next
  }))
  app.post('/api/platform', wrap(req => { setPlatformDirs(req.body || {}); return settingsView() }))

  // ------------------------------------------------------------- library
  const scanRoots = () => downloadDirs(getSetting('download_dir')).filter(d => fs.existsSync(d))
  app.post('/api/library/scan', wrap(() => { library.scan({ extraFolders: scanRoots() }).catch(e => console.warn('[scan]', e.message)); return { ...library.status, scanning: true } }))
  app.get('/api/library/status', wrap(() => ({ ...library.status })))
  app.get('/api/library/stats', wrap(() => library.stats()))
  app.get('/api/library/tracks', wrap(req => library.tracks({ sort: req.query.sort, q: req.query.q, liked: req.query.liked === '1', limit: req.query.limit, offset: req.query.offset })))
  app.get('/api/library/albums', wrap(req => library.albums({ q: req.query.q })))
  app.get('/api/library/album', wrap(req => library.albumTracks(String(req.query.album || ''), String(req.query.artist || ''))))
  app.get('/api/library/artists', wrap(req => library.artists({ q: req.query.q })))
  app.get('/api/library/artist', wrap(req => library.artistTracks(String(req.query.name || ''))))
  app.get('/api/history', wrap(req => library.tracks({ sort: 'recent', limit: Number(req.query.limit) || 30 })))

  app.get('/api/tracks/:id', wrap(req => { const t = library.track(req.params.id); if (!t) throw Object.assign(new Error('not found'), { status: 404 }); delete t.path; delete t.art; return t }))
  app.post('/api/tracks/:id/like', wrap(req => ({ liked: library.setLiked(req.params.id, !!req.body?.liked) })))
  app.post('/api/tracks/:id/play', wrap(req => ({ ok: library.recordPlay(req.params.id, req.body?.seconds) })))
  app.delete('/api/tracks/:id', wrap(async req => {
    const t = library.track(req.params.id)
    if (!t) return { ok: true }
    let removed = true
    try { await fsp.unlink(t.path) } catch (e) { if (e.code !== 'ENOENT') removed = false }
    if (removed) getDB().prepare('DELETE FROM tracks WHERE id = ?').run(t.id)
    return { ok: removed, error: removed ? null : 'Android did not allow deleting this file' }
  }))

  // Audio, with seeking. Formats the phone's player can't decode (Apple
  // Lossless, WMA, APE, WavPack, AIFF) play from a FLAC copy made once.
  const PLAYABLE = new Set(['mpeg 1 layer 3', 'mp3', 'flac', 'aac', 'mpeg-4/aac', 'mp4a', 'opus', 'vorbis', 'pcm', 'wave', 'wav'])
  const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' }
  const converting = new Map()
  async function playableFile(t) {
    const codec = String(t.codec || '').toLowerCase()
    const ext = path.extname(t.path).toLowerCase()
    const needs = /alac|wma|ape|monkey|wavpack|aiff|pcm_s.*be/.test(codec) || ['.wma', '.ape', '.wv', '.aif', '.aiff'].includes(ext) || (!PLAYABLE.has(codec) && !MIME[ext])
    if (!needs) return t.path
    const dir = path.join(dataDir(), 'playable'); fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, `${t.id}.flac`)
    if (fs.existsSync(out) && fs.statSync(out).size) return out
    if (!converting.has(out)) {
      converting.set(out, new Promise((resolve, reject) => {
        const child = require('child_process').spawn('ffmpeg', ['-nostdin', '-y', '-i', t.path, '-map', '0:a:0', '-c:a', 'flac', out])
        let err = ''
        child.stderr.on('data', d => { err = (err + d).slice(-1500) })
        child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || 'conversion failed')))
      }).finally(() => converting.delete(out)))
    }
    return converting.get(out)
  }
  async function streamTrack(req, res) {
    const t = library.track(req.params.id)
    if (!t || !fs.existsSync(t.path)) return res.status(404).end()
    let file
    try { file = await playableFile(t) } catch (e) { return res.status(415).json({ error: e.message }) }
    const stat = fs.statSync(file)
    const type = MIME[path.extname(file).toLowerCase()] || 'audio/mpeg'
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range)
    if (range) {
      let start = range[1] ? Number(range[1]) : 0
      let end = range[2] ? Number(range[2]) : stat.size - 1
      if (!range[1] && range[2]) { start = Math.max(0, stat.size - Number(range[2])); end = stat.size - 1 }
      if (start >= stat.size) return res.status(416).set('Content-Range', `bytes */${stat.size}`).end()
      end = Math.min(end, stat.size - 1)
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type })
      fs.createReadStream(file, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' })
      fs.createReadStream(file).pipe(res)
    }
  }
  function sendArt(req, res) {
    const t = library.track(req.params.id)
    if (!t?.art || !fs.existsSync(t.art)) return res.status(404).end()
    res.set('Cache-Control', 'private, max-age=86400')
    res.sendFile(t.art)
  }
  app.get('/api/stream/:id', streamTrack)
  // A catalogue song the phone's player asks for directly (the queue it
  // holds goes on even when the app sleeps, screen locked): downloaded first,
  // then played like any song of yours.
  app.get('/api/play/:deezer', async (req, res) => {
    const id = String(req.params.deezer || '').replace(/[^0-9]/g, '')
    if (!id) return res.status(404).end()
    try {
      let local = downloads.ownedTrack(id)
      if (!local) {
        const [job] = downloads.enqueue([{ deezer_id: id, play: true, title: String(req.query.title || ''), artist: String(req.query.artist || ''), album: String(req.query.album || ''), cover: String(req.query.cover || ''), duration: Number(req.query.duration) || null }])
        local = job?.track_id || (await downloads.waitFor(id, 5 * 60000))?.track_id || null
      }
      if (!local) return res.status(404).json({ error: 'not downloaded' })
      req.params.id = local
      return streamTrack(req, res)
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }) }
  })
  app.get('/api/art/:id', sendArt)

  // Casting: a TV or a speaker on the Wi-Fi plays from a second, LAN-facing
  // server that only serves audio and covers, with its own secret, and only
  // while casting.
  let cast = null
  app.post('/api/cast/start', wrap(async req => {
    const ip = String(req.body?.ip || '')
    if (!/^(10|172|192)\.[\d.]+$/.test(ip)) throw Object.assign(new Error('no Wi-Fi address'), { status: 400 })
    if (!cast) {
      const secret = crypto.randomBytes(16).toString('hex')
      const lan = express()
      lan.use((rq, rs, next) => { rs.set('Access-Control-Allow-Origin', '*'); next() })
      lan.get(`/c/${secret}/stream/:id`, streamTrack)
      lan.get(`/c/${secret}/art/:id`, sendArt)
      lan.use((rq, rs) => rs.status(404).end())
      const server = http.createServer(lan)
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve) })
      cast = { server, secret }
    }
    return { base: `http://${ip}:${cast.server.address().port}/c/${cast.secret}` }
  }))
  app.post('/api/cast/stop', wrap(() => { if (cast) { cast.server.close(); cast = null } return { ok: true } }))

  // --------------------------------------------------- catalogue + for you
  // Songs from the catalogue you already have get their library id.
  function markOwned(songs) {
    const db = getDB()
    const rows = db.prepare('SELECT id, deezer_id, artist, title, art IS NOT NULL AS has_art FROM tracks').all()
    const byDeezer = new Map(rows.filter(r => r.deezer_id).map(r => [r.deezer_id, r]))
    const byKey = new Map(rows.map(r => [songKey(r.artist, r.title), r]))
    for (const s of songs || []) {
      if (!s || s.local_id) continue
      const own = byDeezer.get(s.deezer_id) || byKey.get(songKey(s.artist, s.title))
      if (own) { s.local_id = own.id; s.has_art = own.has_art }
    }
    return songs
  }
  app.get('/api/foryou', wrap(req => forYou({ force: req.query.force === '1' })))
  app.get('/api/search', wrap(async req => {
    const q = String(req.query.q || '').trim()
    if (!q) return { library: [], catalogue: { tracks: [], artists: [], albums: [] } }
    const local = library.tracks({ q, sort: 'played', limit: 12 })
    let catalogue = { tracks: [], artists: [], albums: [] }, offline = false
    try { catalogue = await deezer.search(q) } catch { offline = true }
    markOwned(catalogue.tracks)
    return { library: local, catalogue, offline }
  }))
  app.get('/api/catalogue/album/:id', wrap(async req => { const a = await deezer.album(req.params.id); markOwned(a.tracks); return a }))
  app.get('/api/catalogue/artist/:id', wrap(async req => { const a = await deezer.artist(req.params.id); markOwned(a.top); return { ...a, followed: follows.isFollowed(a.id) } }))
  app.get('/api/foryou/era', wrap(() => ({ era: getSetting('mix_era') || 'both' })))

  // ------------------------------------------------------------ playlists
  const withOwned = pl => { if (pl?.tracks) markOwned(pl.tracks); return pl }
  app.get('/api/playlists', wrap(() => playlists.list()))
  app.post('/api/playlists', wrap(req => { const pl = playlists.create({ name: req.body?.name }); return req.body?.tracks?.length ? withOwned(playlists.addItems(pl.id, req.body.tracks)) : pl }))
  app.put('/api/playlists/order', wrap(req => playlists.arrange(req.body?.ids)))
  app.post('/api/playlists/import', wrap(async req => withOwned(await playlists.importLink(String(req.body?.url || '').trim(), { name: req.body?.name }))))
  app.get('/api/playlists/:id', wrap(req => withOwned(playlists.get(req.params.id))))
  app.put('/api/playlists/:id', wrap(req => withOwned(playlists.update(req.params.id, req.body || {}))))
  app.delete('/api/playlists/:id', wrap(req => playlists.remove(req.params.id)))
  app.post('/api/playlists/:id/items', wrap(req => withOwned(playlists.addItems(req.params.id, req.body?.tracks || []))))
  app.delete('/api/playlists/:id/items/:item', wrap(req => withOwned(playlists.removeItem(req.params.id, Number(req.params.item)))))
  app.put('/api/playlists/:id/items', wrap(req => withOwned(playlists.reorder(req.params.id, (req.body?.ids || []).map(Number)))))

  // ---------------------------------------------------------------- mixes
  app.get('/api/mixes/artists', wrap(async () => {
    const top = topArtists(16)
    const found = await Promise.all(top.map(async a => { try { const d = await deezer.findArtist(a.name); return d ? { ...deezer.artistOf(d), score: Math.round(a.score) } : { id: null, name: a.name, picture: null, score: Math.round(a.score) } } catch { return { id: null, name: a.name, picture: null, score: Math.round(a.score) } } }))
    return found
  }))
  app.get('/api/mixes/artist/:id', wrap(req => artistMix(req.params.id)))
  // "Créer un mix de cet artiste": kept in "Tes mixes" (Pour toi).
  app.post('/api/mixes/artist/:id', wrap(async req => {
    const mix = await artistMix(req.params.id)
    if (!mix.tracks.length) throw Object.assign(new Error('Pas assez de titres pour un mix de cet artiste.'), { status: 404 })
    const pl = playlists.create({ name: `Mix ${mix.artist.name}`, kind: 'mix', meta: { artist: mix.artist, only: true } })
    return withOwned(playlists.addItems(pl.id, mix.tracks))
  }))
  app.get('/api/mixes/mine', wrap(() => playlists.mixes(10)))
  app.post('/api/playlists/:id/keep', wrap(req => playlists.keep(req.params.id, req.body?.saved !== false)))
  app.post('/api/mixes/custom', wrap(async req => {
    const era = ['recent', 'old', 'both'].includes(req.body?.era) ? req.body.era : 'both'
    const mix = await customMix(Array.isArray(req.body?.artists) ? req.body.artists : [], { era })
    const name = `Ton mix · ${mix.artists.map(a => a.name).join(' + ')}`
    const pl = playlists.create({ name, kind: 'mix', meta: { artists: mix.artists, era } })
    return withOwned(playlists.addItems(pl.id, mix.tracks))
  }))

  // -------------------------------------------------------------- follows
  app.get('/api/dislikes', wrap(() => dislikes.list()))
  app.post('/api/dislikes', wrap(req => dislikes.add(req.body || {})))
  app.post('/api/dislikes/remove', wrap(req => dislikes.remove(req.body || {})))
  app.get('/api/follows', wrap(async req => { await follows.refresh({ force: req.query.force === '1' }).catch(() => {}); return follows.list() }))
  app.post('/api/follows', wrap(req => follows.follow(req.body || {})))
  app.delete('/api/follows/:id', wrap(req => follows.unfollow(req.params.id)))
  app.post('/api/follows/:id/seen', wrap(req => follows.seen(req.params.id)))

  // --------------------------------------------------------------- lyrics
  app.get('/api/lyrics', wrap(req => lyrics.find({ title: String(req.query.title || ''), artist: String(req.query.artist || ''), album: String(req.query.album || ''), duration: Number(req.query.duration) || null })))

  // -------------------------------------------------------------- updates
  app.get('/api/update', wrap(req => updates.check({ build: Number(req.query.build) || 0, force: req.query.force === '1' })))
  app.post('/api/update/download', wrap(req => updates.download({ abi: req.body?.abi, build: Number(req.body?.build) || 0 })))
  app.get('/api/update/status', wrap(() => updates.status()))
  app.get('/api/catalogue/find-artist', wrap(async req => { const a = await deezer.findArtist(String(req.query.name || '')); return a ? deezer.artistOf(a) : null }))

  // ----------------------------------------------------------- downloads
  app.get('/api/downloads', wrap(() => downloads.list()))
  app.post('/api/downloads', wrap(req => downloads.enqueue((req.body?.items || []).map(i => (req.body?.play ? { ...i, play: true } : i)))))
  app.get('/api/downloads/wait', wrap(req => downloads.waitFor(String(req.query.deezer_id || ''), Number(req.query.timeout) || 60000)))
  app.post('/api/downloads/:id/cancel', wrap(req => downloads.cancel(req.params.id)))
  app.post('/api/downloads/:id/retry', wrap(req => downloads.retry(req.params.id)))
  app.delete('/api/downloads', wrap(() => downloads.clearFinished()))

  // -------------------------------------------------------------- source
  app.get('/api/source', wrap(() => sources.state()))
  app.post('/api/source/install', wrap(() => sources.installDeezer()))
  app.post('/api/sources/check', wrap(() => sources.autoVerify().then(() => sources.state())))
  app.post('/api/source/verify-info', wrap(req => sources.verifyInfo(req.body?.id)))
  app.get('/api/sources', wrap(() => sources.state()))
  app.post('/api/sources/:id/install', wrap(req => sources.install(req.params.id)))
  app.post('/api/sources/:id/enabled', wrap(req => sources.setEnabled(req.params.id, !!req.body?.enabled)))
  app.put('/api/sources/order', wrap(req => sources.setOrder(req.body?.ids)))
  // Tests: install an addon package directly.
  if (process.env.ECHO_DEV === '1') app.post('/api/source/upload', wrap(async req => sources.service().install({ buffer: Buffer.from(String(req.body?.data || ''), 'base64') })))
  app.post('/api/source/verify-complete', wrap(req => sources.verifyComplete(req.body || {})))

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }))

  // Development / tests: the interface from the same server.
  if (process.env.ECHO_UI_DIR && fs.existsSync(process.env.ECHO_UI_DIR)) {
    app.use(express.static(process.env.ECHO_UI_DIR))
    app.get('*', (req, res) => res.sendFile(path.join(process.env.ECHO_UI_DIR, 'index.html')))
  }
  return app
}

module.exports = { createApp, TOKEN }
