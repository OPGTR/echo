'use strict'
// Artists you follow: a dot on their picture when they release something
// (a single, an EP, an album) since you last looked.
const { getDB } = require('./db')
const deezer = require('./deezer')

const CHECK_EVERY = 6 * 60 * 60 * 1000

async function latestOf(artistId, fresh = false) {
  const albums = await deezer.artistAlbums(artistId, { fresh })
  return albums[0] || null
}

function shape(r) {
  let latest = null
  try { latest = r.latest_json ? JSON.parse(r.latest_json) : null } catch {}
  return { id: r.artist_id, name: r.name, picture: r.picture, latest, new: !!(r.latest_id && r.latest_id !== r.seen_id), followed_at: r.followed_at }
}

async function follow({ id, name, picture } = {}) {
  if (!id) throw Object.assign(new Error('artist id missing'), { status: 400 })
  let info = { name, picture }
  if (!name) { try { info = await deezer.artistInfo(id) } catch {} }
  let latest = null
  try { latest = await latestOf(id) } catch {}
  getDB().prepare(`INSERT INTO follows (artist_id, name, picture, latest_id, latest_json, seen_id, checked_at, followed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artist_id) DO UPDATE SET name = excluded.name, picture = COALESCE(excluded.picture, follows.picture)`)
    .run(String(id), info.name || 'Artiste', info.picture || null, latest?.id || null, latest ? JSON.stringify(latest) : null, latest?.id || null, Date.now(), Date.now())
  return list()
}

function unfollow(id) {
  getDB().prepare('DELETE FROM follows WHERE artist_id = ?').run(String(id))
  return list()
}

function isFollowed(id) { return !!getDB().prepare('SELECT 1 FROM follows WHERE artist_id = ?').get(String(id)) }

/** Checks for new releases (at most every few hours per artist). */
async function refresh({ force = false } = {}) {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM follows').all().filter(r => force || !r.checked_at || Date.now() - r.checked_at > CHECK_EVERY)
  let next = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < rows.length) {
      const r = rows[next++]
      try {
        const latest = await latestOf(r.artist_id, true)
        db.prepare('UPDATE follows SET latest_id = ?, latest_json = ?, checked_at = ? WHERE artist_id = ?').run(latest?.id || null, latest ? JSON.stringify(latest) : null, Date.now(), r.artist_id)
      } catch {}
    }
  }))
}

function list() {
  const artists = getDB().prepare('SELECT * FROM follows ORDER BY name COLLATE NOCASE').all().map(shape)
  const news = artists.filter(a => a.latest).map(a => ({ ...a.latest, artist: a.name, artist_id: a.id, new: a.new }))
    .sort((x, y) => String(y.release_date || '').localeCompare(String(x.release_date || ''))).slice(0, 20)
  return { artists, news, unseen: artists.filter(a => a.new).length }
}

function seen(id) {
  getDB().prepare('UPDATE follows SET seen_id = latest_id WHERE artist_id = ?').run(String(id))
  return list()
}

module.exports = { follow, unfollow, isFollowed, refresh, list, seen }
