'use strict'
// Écho's server, started by the Android app's embedded Node.js (18, no ICU).
require('./platform/polyfills')
// ffmpeg / ffprobe as WebAssembly, before anything takes child_process.
require('./platform/tools').install()

const path = require('path')
const os = require('os')
const fs = require('fs')

let bridge = null
try { bridge = require('bridge') } catch {}

const dataRoot = (bridge && typeof bridge.getDataPath === 'function' && bridge.getDataPath()) || process.env.ECHO_DATA_ROOT || path.join(os.tmpdir(), 'echo')
process.env.ECHO_DATA_DIR = process.env.ECHO_DATA_DIR || path.join(dataRoot, 'data')
if (!process.env.HOME || process.env.HOME === '/') process.env.HOME = dataRoot
try { fs.mkdirSync(process.env.ECHO_DATA_DIR, { recursive: true }) } catch {}
try { process.chdir(dataRoot) } catch {}

const recent = []
const remember = line => { recent.push(String(line).slice(0, 1000)); if (recent.length > 60) recent.shift() }
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...args) => {
    original(...args)
    const line = args.map(a => (a && a.stack) || (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    remember(line)
    try { bridge?.channel?.send('echo-log', line) } catch {}
  }
}
process.on('uncaughtException', e => console.error('[echo] uncaught:', e && e.stack || e))
process.on('unhandledRejection', e => console.error('[echo] unhandled rejection:', e && e.stack || e))

const { getDB } = require('./db')
const { createApp, TOKEN } = require('./app')
const downloads = require('./downloads')
const library = require('./library')
const { downloadDirs } = require('./paths')

getDB()
const PORT = Number(process.env.ECHO_PORT || 3433)
const app = createApp()
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[echo] server on 127.0.0.1:${PORT}`)
  announce()
  downloads.resume()
  if (process.env.ECHO_NO_AUTOVERIFY !== '1') require('./sources').startAutoVerify()
  // Catch up with files added while Écho was closed (only new or changed files are read).
  setTimeout(() => library.scan({ extraFolders: downloadDirs().filter(d => fs.existsSync(d)) }).catch(() => {}), 3000)
})
server.on('error', e => console.error('[echo] server:', e.message))

// The app learns where the server is and its secret.
function announce() {
  try { bridge?.channel?.send('echo-ready', JSON.stringify({ port: PORT, token: TOKEN })) } catch {}
}
try {
  bridge?.channel?.addListener('echo-hello', announce)
  bridge?.channel?.addListener('echo-logs', () => { try { bridge.channel.send('echo-logs', JSON.stringify(recent)) } catch {} })
} catch {}

// Every few minutes, while the app runs: songs that appeared in the music
// folders (copied over USB, saved by another app) join the library.
setInterval(() => library.scan({ extraFolders: downloadDirs().filter(d => fs.existsSync(d)) }).catch(() => {}), 5 * 60 * 1000).unref?.()

module.exports = { server }
