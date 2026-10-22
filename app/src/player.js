// The player. A song is either yours (local_id: plays at once, offline) or
// from the catalogue (deezer_id): then it's downloaded first and plays as soon
// as it's in your library. In a mix, an album or a playlist the next song is
// downloaded while this one plays, so the music keeps going; a song picked
// from a search is downloaded alone.
import { create } from 'zustand'
import { api, streamUrl, artUrl, playUrl } from './api'
import { useApp, pokeDownloads } from './store'
import { engine, onEngine } from './engine'
import { lanAddress, requestNotifications } from './native'
import { t } from './i18n'

export const keyOf = s => (s.local_id ? `l:${s.local_id}` : `d:${s.deezer_id}`)
/** The id the phone's player knows a song by. */
const engineId = s => (s.local_id ? s.local_id : `d:${s.deezer_id}`)
const isEngineId = (s, id) => !!s && (s.local_id === id || (s.deezer_id && `d:${s.deezer_id}` === id))
// Catalogue songs carry Deezer's cover; library songs their own art, when they have some.
export const coverOf = s => s?.cover || (s?.local_id && s.has_art !== 0 && s.has_art !== false ? artUrl(s.local_id) : s?.cover_small || null)

/** What the codec badge says: FLAC, ALAC, MP3, AAC… and whether it's lossless. */
export function codecLabel(track) {
  const c = String(track?.codec || '').toLowerCase()
  if (!c) return null
  if (/flac/.test(c)) return { label: 'FLAC', lossless: true, hires: (track.bits || 0) > 16 || (track.sample_rate || 0) > 48000 }
  if (/alac/.test(c)) return { label: 'ALAC', lossless: true }
  if (/pcm|wav/.test(c)) return { label: 'WAV', lossless: true }
  if (/wavpack/.test(c)) return { label: 'WV', lossless: true }
  if (/ape|monkey/.test(c)) return { label: 'APE', lossless: true }
  if (/layer 3|mp3/.test(c)) return { label: 'MP3', lossless: false }
  if (/aac|mp4a/.test(c)) return { label: 'AAC', lossless: false }
  if (/opus/.test(c)) return { label: 'OPUS', lossless: false }
  if (/vorbis/.test(c)) return { label: 'OGG', lossless: false }
  return { label: c.toUpperCase().slice(0, 5), lossless: !!track.lossless }
}
/** The type Cast receivers need. Formats a TV can't decode arrive as FLAC. */
function mimeOf(track) {
  const c = String(track?.codec || '').toLowerCase()
  if (/layer 3|mp3/.test(c)) return 'audio/mpeg'
  if (/aac|mp4a/.test(c)) return 'audio/mp4'
  if (/opus|vorbis/.test(c)) return 'audio/ogg'
  if (/pcm|wav/.test(c) && !/be/.test(c)) return 'audio/wav'
  return 'audio/flac'
}

export const usePlayer = create(() => ({
  queue: [], index: -1,
  context: null, // where the queue comes from: 'search' plays only what you picked
  playing: false, // what the person wants
  loading: false, // fetching the song (downloading) or buffering
  position: 0, duration: 0,
  shuffle: false, repeat: 'off',
  liked: {}, // local id -> bool
  details: {}, // local id -> track (codec, bits…)
  fullOpen: false,
  failed: null, // { title, error } when a song couldn't be got
  cast: { base: null, device: null, casting: false },
}))
const get = () => usePlayer.getState()
const set = patch => usePlayer.setState(patch)

export const current = () => { const s = get(); return s.queue[s.index] || null }

// ------------------------------------------------------------- listening time
let listened = { id: null, seconds: 0, last: null }
function flushListen() {
  if (listened.id && listened.seconds >= 10) api.played(listened.id, Math.round(listened.seconds)).catch(() => {})
  listened = { id: null, seconds: 0, last: null }
}

