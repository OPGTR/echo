'use strict'
// Songs you don't like: never proposed again (daily mixes, "Ton mix",
// "À redécouvrir", Découvertes). Matched by Deezer id or by artist + title.
const { getDB } = require('./db')

function keyOf(song, songKey) { return songKey(song.artist, song.title) }

function add(song = {}) {
  const { songKey } = require('./foryou')
  if (!song.title) throw Object.assign(new Error('title missing'), { status: 400 })
  getDB().prepare('INSERT INTO dislikes (key, deezer_id, title, artist, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET deezer_id = COALESCE(excluded.deezer_id, dislikes.deezer_id)')
    .run(keyOf(song, songKey), song.deezer_id ? String(song.deezer_id) : null, String(song.title), song.artist ? String(song.artist) : null, Date.now())
  return list()
}

function remove(song = {}) {
  const { songKey } = require('./foryou')
  const db = getDB()
  if (song.key) db.prepare('DELETE FROM dislikes WHERE key = ?').run(String(song.key))
  else {
    db.prepare('DELETE FROM dislikes WHERE key = ?').run(keyOf(song, songKey))
    if (song.deezer_id) db.prepare('DELETE FROM dislikes WHERE deezer_id = ?').run(String(song.deezer_id))
  }
  return list()
}

function list() {
  return getDB().prepare('SELECT key, deezer_id, title, artist, created_at FROM dislikes ORDER BY created_at DESC').all()
}

/** A test for songs: true when you said you don't like it. */
function filter() {
  const { songKey } = require('./foryou')
  const rows = list()
  const keys = new Set(rows.map(r => r.key)), ids = new Set(rows.map(r => r.deezer_id).filter(Boolean))
  return song => !!song && ((song.deezer_id && ids.has(String(song.deezer_id))) || keys.has(songKey(song.artist, song.title)))
}

module.exports = { add, remove, list, filter }
