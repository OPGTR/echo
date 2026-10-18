'use strict'
// Where Écho keeps things.
//  - dataDir: the app's private storage (database, covers, addons).
//  - downloadDir: where downloaded songs go. A folder of the phone's shared
//    "Music" collection, so other apps (and the user) see them; when Android
//    refuses to write there, a folder the app can always write to that the
//    phone's media library still indexes (Android/media/<app>/Music).
const path = require('path')
const fs = require('fs')
const os = require('os')

const platform = {
  dataDir: process.env.ECHO_DATA_DIR || path.join(os.tmpdir(), 'echo-data'),
  musicDir: process.env.ECHO_MUSIC_DIR || null, // e.g. /storage/emulated/0/Music
  mediaDir: process.env.ECHO_MEDIA_DIR || null, // e.g. /storage/emulated/0/Android/media/com.opgtr.echo
}

function dataDir() { fs.mkdirSync(platform.dataDir, { recursive: true }); return platform.dataDir }

/** The phone tells the server its storage folders (see app/src/native.js). */
function setPlatformDirs({ musicDir, mediaDir } = {}) {
  if (typeof musicDir === 'string' && path.isAbsolute(musicDir)) platform.musicDir = musicDir
  if (typeof mediaDir === 'string' && path.isAbsolute(mediaDir)) platform.mediaDir = mediaDir
}

/** Download folders, best first. */
function downloadDirs(preferred) {
  const list = []
  if (preferred) list.push(preferred)
  if (platform.musicDir) list.push(path.join(platform.musicDir, 'Écho'))
  if (platform.mediaDir) list.push(path.join(platform.mediaDir, 'Music'))
  list.push(path.join(dataDir(), 'music'))
  return [...new Set(list)]
}

module.exports = { platform, dataDir, setPlatformDirs, downloadDirs }
