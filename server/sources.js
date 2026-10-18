'use strict'
// The SpotiFLAC addons Écho downloads with (engine adapted from Lokal, MIT).
// Écho's catalogue is Deezer's, so the Deezer addon is the source: it fetches
// exactly the song you picked, by its id.
const { getDB } = require('./db')
const packages = require('./spotiflac/packages')
const { dispatch } = require('./spotiflac/api')

const service = () => packages.service(getDB())

function list() {
  try { return service().list() } catch { return [] }
}

/** The installed, enabled Deezer addon, or null. */
function downloadSource() {
  return list().find(a => a.id === 'deezer' && a.enabled) || null
}

function state() {
  const deezer = list().find(a => a.id === 'deezer') || null
  return {
    installed: !!deezer,
    enabled: !!deezer?.enabled,
    key: deezer?.key || null,
    version: deezer?.version || null,
    ready: !!deezer && (deezer.access ? deezer.access.ready !== false : true),
    access: deezer?.access || null,
    quality: deezer?.qualityOptions || null,
  }
}

/** Installs (or updates) the Deezer addon from the official SpotiFLAC catalogue. */
async function installDeezer() {
  const s = service()
  await s.refreshDue(0).catch(() => null)
  const entry = s.catalogue().find(e => e.id === 'deezer')
  if (!entry) throw new Error('The Deezer addon is not in the SpotiFLAC catalogue right now')
  if (!entry.installed || entry.updateAvailable) await s.install({ repositoryId: entry.repositoryId, id: 'deezer' })
  return state()
}

/** What the phone's verification window needs (page, callback, allowed domains). */
async function verifyInfo() {
  const st = state()
  if (!st.key) throw new Error('NO_SOURCE')
  return dispatch(getDB(), { action: 'package.authInfo', key: st.key })
}

async function verifyComplete({ url, cookies } = {}) {
  const st = state()
  if (!st.key) throw new Error('NO_SOURCE')
  return dispatch(getDB(), { action: 'package.authComplete', key: st.key, url: url || null, cookies: Array.isArray(cookies) ? cookies : [] })
}

module.exports = { service, list, downloadSource, state, installDeezer, verifyInfo, verifyComplete }
