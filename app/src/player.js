// The player. A song is either yours (local_id: plays at once, offline) or
// from the catalogue (deezer_id): then it's downloaded first and plays as soon
// as it's in your library. The next two songs of the queue are downloaded
// ahead, so a mix keeps going without waiting.
import { create } from 'zustand'
import { api, streamUrl, artUrl } from './api'
import { useApp, pokeDownloads } from './store'
import { mediaSession } from './native'
import { t } from './i18n'

const audio = new Audio()
audio.preload = 'auto'

export const keyOf = s => (s.local_id ? `l:${s.local_id}` : `d:${s.deezer_id}`)
// Catalogue songs carry Deezer's cover; library songs their own art, when they have some.
export const coverOf = s => s?.cover || (s?.local_id && s.has_art !== 0 && s.has_art !== false ? artUrl(s.local_id) : s?.cover_small || null)

export const usePlayer = create(() => ({
  queue: [], index: -1,
  playing: false, // what the person wants
  loading: false, // fetching the song (downloading) or buffering
  position: 0, duration: 0,
  shuffle: false, repeat: 'off',
  liked: {}, // local id -> bool
  fullOpen: false,
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
audio.addEventListener('timeupdate', () => {
  const now = audio.currentTime
  if (listened.last !== null && !audio.paused) {
    const d = now - listened.last
    if (d > 0 && d < 2) listened.seconds += d
  }
  listened.last = now
  set({ position: now, duration: Number.isFinite(audio.duration) ? audio.duration : (current()?.duration || 0) })
  if (Math.floor(now) % 2 === 0) mediaSession.position(audio.duration, now)
})
audio.addEventListener('seeked', () => { listened.last = audio.currentTime })
audio.addEventListener('playing', () => { set({ loading: false }); mediaSession.state(true) })
audio.addEventListener('waiting', () => set({ loading: true }))
audio.addEventListener('pause', () => { if (!audio.ended) mediaSession.state(false) })
audio.addEventListener('ended', () => next(true))
audio.addEventListener('error', () => {
  const song = current()
  if (!audio.src || !song) return
  useApp.getState().toast(t('« {title} » ne se lit pas. Titre suivant.', { title: song.title }))
  next(true)
})

// ---------------------------------------------------------------- downloads
/** Waits for the download of `deezerId`; resolves with the library id. */
async function waitForDownload(deezerId, isCurrent) {
  const started = Date.now()
  while (Date.now() - started < 20 * 60 * 1000) {
    if (!isCurrent()) return null
    const list = await useApp.getState().refreshDownloads()
    const job = list.find(d => d.deezer_id === String(deezerId) && ['queued', 'downloading', 'saving', 'done', 'error', 'cancelled'].includes(d.status))
    if (job?.status === 'done' && job.track_id) return job.track_id
    if (job && ['error', 'cancelled'].includes(job.status)) throw Object.assign(new Error(job.error || 'cancelled'), { job })
    await new Promise(r => setTimeout(r, 700))
  }
  throw new Error('timeout')
}

/** The song as one of yours: downloaded first when needed. */
async function ensureLocal(song, isCurrent) {
  if (song.local_id) return song.local_id
  if (!song.deezer_id) throw new Error('no source')
  const source = useApp.getState().source || await useApp.getState().refreshSource()
  if (!source?.installed) throw Object.assign(new Error('NO_SOURCE'), { code: 'NO_SOURCE' })
  const [job] = await api.download([song])
  pokeDownloads()
  if (job?.track_id) return job.track_id
  return waitForDownload(song.deezer_id, isCurrent)
}

function markLocal(key, localId) {
  const { queue } = get()
  set({ queue: queue.map(s => (keyOf(s) === key ? { ...s, local_id: localId, has_art: 1 } : s)) })
}

/** Gets the next songs ready while this one plays. */
function prefetch() {
  const { queue, index } = get()
  const ahead = queue.slice(index + 1, index + 3).filter(s => !s.local_id && s.deezer_id)
  if (!ahead.length || !useApp.getState().source?.installed) return
  api.download(ahead).then(jobs => {
    jobs.forEach((job, i) => { if (job?.track_id) markLocal(keyOf(ahead[i]), job.track_id) })
    pokeDownloads()
  }).catch(() => {})
}

// ------------------------------------------------------------------ playing
let generation = 0

async function playAt(index, { autoplay = true } = {}) {
  const { queue } = get()
  if (index < 0 || index >= queue.length) return
  flushListen()
  const gen = ++generation
  const isCurrent = () => gen === generation
  const song = queue[index]
  audio.pause()
  set({ index, playing: autoplay, loading: true, position: 0, duration: song.duration || 0 })
  mediaSession.metadata({ title: song.title, artist: song.artist, album: song.album || '', artwork: coverOf(song) })
  let localId
  try {
    localId = await ensureLocal(song, isCurrent)
  } catch (error) {
    if (!isCurrent()) return
    set({ loading: false })
    const app = useApp.getState()
    if (error.code === 'NO_SOURCE') {
      set({ playing: false })
      app.toast(t('Pour télécharger ce titre, installe d’abord la source Deezer (Réglages).'), { label: t('Réglages'), run: () => app.open({ type: 'settings' }) })
      return
    }
    if (/verif|captcha|VERIFY|session/i.test(error.message)) {
      set({ playing: false })
      app.toast(t('La source Deezer demande une vérification.'), { label: t('Vérifier'), run: () => app.open({ type: 'settings', verify: true }) })
      return
    }
    app.toast(t('« {title} » n’a pas pu être téléchargé : {error}', { title: song.title, error: error.message }))
    if (index + 1 < get().queue.length) playAt(index + 1, { autoplay })
    else set({ playing: false })
    return
  }
  if (!isCurrent() || !localId) return
  markLocal(keyOf(song), localId)
  useApp.getState().libraryChanged()
  listened = { id: localId, seconds: 0, last: 0 }
  audio.src = streamUrl(localId)
  const updated = get().queue[index]
  mediaSession.metadata({ title: updated.title, artist: updated.artist, album: updated.album || '', artwork: coverOf(updated) })
  loadLiked(localId)
  if (get().playing) audio.play().catch(() => set({ playing: false, loading: false }))
  else set({ loading: false })
  prefetch()
  saveSession()
}

async function loadLiked(id) {
  if (id in get().liked) return
  try { const tr = await api.track(id); set({ liked: { ...get().liked, [id]: !!tr.liked } }) } catch {}
}

function shuffled(list, keepFirst) {
  const rest = list.filter((_, i) => i !== keepFirst)
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
  return keepFirst >= 0 ? [list[keepFirst], ...rest] : rest
}

/** Plays `songs` from `start` (or shuffled). */
export function playList(songs, start = 0, { shuffle = false } = {}) {
  const list = songs.filter(s => s && (s.local_id || s.deezer_id))
  if (!list.length) return
  const first = Math.max(0, Math.min(start, list.length - 1))
  const queue = shuffle ? shuffled(list, start >= 0 && !shuffle ? first : -1) : list
  set({ queue, shuffle, index: -1 })
  playAt(shuffle ? 0 : first)
}

export function toggle() {
  const s = get()
  if (s.index < 0) { if (s.queue.length) playAt(0); return }
  if (s.playing) { audio.pause(); set({ playing: false }) }
  else if (audio.src) { set({ playing: true }); audio.play().catch(() => set({ playing: false })) }
  else playAt(s.index)
}

export function next(auto = false) {
  const s = get()
  if (auto && s.repeat === 'one' && audio.src) { audio.currentTime = 0; audio.play().catch(() => {}); return }
  if (s.index + 1 < s.queue.length) playAt(s.index + 1, { autoplay: s.playing || auto })
  else if (s.repeat === 'all' && s.queue.length) playAt(0, { autoplay: true })
  else if (auto) { flushListen(); set({ playing: false }); mediaSession.state(false) }
}

export function previous() {
  const s = get()
  if (audio.currentTime > 4 || s.index <= 0) { audio.currentTime = 0; return }
  playAt(s.index - 1, { autoplay: s.playing })
}

export function seek(seconds) { if (audio.src && Number.isFinite(seconds)) { audio.currentTime = Math.max(0, seconds); set({ position: audio.currentTime }) } }
export function jumpTo(index) { playAt(index, { autoplay: true }) }

export function playNext(songs) {
  const s = get()
  const add = songs.filter(x => x && (x.local_id || x.deezer_id))
  if (s.index < 0) { playList(add, 0); return }
  const queue = [...s.queue.slice(0, s.index + 1), ...add, ...s.queue.slice(s.index + 1)]
  set({ queue })
  prefetch()
}
export function addToQueue(songs) {
  const s = get()
  const add = songs.filter(x => x && (x.local_id || x.deezer_id))
  if (s.index < 0) { playList(add, 0); return }
  set({ queue: [...s.queue, ...add] })
  prefetch()
}
export function removeFromQueue(i) {
  const s = get()
  if (i === s.index) return
  set({ queue: s.queue.filter((_, k) => k !== i), index: i < s.index ? s.index - 1 : s.index })
}

export function toggleShuffle() {
  const s = get()
  if (s.index < 0) { set({ shuffle: !s.shuffle }); return }
  const done = s.queue.slice(0, s.index + 1)
  const rest = s.queue.slice(s.index + 1)
  set({ shuffle: !s.shuffle, queue: [...done, ...(s.shuffle ? rest : shuffled(rest, -1))] })
}
export function cycleRepeat() {
  const order = ['off', 'all', 'one']
  set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] })
}

