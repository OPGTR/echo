'use strict'
// ffmpeg and ffprobe on Android.
//
// Android won't let an app start programs, and Lokal's backend calls ffmpeg /
// ffprobe as programs: SpotiFLAC addons (probe every download, decrypt some
// sources, change containers), playable copies of ALAC, quality checks.
// This module stands in for those two programs, so the backend code stays
// as it is:
//   - spawn('ffmpeg', args) runs ffmpeg compiled to WebAssembly, in a worker
//     thread (the server keeps answering meanwhile), one job at a time;
//   - spawn('ffprobe', [... -of json, file]) answers from the file's tags
//     (music-metadata, which Lokal already uses for scanning).
// Everything else that tries to start a program gets the usual "can't
// start it" error, exactly as on a phone.

const childProcess = require('child_process')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const path = require('path')
const fs = require('fs')

const TOOL_RE = /(^|[\\/])(ffmpeg|ffprobe)(\.exe)?$/i
const VERSION_TEXT = 'ffmpeg version 6.0-lokal-wasm Copyright (c) the FFmpeg developers\n'

function toolOf(command) {
  const m = String(command || '').match(TOOL_RE)
  return m ? m[2].toLowerCase() : null
}

/** A ChildProcess look-alike. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.pid = 0
  child.exitCode = null
  child.killed = false
  child.finish = (code, signal = null) => {
    if (child.exitCode !== null || child._done) return
    child._done = true
    child.exitCode = code
    child.stdout.end()
    child.stderr.end()
    setImmediate(() => { child.emit('exit', code, signal); child.emit('close', code, signal) })
  }
  return child
}

// ------------------------------------------------------------------ ffmpeg
let worker = null
let workerReady = null
const queue = []
let current = null

function workerPath() {
  return path.join(__dirname, 'ffmpeg-worker.js')
}

function startWorker() {
  const { Worker } = require('worker_threads')
  worker = new Worker(workerPath())
  workerReady = new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m && m.type === 'ready') { worker.off('message', onMessage); resolve() }
      if (m && m.type === 'fatal') { worker.off('message', onMessage); reject(new Error(m.error)) }
    }
    worker.on('message', onMessage)
  })
  worker.on('message', (m) => {
    if (!current || !m || m.id !== current.id) return
    if (m.type === 'log') current.child.stderr.write(m.line + '\n')
    else if (m.type === 'stdout') current.child.stdout.write(Buffer.from(m.data))
    else if (m.type === 'done') { const job = current; current = null; job.child.finish(m.code); pump() }
  })
  worker.on('error', (e) => {
    if (current) { current.child.stderr.write(`ffmpeg: ${e.message}\n`); current.child.finish(1); current = null }
    worker = null; workerReady = null
    pump()
  })
  worker.on('exit', () => { worker = null; workerReady = null })
}

let seq = 0
function pump() {
  if (current || !queue.length) return
  const job = queue.shift()
  if (job.child.killed) { job.child.finish(null, 'SIGKILL'); return pump() }
  current = job
  if (!worker) startWorker()
  workerReady.then(() => {
    if (current !== job) return
    worker.postMessage({ type: 'run', id: job.id, args: job.args, cwd: job.cwd })
  }, (e) => {
    job.child.stderr.write(`ffmpeg could not start: ${e.message}\n`)
    current = null
    job.child.finish(1)
    pump()
  })
}

function spawnFfmpeg(args, options = {}) {
  const child = fakeChild()
  const list = (args || []).map(String)
  if (list.includes('-version') || list.includes('--version')) {
    setImmediate(() => { child.stdout.write(VERSION_TEXT); child.finish(0) })
    return child
  }
  const job = { id: ++seq, args: list, cwd: options.cwd || process.cwd(), child }
  child.kill = () => {
    child.killed = true
    const i = queue.indexOf(job)
    if (i >= 0) { queue.splice(i, 1); child.finish(null, 'SIGKILL'); return true }
    if (current === job && worker) {
      // A running WebAssembly call can't be interrupted: drop the worker.
      current = null
      const w = worker
      worker = null; workerReady = null
      w.terminate().catch(() => {})
      child.finish(null, 'SIGKILL')
      pump()
      return true
    }
    return false
  }
  queue.push(job)
  setImmediate(pump)
  return child
}

// ----------------------------------------------------------------- ffprobe
const CODECS = [
  [/flac/i, 'flac'],
  [/alac|apple lossless/i, 'alac'],
  [/layer 3|mp3/i, 'mp3'],
  [/layer 2|mp2/i, 'mp2'],
  [/opus/i, 'opus'],
  [/vorbis/i, 'vorbis'],
  [/aac|mp4a/i, 'aac'],
  [/ac-?3/i, 'ac3'],
  [/wavpack/i, 'wavpack'],
  [/monkey|ape/i, 'ape'],
  [/wma/i, 'wmav2'],
]

function codecName(format = {}) {
  const text = `${format.codec || ''} ${format.container || ''}`
  if (/pcm|wave|wav|aiff/i.test(text) && !/adpcm/i.test(text)) {
    const bits = format.bitsPerSample || 16
    if (/float/i.test(text) || format.codecProfile === 'float') return 'pcm_f32le'
    return bits >= 24 ? 'pcm_s24le' : 'pcm_s16le'
  }
  for (const [re, name] of CODECS) if (re.test(text)) return name
  return String(format.codec || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

/** The container, from the file's first bytes (a name can lie: "audio.flac" holding AAC). */
function sniff(file) {
  let head = Buffer.alloc(0)
  try { const fd = fs.openSync(file, 'r'); head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd) } catch {}
  const at = (i, text) => head.slice(i, i + text.length).toString('latin1') === text
  if (at(0, 'fLaC')) return { ext: '.flac', mime: 'audio/flac' }
  if (at(4, 'ftyp')) return { ext: '.m4a', mime: 'audio/mp4' }
  if (at(0, 'OggS')) return { ext: '.ogg', mime: 'audio/ogg' }
  if (at(0, 'RIFF')) return { ext: '.wav', mime: 'audio/wav' }
  if (at(0, 'FORM')) return { ext: '.aiff', mime: 'audio/aiff' }
  if (at(0, 'ID3')) return { ext: '.mp3', mime: 'audio/mpeg', id3: true }
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { ext: head[1] & 0x06 ? '.mp3' : '.aac', mime: head[1] & 0x06 ? 'audio/mpeg' : 'audio/aac' }
  return null
}