onEngine(e => {
  if (e.type === 'time') {
    const now = e.position || 0
    if (listened.last !== null && get().playing) {
      const d = now - listened.last
      if (d > 0 && d < 2) listened.seconds += d
    }
    listened.last = now
    set({ position: now, duration: e.duration || current()?.duration || 0 })
  } else if (e.type === 'state') {
    set({ loading: !!e.buffering, ...(e.playing ? { playing: true } : {}), ...(!e.wants && !e.buffering ? { playing: false } : {}) })
  } else if (e.type === 'ended') {
    next(true)
  } else if (e.type === 'advanced') {
    // The native player moved on to the song that was waiting.
    flushListen()
    const s = get()
    const at = s.queue.findIndex((x, i) => i > s.index && isEngineId(x, e.id))
    const index = at >= 0 ? at : s.index + 1
    const song = s.queue[index]
    ++generation
    set({ index, loading: false, failed: null, position: 0, duration: song?.duration || 0 })
    if (song?.local_id) { listened = { id: song.local_id, seconds: 0, last: 0 }; loadDetails(song.local_id) }
    else if (song?.deezer_id) adopt(song)
    afterStart()
  } else if (e.type === 'remote') {
    if (e.action === 'next') next()
    else if (e.action === 'previous') previous()
    else if (e.action === 'jump') {
      // Picked on the car screen (or moved on by the player itself): it plays already.
      flushListen()
      const s = get()
      const after = s.queue.findIndex((x, i) => i > s.index && isEngineId(x, e.id))
      const index = after >= 0 ? after : s.queue.findIndex(x => isEngineId(x, e.id))
      if (index < 0) return
      ++generation
      const song = s.queue[index]
      set({ index, playing: true, loading: false, failed: null, position: 0, duration: song.duration || 0 })
      if (song.local_id) { listened = { id: song.local_id, seconds: 0, last: 0 }; loadDetails(song.local_id) } else adopt(song)
      afterStart()
    }
  } else if (e.type === 'error') {
    const song = current()
    if (!song) return
    set({ playing: false, loading: false })
    useApp.getState().toast(t('« {title} » ne se lit pas.', { title: song.title }), { label: t('Suivant'), run: () => next() })
  } else if (e.type === 'cast') {
    set({ cast: { ...get().cast, casting: !!e.casting, device: e.casting ? get().cast.device : null } })
    // On the TV, the song needs Écho's Wi-Fi address (and to be on the phone).
    if (e.casting && e.reload) resumeOnTv(e)
    // Casting over: the Wi-Fi server closes.
    if (!e.casting && get().cast.base) { set({ cast: { ...get().cast, base: null } }); api.castStop().catch(() => {}) }
  }
})

// ---------------------------------------------------------------- downloads
/**
 * Waits for the download of `deezerId`; resolves with the library id. The
 * server answers when it's done (no timers: they nearly stop when the phone
 * is locked, the music must go on).
 */