export async function toggleLike(localId) {
  if (!localId) return
  const liked = !get().liked[localId]
  set({ liked: { ...get().liked, [localId]: liked } })
  try { await api.like(localId, liked); useApp.getState().libraryChanged() } catch { set({ liked: { ...get().liked, [localId]: !liked } }) }
}

export const openFull = open => set({ fullOpen: open })

// ------------------------------------------------------------- media keys
mediaSession.actions({
  play: () => { if (!get().playing) toggle() },
  pause: () => { if (get().playing) toggle() },
  nexttrack: () => next(),
  previoustrack: () => previous(),
  seekto: d => seek(Number(d.seekTime ?? d.seek_time ?? 0)),
  stop: () => { audio.pause(); set({ playing: false }) },
})

// ---------------------------------------------------- the last session back
const SESSION = 'echo-session'
function saveSession() {
  try {
    const s = get()
    localStorage.setItem(SESSION, JSON.stringify({ queue: s.queue.slice(0, 300), index: s.index, shuffle: s.shuffle, repeat: s.repeat }))
  } catch {}
}
export function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION) || 'null')
    if (!saved?.queue?.length || saved.index < 0) return
    set({ queue: saved.queue, shuffle: !!saved.shuffle, repeat: saved.repeat || 'off', index: -1 })
    const song = saved.queue[saved.index]
    if (song?.local_id) {
      set({ index: saved.index, duration: song.duration || 0 })
      audio.src = streamUrl(song.local_id)
      listened = { id: song.local_id, seconds: 0, last: 0 }
      mediaSession.metadata({ title: song.title, artist: song.artist, album: song.album || '', artwork: coverOf(song) })
      loadLiked(song.local_id)
    }
  } catch {}
}
window.addEventListener('pagehide', () => { flushListen(); saveSession() })
setInterval(saveSession, 15000)