/** Reads the format with ffmpeg itself (WebAssembly): for files music-metadata can't read. */
function ffmpegInfo(file) {
  return new Promise(resolve => {
    const child = spawnFfmpeg(['-hide_banner', '-i', file, '-f', 'null', '-t', '0', '-'])
    let err = ''
    child.stderr.on('data', d => { err += d })
    child.on('close', () => {
      const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err)
      const audio = /Audio: ([a-z0-9_]+)[^,\n]*(?:, (\d+) Hz)?(?:, ([a-z0-9.() ]+))?(?:, ([a-z0-9]+))?/i.exec(err)
      if (!audio) return resolve(null)
      const fmt = audio[4] || ''
      resolve({
        codec: audio[1], container: (/Input #0, ([^,]+)/.exec(err) || [])[1] || '',
        sampleRate: audio[2] ? Number(audio[2]) : undefined,
        numberOfChannels: /mono/.test(audio[3] || '') ? 1 : 2,
        bitsPerSample: /s32|s24/.test(fmt) ? 24 : /s16/.test(fmt) ? 16 : undefined,
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : undefined,
      })
    })
  })
}

/**
 * Reads only what playback needs from an MP4/M4A (codec, rate, channels,
 * duration) by walking the boxes down to the audio track. Metadata boxes
 * (udta, meta) are skipped: a badly written tag there (a size counted in
 * characters instead of bytes, common with non-Latin titles) makes stricter
 * readers fail with "FourCC contains invalid characters".
 */
