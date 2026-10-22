// Talking to Écho's server (Node.js inside the app, on 127.0.0.1).
let base = ''
let token = ''
let mediaToken = '' // only for listening and covers: it goes into addresses

/** Where the server is and its secret (for the downloads service on the phone). */
export const serverInfo = () => ({ base, token })

export function setServer(info) { base = info.base.replace(/\/$/, ''); token = info.token || ''; mediaToken = info.mediaToken || '' }

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-echo-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

const q = params => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)])).toString()
  return s ? `?${s}` : ''
}

export const api = {
  health: () => call('/health'),
  settings: () => call('/settings'),
  saveSettings: body => call('/settings', { method: 'PUT', body }),
  platform: body => call('/platform', { method: 'POST', body }),

  scan: () => call('/library/scan', { method: 'POST', body: {} }),
  scanStatus: () => call('/library/status'),
  stats: () => call('/library/stats'),
  tracks: (params = {}) => call(`/library/tracks${q(params)}`),
  albums: (params = {}) => call(`/library/albums${q(params)}`),
  album: (album, artist) => call(`/library/album${q({ album, artist })}`),
  artists: (params = {}) => call(`/library/artists${q(params)}`),
  artist: name => call(`/library/artist${q({ name })}`),
  history: (limit = 30) => call(`/history${q({ limit })}`),
  track: id => call(`/tracks/${encodeURIComponent(id)}`),
  like: (id, liked) => call(`/tracks/${encodeURIComponent(id)}/like`, { method: 'POST', body: { liked } }),
  played: (id, seconds) => call(`/tracks/${encodeURIComponent(id)}/play`, { method: 'POST', body: { seconds } }),
  remove: id => call(`/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  forYou: (force = false) => call(`/foryou${q({ force })}`),
  search: text => call(`/search${q({ q: text })}`),
  catalogueAlbum: id => call(`/catalogue/album/${encodeURIComponent(id)}`),
  catalogueArtist: id => call(`/catalogue/artist/${encodeURIComponent(id)}`),
  findArtist: name => call(`/catalogue/find-artist${q({ name })}`),

  downloads: () => call('/downloads'),
  download: (items, { play = false, origin = null } = {}) => call('/downloads', { method: 'POST', body: { items, play, origin } }),
  waitDownload: (deezerId, timeout = 60000) => call(`/downloads/wait${q({ deezer_id: deezerId, timeout })}`),
  cancelDownload: id => call(`/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  retryDownload: id => call(`/downloads/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} }),
  clearDownloads: () => call('/downloads', { method: 'DELETE' }),

  prefs: () => call('/prefs'),
  savePrefs: body => call('/prefs', { method: 'PUT', body }),

  playlists: () => call('/playlists'),
  playlist: id => call(`/playlists/${encodeURIComponent(id)}`),
  createPlaylist: (name, tracks = []) => call('/playlists', { method: 'POST', body: { name, tracks } }),
  updatePlaylist: (id, body) => call(`/playlists/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deletePlaylist: id => call(`/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  arrangePlaylists: ids => call('/playlists/order', { method: 'PUT', body: { ids } }),
  addToPlaylist: (id, tracks) => call(`/playlists/${encodeURIComponent(id)}/items`, { method: 'POST', body: { tracks } }),
  removeFromPlaylist: (id, itemId) => call(`/playlists/${encodeURIComponent(id)}/items/${itemId}`, { method: 'DELETE' }),
  reorderPlaylist: (id, ids) => call(`/playlists/${encodeURIComponent(id)}/items`, { method: 'PUT', body: { ids } }),
  importPlaylist: url => call('/playlists/import', { method: 'POST', body: { url } }),

  mixArtists: () => call('/mixes/artists'),
  customMix: (artists, era) => call('/mixes/custom', { method: 'POST', body: { artists, era } }),

  artistMix: id => call(`/mixes/artist/${encodeURIComponent(id)}`),
  createArtistMix: id => call(`/mixes/artist/${encodeURIComponent(id)}`, { method: 'POST', body: {} }),
  myMixes: () => call('/mixes/mine'),
  keepMix: (id, saved = true) => call(`/playlists/${encodeURIComponent(id)}/keep`, { method: 'POST', body: { saved } }),
  checkSources: () => call('/sources/check', { method: 'POST', body: {} }),
  dislikes: () => call('/dislikes'),
  dislike: song => call('/dislikes', { method: 'POST', body: { title: song.title, artist: song.artist, deezer_id: song.deezer_id || null } }),
  undislike: song => call('/dislikes/remove', { method: 'POST', body: song.key ? { key: song.key } : { title: song.title, artist: song.artist, deezer_id: song.deezer_id || null } }),
  follows: (force = false) => call(`/follows${q({ force })}`),
  follow: artist => call('/follows', { method: 'POST', body: artist }),
  unfollow: id => call(`/follows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  followSeen: id => call(`/follows/${encodeURIComponent(id)}/seen`, { method: 'POST', body: {} }),

  lyrics: song => call(`/lyrics${q({ title: song.title, artist: song.artist, album: song.album, duration: Math.round(song.duration || 0) || undefined })}`),

  update: (build, force = false) => call(`/update${q({ build, force })}`),
  downloadUpdate: (abi, build) => call('/update/download', { method: 'POST', body: { abi, build } }),
  updateStatus: () => call('/update/status'),

  castStart: ip => call('/cast/start', { method: 'POST', body: { ip } }),
  castStop: () => call('/cast/stop', { method: 'POST', body: {} }),
  castAllow: ids => call('/cast/allow', { method: 'POST', body: { ids } }),

  sources: () => call('/sources'),
  installSourceId: id => call(`/sources/${encodeURIComponent(id)}/install`, { method: 'POST', body: {} }),
  enableSource: (id, enabled) => call(`/sources/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: { enabled } }),
  orderSources: ids => call('/sources/order', { method: 'PUT', body: { ids } }),

  source: () => call('/source'),
  installSource: () => call('/source/install', { method: 'POST', body: {} }),
  verifyInfo: (id, { force = false } = {}) => call('/source/verify-info', { method: 'POST', body: { id, force } }),
  verifyComplete: body => call('/source/verify-complete', { method: 'POST', body }),
}

const withToken = url => mediaToken ? `${url}${url.includes('?') ? '&' : '?'}t=${mediaToken}` : url
export const streamUrl = id => withToken(`${base}/api/stream/${encodeURIComponent(id)}`)
/** A catalogue song for the phone's player: downloaded by the server, then streamed. */
export const playUrl = (song, { origin = null, ahead = [] } = {}) => withToken(`${base}/api/play/${encodeURIComponent(song.deezer_id)}?${new URLSearchParams({ title: song.title || '', artist: song.artist || '', album: song.album || '', duration: String(song.duration || ''), cover: song.cover || '', ...(origin ? { origin } : {}), ...(ahead.length ? { ahead: ahead.join(',') } : {}) })}`)
export const artUrl = id => withToken(`${base}/api/art/${encodeURIComponent(id)}`)
