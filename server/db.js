'use strict'
const path = require('path')
const Database = require('./platform/sqlite-adapter')
const { dataDir } = require('./paths')

let db = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  size INTEGER, mtime INTEGER,
  title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT, album_artist TEXT,
  track_no INTEGER, disc_no INTEGER, year INTEGER, genre TEXT,
  duration REAL, codec TEXT, lossless INTEGER, bitrate INTEGER, sample_rate INTEGER, bits INTEGER,
  art TEXT,
  deezer_id TEXT,
  liked INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  last_played INTEGER,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks (artist);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks (album_artist, album);
CREATE INDEX IF NOT EXISTS tracks_deezer ON tracks (deezer_id);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  artist TEXT, title TEXT,
  seconds INTEGER NOT NULL,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_at ON plays (played_at);
CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  deezer_id TEXT NOT NULL,
  title TEXT, artist TEXT, album TEXT, cover TEXT, duration REAL,
  status TEXT NOT NULL,
  progress REAL DEFAULT 0,
  message TEXT, error TEXT,
  track_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS downloads_deezer ON downloads (deezer_id);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user',
  source TEXT, source_url TEXT,
  sort TEXT NOT NULL DEFAULT 'custom',
  sort_dir TEXT NOT NULL DEFAULT 'asc',
  meta TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  pos REAL NOT NULL,
  local_id TEXT, deezer_id TEXT,
  title TEXT NOT NULL, artist TEXT, album TEXT, cover TEXT, duration REAL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_items_pl ON playlist_items (playlist_id, pos);
CREATE TABLE IF NOT EXISTS temporary (
  track_id TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dislikes (
  key TEXT PRIMARY KEY,
  deezer_id TEXT,
  title TEXT NOT NULL, artist TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dislikes_deezer ON dislikes (deezer_id);
CREATE TABLE IF NOT EXISTS follows (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  picture TEXT,
  latest_id TEXT, latest_json TEXT,
  seen_id TEXT,
  checked_at INTEGER,
  followed_at INTEGER NOT NULL
);
`

function getDB() {
  if (db) return db
  db = new Database(path.join(dataDir(), 'echo.db'))
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  // 0.3.2: where a download comes from ('mix': kept 48 h unless you keep it).
  try { db.exec('ALTER TABLE downloads ADD COLUMN origin TEXT') } catch {}
  return db
}

function getSetting(key, fallback = null) {
  const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
}
function setSetting(key, value) {
  if (value === null || value === undefined) getDB().prepare('DELETE FROM settings WHERE key = ?').run(key)
  else getDB().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
}
function getJSON(key, fallback) {
  try { const v = getSetting(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}

module.exports = { getDB, getSetting, setSetting, getJSON }
