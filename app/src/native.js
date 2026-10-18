// The phone: Écho's Node.js server inside the app, Android permissions and
// folders, the media notification. In a browser (development, tests) these
// fall back to plain web equivalents.
import { Capacitor, registerPlugin } from '@capacitor/core'

export const isNative = Capacitor.isNativePlatform()
export const EchoNative = registerPlugin('EchoNative')

let nodeModule = null
async function node() {
  if (!nodeModule) nodeModule = (await import('capacitor-nodejs')).NodeJS
  return nodeModule
}

/**
 * Where the server is and its secret: { base, token }. In the app the server
 * announces itself; in a browser, ?server=http://127.0.0.1:3433 (dev mode).
 */
export function connectServer({ timeoutMs = 90000 } = {}) {
  if (!isNative) {
    const params = new URLSearchParams(location.search)
    const base = params.get('server') || `${location.protocol}//${location.host}`
    return Promise.resolve({ base, token: params.get('token') || '' })
  }
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => { if (!done) reject(new Error('The built-in server did not start')) }, timeoutMs)
    node().then(async NodeJS => {
      await NodeJS.addListener('echo-ready', event => {
        if (done) return
        try {
          const info = JSON.parse(event.args[0])
          done = true
          clearTimeout(timer)
          resolve({ base: `http://127.0.0.1:${info.port}`, token: info.token })
        } catch {}
      })
      await NodeJS.whenReady()
      // The server may have announced itself before we listened: ask again.
      const ask = () => { if (!done) { NodeJS.send({ eventName: 'echo-hello', args: [] }).catch(() => {}); setTimeout(ask, 1500) } }
      ask()
    }).catch(reject)
  })
}

/** The server's recent log lines (for the "couldn't start" screen). */
export async function serverLogs() {
  if (!isNative) return []
  const NodeJS = await node()
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve([]), 2000)
    NodeJS.addListener('echo-logs', e => { clearTimeout(timer); try { resolve(JSON.parse(e.args[0])) } catch { resolve([]) } })
    NodeJS.send({ eventName: 'echo-logs', args: [] }).catch(() => {})
  })
}

export async function storagePaths() {
  if (!isNative) return {}
  try { return await EchoNative.storagePaths() } catch { return {} }
}
export async function musicAccess() {
  if (!isNative) return { media: true }
  try { return await EchoNative.storageAccess() } catch { return { media: false } }
}
export async function requestMusicAccess() {
  if (!isNative) return { media: true }
  return EchoNative.requestMediaAccess()
}
export async function openAppSettings() { if (isNative) await EchoNative.openAppSettings().catch(() => {}) }
export async function pickFolder() {
  if (!isNative) { const p = window.prompt('Chemin du dossier'); return p || null }
  const r = await EchoNative.pickFolder()
  return r?.path || null
}
export async function openUrl(url) {
  if (!isNative) { window.open(url, '_blank', 'noopener'); return }
  await EchoNative.openUrl({ url })
}
/** A source's one-time check (captcha) in its own window: { url, cookies }. */
export async function verifyWindow({ url, callback, domains }) {
  if (!isNative) { window.open(url, '_blank', 'noopener'); return { url: null, cookies: [] } }
  return EchoNative.addonAuth({ url, callback, domains })
}
export async function minimize() {
  if (!isNative) return
  const { App } = await import('@capacitor/app')
  App.minimizeApp()
}
export async function onBackButton(fn) {
  if (!isNative) return () => {}
  const { App } = await import('@capacitor/app')
  const handle = await App.addListener('backButton', fn)
  return () => handle.remove()
}
export async function onResume(fn) {
  if (!isNative) { const h = () => { if (!document.hidden) fn() }; document.addEventListener('visibilitychange', h); return () => document.removeEventListener('visibilitychange', h) }
  const { App } = await import('@capacitor/app')
  const handle = await App.addListener('resume', fn)
  return () => handle.remove()
}

// ------------------------------------------------------------ media session
// Lock screen, notification, headset and Bluetooth buttons; on the phone it
// also keeps Écho playing in the background.
let mediaPlugin = null
async function media() {
  if (!isNative) return null
  if (!mediaPlugin) mediaPlugin = (await import('@capgo/capacitor-media-session')).MediaSession
  return mediaPlugin
}
let lastState = null
export const mediaSession = {
  async metadata({ title, artist, album, artwork }) {
    const m = await media()
    if (m) return m.setMetadata({ title, artist, album, artwork: artwork ? [{ src: artwork, sizes: '512x512', type: 'image/jpeg' }] : [] }).catch(() => {})
    if ('mediaSession' in navigator && window.MediaMetadata) navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album, artwork: artwork ? [{ src: artwork, sizes: '512x512' }] : [] })
  },
  async state(playing) {
    const value = playing === null ? 'none' : playing ? 'playing' : 'paused'
    if (value === lastState) return
    lastState = value
    const m = await media()
    if (m) return m.setPlaybackState({ playbackState: value }).catch(() => {})
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = value
  },
  async position(duration, position) {
    if (!Number.isFinite(duration) || duration <= 0) return
    const m = await media()
    const state = { duration, position: Math.min(position || 0, duration), playbackRate: 1 }
    if (m) return m.setPositionState(state).catch(() => {})
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) try { navigator.mediaSession.setPositionState(state) } catch {}
  },
  async actions(handlers) {
    const m = await media()
    for (const [action, handler] of Object.entries(handlers)) {
      if (m) await m.setActionHandler({ action }, details => handler(details || {})).catch(() => {})
      else if ('mediaSession' in navigator) try { navigator.mediaSession.setActionHandler(action, d => handler(d || {})) } catch {}
    }
  },
}