function mp4Info(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b }
    const boxes = (start, end) => {
      const out = []
      for (let pos = start; pos + 8 <= end;) {
        const h = read(pos, 16)
        let len = h.readUInt32BE(0), head = 8
        const type = h.toString('latin1', 4, 8)
        if (len === 1) { len = Number(h.readBigUInt64BE(8)); head = 16 } else if (len === 0) len = end - pos
        if (len < head || pos + len > end) break
        out.push({ type, start: pos + head, end: pos + len })
        pos += len
      }
      return out
    }
    const find = (list, type) => list.find(b => b.type === type)
    const moov = find(boxes(0, size), 'moov')
    if (!moov) return null
    for (const trak of boxes(moov.start, moov.end).filter(b => b.type === 'trak')) {
      const mdia = find(boxes(trak.start, trak.end), 'mdia'); if (!mdia) continue
      const inner = boxes(mdia.start, mdia.end)
      const hdlr = find(inner, 'hdlr'); if (!hdlr || read(hdlr.start + 8, 4).toString('latin1') !== 'soun') continue
      const mdhd = find(inner, 'mdhd'); let duration
      if (mdhd) {
        const v = read(mdhd.start, 1)[0]
        const b = read(mdhd.start, 32)
        const scale = v === 1 ? b.readUInt32BE(20) : b.readUInt32BE(12)
        const dur = v === 1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16)
        if (scale) duration = dur / scale
      }
      const minf = find(inner, 'minf'); const stbl = minf && find(boxes(minf.start, minf.end), 'stbl')
      const stsd = stbl && find(boxes(stbl.start, stbl.end), 'stsd'); if (!stsd) continue
      const entry = read(stsd.start + 8, 36)
      const fourcc = entry.toString('latin1', 4, 8)
      const codec = { mp4a: 'aac', alac: 'alac', fLaC: 'flac', Opus: 'opus', 'ac-3': 'ac3', 'ec-3': 'eac3', '.mp3': 'mp3' }[fourcc] || fourcc
      const channels = entry.readUInt16BE(24), bits = entry.readUInt16BE(26), rate = entry.readUInt32BE(32) >>> 16
      return { codec, container: 'mp4', sampleRate: rate || undefined, numberOfChannels: channels || 2, bitsPerSample: codec === 'aac' ? undefined : bits || undefined, duration, bitrate: duration ? size * 8 / duration : undefined }
    }
    return null
  } catch { return null } finally { fs.closeSync(fd) }
}

/** FLAC's STREAMINFO block, read directly. */
function flacInfo(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(42); fs.readSync(fd, b, 0, 42, 0)
    if (b.toString('latin1', 0, 4) !== 'fLaC' || (b[4] & 0x7f) !== 0) return null
    const si = b.subarray(8)
    const rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4)
    const channels = ((si[12] >> 1) & 7) + 1
    const bits = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1
    const samples = (si[13] & 0x0f) * 2 ** 32 + si.readUInt32BE(14)
    return { codec: 'flac', container: 'flac', sampleRate: rate, numberOfChannels: channels, bitsPerSample: bits, duration: rate && samples ? samples / rate : undefined }
  } catch { return null } finally { fs.closeSync(fd) }
}

async function readFormat(file) {
  const mm = require('music-metadata')
  try {
    return await mm.parseFile(file, { duration: true, skipCovers: true })
  } catch (first) {
    // The name says one format, the bytes another: read by content.
    const kind = sniff(file)
    if (kind) {
      try { return await mm.parseStream(fs.createReadStream(file), { mimeType: kind.mime, size: fs.statSync(file).size }, { duration: true, skipCovers: true }) } catch {}
    }
    const direct = kind?.ext === '.m4a' ? mp4Info(file) : kind?.ext === '.flac' ? flacInfo(file) : null
    if (direct) return { format: direct, common: {} }
    const info = await ffmpegInfo(file)
    if (info) return { format: info, common: {} }
    throw first
  }
}

