// The sound: on the phone, Écho's native player (ExoPlayer in a media
// service: notification, lock screen, headset buttons, Cast, equalizer); in a
// browser (tests), an <audio> element with Web Audio filters.
// Events: time, state, ended, advanced, remote, error, cast, devices.
import { isNative, EchoPlayer } from './native'

const listeners = new Set()
const emit = (type, data = {}) => { for (const fn of listeners) { try { fn({ type, ...data }) } catch {} } }
export const onEngine = fn => { listeners.add(fn); return () => listeners.delete(fn) }

export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

// ---------------------------------------------------------------- native
function nativeEngine() {
  let polling = null
  let last = { playing: false, position: 0, duration: 0 }
  const poll = async () => {
    try {
      const s = await EchoPlayer.status()
      last = s
      emit('time', { position: s.position || 0, duration: s.duration || 0 })
    } catch {}
  }
  const startPolling = () => { if (!polling) polling = setInterval(() => { if (!document.hidden) poll() }, 500) }
  EchoPlayer.addListener('player', e => {
    const { type, ...data } = e || {}
    if (type === 'state') { last = { ...last, ...data }; emit('state', { playing: !!data.playing, wants: !!data.wants, buffering: !!data.buffering }); emit('time', { position: data.position || 0, duration: data.duration || 0 }) }
    else emit(type, data)
  })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() })
  return {
    native: true,
    async load(item, next, { play = true, position = 0 } = {}) { startPolling(); await EchoPlayer.load({ item, next: next || null, play, position }) },
    setNext: next => EchoPlayer.setNext({ next: next || null }).catch(() => {}),
    setLibrary: items => EchoPlayer.setLibrary({ items }).catch(() => {}),
    play: () => EchoPlayer.play().catch(() => {}),
    pause: () => EchoPlayer.pause().catch(() => {}),
    seek: position => EchoPlayer.seek({ position }).catch(() => {}),
    stop: () => EchoPlayer.stop().catch(() => {}),
    setEqualizer: ({ enabled, bands, preamp }) => EchoPlayer.setEqualizer({ enabled: !!enabled, bands: bands || [], preamp: preamp || 0 }).catch(() => {}),
    castScan: on => EchoPlayer.castScan({ on }).then(r => r.devices || []).catch(() => []),
    castConnect: id => EchoPlayer.castConnect({ id }),
    castDisconnect: () => EchoPlayer.castDisconnect().catch(() => {}),
    get position() { return last.position || 0 },
  }
}

// ------------------------------------------------------------------- web
function webEngine() {
  const audio = new Audio()
  audio.preload = 'auto'
  audio.crossOrigin = 'anonymous'
  let next = null
  let graph = null
  let eq = { enabled: false, bands: BANDS.map(() => 0), preamp: 0 }

  function buildGraph() {
    if (graph || !window.AudioContext) return
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaElementSource(audio)
      const pre = ctx.createGain()
      const filters = BANDS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.1; return b })
      source.connect(pre)
      filters.reduce((prev, f) => { prev.connect(f); return f }, pre).connect(ctx.destination)
      graph = { ctx, pre, filters }
      applyEq()
    } catch {}
  }
  function applyEq() {
    if (!graph) return
    graph.pre.gain.value = Math.pow(10, (eq.enabled ? eq.preamp : 0) / 20)
    graph.filters.forEach((f, i) => { f.gain.value = eq.enabled ? (eq.bands[i] || 0) : 0 })
  }

  audio.addEventListener('timeupdate', () => emit('time', { position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : 0 }))
  audio.addEventListener('playing', () => emit('state', { playing: true, wants: true, buffering: false }))
  audio.addEventListener('waiting', () => emit('state', { playing: false, wants: true, buffering: true }))
  audio.addEventListener('pause', () => { if (!audio.ended) emit('state', { playing: false, wants: false, buffering: false }) })
  audio.addEventListener('ended', () => {
    if (next) {
      const n = next
      next = null
      audio.src = n.url
      audio.play().catch(() => {})
      emit('advanced', { id: n.id })
    } else emit('ended', {})
  })
  audio.addEventListener('error', () => { if (audio.src) emit('error', { error: audio.error?.message || 'unreadable' }) })

  const media = navigator.mediaSession
  if (media) {
    const on = (a, fn) => { try { media.setActionHandler(a, fn) } catch {} }
    on('nexttrack', () => emit('remote', { action: 'next' }))
    on('previoustrack', () => emit('remote', { action: 'previous' }))
    on('play', () => audio.play().catch(() => {}))
    on('pause', () => audio.pause())
  }

  return {
    native: false,
    audio,
    async load(item, n, { play = true, position = 0 } = {}) {
      next = n || null
      audio.src = item.url
      if (position) { try { audio.currentTime = position } catch {} }
      if (media && window.MediaMetadata) media.metadata = new MediaMetadata({ title: item.title, artist: item.artist, album: item.album, artwork: item.artwork ? [{ src: item.artwork, sizes: '512x512' }] : [] })
      if (play) { buildGraph(); graph?.ctx.resume?.(); await audio.play() }
    },
    setNext: n => { next = n || null },
    setLibrary: () => {},
    play: () => { buildGraph(); graph?.ctx.resume?.(); return audio.play().catch(() => {}) },
    pause: () => audio.pause(),
    seek: s => { if (audio.src && Number.isFinite(s)) audio.currentTime = Math.max(0, s) },
    stop: () => { audio.pause(); audio.removeAttribute('src'); next = null },
    setEqualizer: value => { eq = { ...eq, ...value }; applyEq() },
    castScan: async () => [],
    castConnect: async () => { throw new Error('Cast seulement sur le téléphone') },
    castDisconnect: async () => {},
    get position() { return audio.currentTime || 0 },
  }
}

export const engine = isNative ? nativeEngine() : webEngine()