async function waitForDownload(deezerId, isCurrent) {
  const started = Date.now()
  while (Date.now() - started < 20 * 60 * 1000) {
    if (!isCurrent()) return null
    const job = await api.waitDownload(deezerId, 45000).catch(() => null)
    if (!isCurrent()) return null
    if (job?.status === 'done' && job.track_id) { useApp.getState().refreshDownloads(); return job.track_id }
    if (job && ['error', 'cancelled'].includes(job.status)) throw Object.assign(new Error(job.error || 'cancelled'), { job })
    if (!job) await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error('timeout')
}

/** The song as one of yours: downloaded first when needed. */
async function ensureLocal(song, isCurrent) {
  if (song.local_id) return song.local_id
  if (!song.deezer_id) throw new Error('no source')
  const source = useApp.getState().source || await useApp.getState().refreshSource()
  if (!source?.installed) throw Object.assign(new Error('NO_SOURCE'), { code: 'NO_SOURCE' })
  const [job] = await api.download([song], { play: true, origin: originOf(get().context) })
  pokeDownloads()
  if (job?.track_id) return job.track_id
  return waitForDownload(song.deezer_id, isCurrent)
}

function markLocal(key, localId) {
  const { queue } = get()
  set({ queue: queue.map(s => (keyOf(s) === key ? { ...s, local_id: localId, has_art: s.cover ? s.has_art : 1 } : s)) })
}

/** How many songs are got ready ahead: 2 in a playlist or a mix, 1 elsewhere, none after a search. */
const aheadCount = context => (context === 'search' ? 0 : context === 'playlist' || context === 'mix' ? 2 : 1)
/** Songs heard in a mix are on the phone for 48 h, unless you keep them. */
const originOf = context => (context === 'mix' ? 'mix' : null)

/**
 * While a song plays, the next ones are downloaded, one after the other
 * (2 ahead in a playlist or a mix, 1 elsewhere).
 */
let prefetching = null
function prefetch() {
  const { queue, index, context, repeat } = get()
  const count = aheadCount(context)
  if (!count || !useApp.getState().source?.installed) return
  const order = repeat === 'all' ? [...queue.slice(index + 1), ...queue.slice(0, index + 1)] : queue.slice(index + 1)
  const want = order.slice(0, count).filter(x => !x.local_id && x.deezer_id)
  if (!want.length || prefetching) return
  const run = async () => {
    for (const song of want) {
      const key = keyOf(song)
      const stillAhead = () => { const s = get(); return s.queue.slice(s.index + 1, s.index + 1 + count).some(x => keyOf(x) === key) }
      if (!stillAhead()) continue
      prefetching = key
      const [job] = await api.download([song], { play: true, origin: originOf(context) }).catch(() => [])
      pokeDownloads()
      const localId = job?.track_id || await waitForDownload(song.deezer_id, stillAhead).catch(() => null)
      if (localId) { markLocal(key, localId); queueNextInEngine(); shareLibrary() }
    }
  }
  run().catch(() => {}).finally(() => { prefetching = null; if (get().index === index) return; prefetch() })
}

async function loadDetails(id) {
  if (get().details[id] && id in get().liked) return get().details[id]
  try {
    const tr = await api.track(id)
    set({ details: { ...get().details, [id]: tr }, liked: { ...get().liked, [id]: !!tr.liked } })
    return tr
  } catch { return null }
}

/** A song the phone's player fetched itself (downloaded meanwhile): it's yours now. */
async function adopt(song) {
  const job = await api.waitDownload(song.deezer_id, 120000).catch(() => null)
  if (job?.status === 'done' && job.track_id) {
    markLocal(keyOf(song), job.track_id)
    if (current() && current().local_id === job.track_id) { listened = { id: job.track_id, seconds: 0, last: 0 }; loadDetails(job.track_id) }
    pokeDownloads()
  }
}

/**
 * What the engine plays for a song. Yours: from the library. From the
 * catalogue: an address that downloads it first, so the phone's player can
 * go on by itself (screen locked) without waiting for the app.
 */
async function itemFor(song, { remote = false } = {}) {
  if (!song?.local_id && remote && song?.deezer_id && !get().cast.base) {
    return {
      id: engineId(song), url: playUrl(song, playExtras(song)), castUrl: null, mime: null,
      title: song.title || '', artist: song.artist || '', album: song.album || '',
      artwork: coverOf(song), castArtwork: song.cover || null, duration: song.duration || 0,
    }
  }
  if (!song?.local_id) return null
  const tr = get().details[song.local_id] || await loadDetails(song.local_id)
  const base = get().cast.base
  return {
    id: song.local_id,
    url: streamUrl(song.local_id),
    castUrl: base ? `${base}/stream/${encodeURIComponent(song.local_id)}` : null,
    mime: mimeOf(tr),
    title: song.title || tr?.title || '',
    artist: song.artist || tr?.artist || '',
    album: song.album || tr?.album || '',
    artwork: coverOf({ ...song, has_art: tr ? tr.has_art : song.has_art }),
    castArtwork: song.cover || (base && tr?.has_art ? `${base}/art/${encodeURIComponent(song.local_id)}` : null),
    duration: song.duration || tr?.duration || 0,
  }
}

/**
 * The rest of the queue, handed to the phone's player (up to 300 songs): they
 * follow each other without the app, songs to download included (each one
 * is fetched when its turn comes near). The phone stops the app while the
 * screen is locked, so the player must have the whole list from the start.
 * A song picked from a search stays alone.
 */
/** The songs the TV may fetch from the phone: the one playing and those coming next. */
async function allowOnTv() {
  const s = get()
  if (!s.cast.base) return
  const ids = s.queue.slice(Math.max(0, s.index), Math.max(0, s.index) + 301).map(x => x.local_id).filter(Boolean)
  await api.castAllow(ids).catch(() => {})
}

async function queueNextInEngine() {
  const s = get()
  await allowOnTv()
  if (s.index < 0 || s.repeat === 'one') { engine.setUpcoming([]); return }
  const after = s.queue.slice(s.index + 1)
  const ahead = (s.repeat === 'all' ? [...after, ...s.queue.slice(0, s.index + 1)] : after).slice(0, 300)
  const remote = s.context !== 'search' && !!useApp.getState().source?.installed
  const items = []
  for (const [i, song] of ahead.entries()) {
    // The next one in full (its format, for a gapless start); the others light.
    const item = i === 0 ? await itemFor(song, { remote }) : lightItem(song, { remote })
    if (!item) break // the order matters: stop at a song that can't be got
    items.push(item)
  }
  engine.setUpcoming(items)
}

/** For a song the phone's player fetches: where it comes from, and the next ones to get ready. */
function playExtras(song) {
  const s = get()
  const at = s.queue.findIndex(x => keyOf(x) === keyOf(song))
  const ahead = at < 0 ? [] : s.queue.slice(at + 1, at + 1 + aheadCount(s.context)).filter(x => !x.local_id && x.deezer_id).map(x => x.deezer_id)
  return { origin: originOf(s.context), ahead }
}

/** A song for the queue without asking the library for its details. */
function lightItem(song, { remote = false } = {}) {
  const base = get().cast.base
  if (song?.local_id) {
    const tr = get().details[song.local_id]
    return {
      id: song.local_id, url: streamUrl(song.local_id), castUrl: base ? `${base}/stream/${encodeURIComponent(song.local_id)}` : null,
      mime: tr || base ? mimeOf(tr) : null, title: song.title || '', artist: song.artist || '', album: song.album || '',
      artwork: coverOf(song), castArtwork: song.cover || null, duration: song.duration || 0,
    }
  }
  if (remote && song?.deezer_id && !base) {
    return { id: engineId(song), url: playUrl(song, playExtras(song)), castUrl: null, mime: null, title: song.title || '', artist: song.artist || '', album: song.album || '', artwork: coverOf(song), castArtwork: song.cover || null, duration: song.duration || 0 }
  }
  return null
}

/** The songs coming next that are on the phone: what a car screen lists. */
function shareLibrary() {
  const { queue, index } = get()
  if (index < 0) return
  const items = queue.slice(index, index + 60).filter(s => s.local_id).map(s => ({
    id: s.local_id, url: streamUrl(s.local_id), title: s.title || '', artist: s.artist || '', album: s.album || '',
    artwork: coverOf(s), duration: s.duration || 0,
  }))
  engine.setLibrary(items)
}

function afterStart() {
  prefetch()
  queueNextInEngine()
  shareLibrary()
  saveSession()
  useApp.getState().libraryChanged()
}

// ------------------------------------------------------------------ playing
let generation = 0
let askedNotifications = false

async function playAt(index, { autoplay = true, position = 0 } = {}) {
  const { queue } = get()
  if (index < 0 || index >= queue.length) return
  flushListen()
  const gen = ++generation
  const isCurrent = () => gen === generation
  const song = queue[index]
  if (!askedNotifications) { askedNotifications = true; requestNotifications() }
  set({ index, playing: autoplay, loading: true, position: 0, duration: song.duration || 0, failed: null })
  let localId
  try {
    localId = await ensureLocal(song, isCurrent)
  } catch (error) {
    if (!isCurrent()) return
    // Stop here: never jump to another song on your behalf.
    set({ loading: false, playing: false, failed: { title: song.title, error: error.message } })
    const app = useApp.getState()
    if (error.code === 'NO_SOURCE') {
      app.toast(t('Pour télécharger ce titre, installe d’abord une source (Réglages).'), { label: t('Réglages'), run: () => app.open({ type: 'sources' }) })
      return
    }
    if (error.job?.message?.startsWith('verify') || /verif|captcha|VERIFY/i.test(error.message)) {
      app.toast(t('La source demande une vérification.'), { label: t('Vérifier'), run: () => app.open({ type: 'sources', verify: true }) })
      return
    }
    app.toast(t('« {title} » n’a pas pu être téléchargé.', { title: song.title }), { label: t('Réessayer'), run: () => playAt(index, { autoplay: true }) })
    return
  }
  if (!isCurrent() || !localId) return
  markLocal(keyOf(song), localId)
  listened = { id: localId, seconds: 0, last: 0 }
  await allowOnTv()
  const item = await itemFor(get().queue[index])
  if (!isCurrent()) return
  try {
    await engine.load(item, null, { play: get().playing, position })
    if (!get().playing) set({ loading: false })
  } catch {
    set({ playing: false, loading: false })
  }
  afterStart()
}

function shuffled(list, keepFirst) {
  const rest = list.filter((_, i) => i !== keepFirst)
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
  return keepFirst >= 0 ? [list[keepFirst], ...rest] : rest
}

/**
 * Plays `songs` from `start` (or shuffled). `context`: 'search' (only what
 * you picked is downloaded), anything else (mix, album, playlist…): the next
 * songs are downloaded ahead.
 */
export function playList(songs, start = 0, { shuffle = false, context = 'list' } = {}) {
  const list = songs.filter(s => s && (s.local_id || s.deezer_id))
  if (!list.length) return
  const first = Math.max(0, Math.min(start, list.length - 1))
  const queue = shuffle ? shuffled(list, -1) : list
  set({ queue, shuffle, index: -1, context })
  playAt(shuffle ? 0 : first)
}

export function toggle() {
  const s = get()
  if (s.index < 0) { if (s.queue.length) playAt(0); return }
  if (s.failed) { playAt(s.index); return }
  if (s.playing) { engine.pause(); set({ playing: false }) }
  else if (listened.id) { set({ playing: true }); engine.play() }
  else playAt(s.index, { position: s.position })
}

export function next(auto = false) {
  const s = get()
  if (auto && s.repeat === 'one') { engine.seek(0); engine.play(); return }
  if (s.index + 1 < s.queue.length) playAt(s.index + 1, { autoplay: s.playing || auto })
  else if (s.repeat === 'all' && s.queue.length) playAt(0, { autoplay: true })
  else if (auto) { flushListen(); set({ playing: false }) }
}

export function previous() {
  const s = get()
  if (s.position > 4 || s.index <= 0) { engine.seek(0); set({ position: 0 }); return }
  playAt(s.index - 1, { autoplay: s.playing })
}

export function seek(seconds) { if (Number.isFinite(seconds)) { engine.seek(seconds); set({ position: Math.max(0, seconds) }) } }
export function jumpTo(index) { playAt(index, { autoplay: true }) }

export function playNext(songs) {
  const s = get()
  const add = songs.filter(x => x && (x.local_id || x.deezer_id))
  if (s.index < 0) { playList(add, 0); return }
  set({ queue: [...s.queue.slice(0, s.index + 1), ...add, ...s.queue.slice(s.index + 1)], context: s.context === 'search' ? 'list' : s.context })
  prefetch(); queueNextInEngine()
}
export function addToQueue(songs) {
  const s = get()
  const add = songs.filter(x => x && (x.local_id || x.deezer_id))
  if (s.index < 0) { playList(add, 0); return }
  set({ queue: [...s.queue, ...add], context: s.context === 'search' ? 'list' : s.context })
  prefetch(); queueNextInEngine()
}
export function removeFromQueue(i) {
  const s = get()
  if (i === s.index) return
  set({ queue: s.queue.filter((_, k) => k !== i), index: i < s.index ? s.index - 1 : s.index })
  queueNextInEngine()
}

export function toggleShuffle() {
  const s = get()
  if (s.index < 0) { set({ shuffle: !s.shuffle }); return }
  const done = s.queue.slice(0, s.index + 1)
  const rest = s.queue.slice(s.index + 1)
  set({ shuffle: !s.shuffle, queue: [...done, ...(s.shuffle ? rest : shuffled(rest, -1))] })
  queueNextInEngine()
}
export function cycleRepeat() {
  const order = ['off', 'all', 'one']
  set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] })
  queueNextInEngine()
}