async function probe(file) {
  const meta = await readFormat(file)
  const f = meta.format || {}
  const stream = {
    index: 0,
    codec_type: 'audio',
    codec_name: codecName(f),
    sample_rate: f.sampleRate ? String(f.sampleRate) : undefined,
    channels: f.numberOfChannels || 2,
    bits_per_raw_sample: f.bitsPerSample ? String(f.bitsPerSample) : undefined,
    bits_per_sample: f.bitsPerSample || 0,
    duration: f.duration != null ? String(f.duration) : undefined,
    bit_rate: f.bitrate ? String(Math.round(f.bitrate)) : undefined,
  }
  const stat = fs.statSync(file)
  return {
    streams: [stream],
    format: {
      filename: file,
      nb_streams: 1,
      format_name: String(f.container || '').toLowerCase(),
      duration: f.duration != null ? String(f.duration) : undefined,
      size: String(stat.size),
      bit_rate: f.bitrate ? String(Math.round(f.bitrate)) : undefined,
      tags: { title: meta.common?.title, artist: meta.common?.artist, album: meta.common?.album },
    },
  }
}

function spawnFfprobe(args) {
  const child = fakeChild()
  child.kill = () => { child.killed = true; child.finish(null, 'SIGKILL'); return true }
  const list = (args || []).map(String)
  setImmediate(async () => {
    if (list.includes('-version')) { child.stdout.write(VERSION_TEXT.replace('ffmpeg', 'ffprobe')); return child.finish(0) }
    // The input is the last argument that isn't an option or an option's value.
    const file = [...list].reverse().find(a => !a.startsWith('-') && fs.existsSync(a))
    if (!file) { child.stderr.write('ffprobe: no input file\n'); return child.finish(1) }
    try {
      const result = await probe(file)
      if (child.killed) return
      child.stdout.write(JSON.stringify(result, null, 2))
      child.finish(0)
    } catch (e) {
      child.stderr.write(`${file}: ${e.message}\n`)
      child.finish(1)
    }
  })
  return child
}

// -------------------------------------------------------------------- hooks
function cannotStart(command) {
  return Object.assign(new Error(`spawn ${command} EACCES`), { code: 'EACCES', errno: -13, syscall: `spawn ${command}`, path: command })
}

function install() {
  if (childProcess.__lokalTools) return
  childProcess.__lokalTools = true
  const original = { spawn: childProcess.spawn, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync }

  childProcess.spawn = function spawn(command, args, options) {
    if (!Array.isArray(args)) { options = args; args = [] }
    const tool = toolOf(command)
    if (tool === 'ffmpeg') return spawnFfmpeg(args, options)
    if (tool === 'ffprobe') return spawnFfprobe(args, options)
    return original.spawn.call(this, command, args, options)
  }

  childProcess.execFile = function execFile(command, args, options, callback) {
    if (typeof args === 'function') { callback = args; args = []; options = {} }
    else if (typeof options === 'function') { callback = options; options = {} }
    const tool = toolOf(command)
    if (!tool) return original.execFile.call(this, command, args, options, callback)
    const child = tool === 'ffmpeg' ? spawnFfmpeg(args, options) : spawnFfprobe(args, options)
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', (code) => {
      if (!callback) return
      if (code === 0) callback(null, out, err)
      else callback(Object.assign(new Error(err.trim().split('\n').pop() || `${tool} exited with ${code}`), { code }), out, err)
    })
    return child
  }

  // Only "is it installed?" checks are synchronous.
  childProcess.execFileSync = function execFileSync(command, args = [], options = {}) {
    const tool = toolOf(command)
    if (!tool) return original.execFileSync.call(this, command, args, options)
    if (Array.isArray(args) && (args.includes('-version') || args.includes('--version'))) {
      const text = tool === 'ffmpeg' ? VERSION_TEXT : VERSION_TEXT.replace('ffmpeg', 'ffprobe')
      return options && options.encoding && options.encoding !== 'buffer' ? text : Buffer.from(text)
    }
    throw cannotStart(command)
  }
  childProcess.spawnSync = function spawnSync(command, args = [], options = {}) {
    const tool = toolOf(command)
    if (!tool) return original.spawnSync.call(this, command, args, options)
    if (Array.isArray(args) && args.includes('-version')) {
      const text = Buffer.from(VERSION_TEXT)
      return { pid: 0, status: 0, signal: null, output: [null, text, Buffer.alloc(0)], stdout: text, stderr: Buffer.alloc(0) }
    }
    return { pid: 0, status: null, signal: null, output: null, stdout: null, stderr: null, error: cannotStart(command) }
  }
}

module.exports = { mp4Info, flacInfo, sniff, install, probe, codecName }