export async function toggleLike(localId) {
  if (!localId) return
  const liked = !get().liked[localId]
  set({ liked: { ...get().liked, [localId]: liked } })
  try { await api.like(localId, liked); useApp.getState().libraryChanged() } catch { set({ liked: { ...get().liked, [localId]: !liked } }) }
}

export const openFull = open => set({ fullOpen: open })

/** Swiped the mini player away: the music stops and the player goes. */
export function stopPlayer() {
  flushListen(); saveSession()
  ++generation
  engine.stop()
  set({ queue: [], index: -1, playing: false, loading: false, position: 0, duration: 0, fullOpen: false, failed: null })
  try { localStorage.removeItem(SESSION) } catch {}
}
/** "Annuler" after swiping it away: the same song, where it was, paused. */
export function restorePlayer({ queue, index, position }) {
  if (!queue?.length || index < 0) return
  set({ queue, index: -1 })
  playAt(index, { autoplay: false, position })
}

// ------------------------------------------------------------------ casting
/** Devices on the Wi-Fi (TV, Google Nest…). Scanning runs while the sheet is open. */
export async function castScan(on) { return engine.castScan(on) }

export async function castTo(device) {
  const app = useApp.getState()
  try {
    // The TV fetches the music from the phone over the Wi-Fi.
    if (!get().cast.base) {
      const { ip } = await lanAddress()
      if (!ip) throw new Error(t('Connecte le téléphone au Wi-Fi pour diffuser.'))
      const { base } = await api.castStart(ip)
      set({ cast: { ...get().cast, base } })
    }
    set({ cast: { ...get().cast, device } })
    const s = get()
    const song = current()
    if (song?.local_id) {
      await allowOnTv()
      const item = await itemFor(song)
      await engine.load(item, null, { play: s.playing, position: engine.position })
      queueNextInEngine()
    }
    await engine.castConnect(device.id)
  } catch (e) {
    app.toast(e.message || String(e))
  }
}
/** Casting started (from Écho or from Android's own menu): the song goes on, on the TV. */
let tvResuming = false
async function resumeOnTv(e) {
  if (tvResuming) return
  tvResuming = true
  try {
    if (!get().cast.base) {
      const { ip } = await lanAddress()
      if (!ip) throw new Error(t('Connecte le téléphone au Wi-Fi pour diffuser.'))
      const { base } = await api.castStart(ip)
      set({ cast: { ...get().cast, base } })
    }
    let song = current()
    if (!song) return
    const key = keyOf(song)
    if (!song.local_id) {
      useApp.getState().toast(t('« {title} » se télécharge, puis passe sur la TV.', { title: song.title }))
      const id = await ensureLocal(song, () => current() && keyOf(current()) === key)
      if (!id) return
      markLocal(key, id)
      song = current()
      if (!song || keyOf(song) !== key) return
    }
    await allowOnTv()
    const item = await itemFor(song)
    await engine.load(item, null, { play: e.wants !== false, position: e.position || 0 })
    queueNextInEngine()
  } catch (err) {
    useApp.getState().toast(err?.message || String(err))
  } finally { tvResuming = false }
}

export async function stopCasting() {
  await engine.castDisconnect()
  set({ cast: { ...get().cast, device: null, casting: false } })
}

// ---------------------------------------------------------------- equalizer
export function applyEqualizer(eq) { engine.setEqualizer(eq || { enabled: false }) }

// ---------------------------------------------------- the last session back
const SESSION = 'echo-session'
function saveSession() {
  try {
    const s = get()
    localStorage.setItem(SESSION, JSON.stringify({ queue: s.queue.slice(0, 300), index: s.index, shuffle: s.shuffle, repeat: s.repeat, context: s.context, position: s.position }))
  } catch {}
}
export function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION) || 'null')
    if (!saved?.queue?.length || saved.index < 0) return
    const song = saved.queue[saved.index]
    set({ queue: saved.queue, shuffle: !!saved.shuffle, repeat: saved.repeat || 'off', context: saved.context || 'list', index: song?.local_id ? saved.index : -1, position: saved.position || 0, duration: song?.duration || 0, playing: false })
    if (song?.local_id) loadDetails(song.local_id)
  } catch {}
}
window.addEventListener('pagehide', () => { flushListen(); saveSession() })
setInterval(saveSession, 15000)
