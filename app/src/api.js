// Talking to Écho's server (Node.js inside the app, on 127.0.0.1).
let base = ''
let token = ''

export function setServer(info) { base = info.base.replace(/\/$/, ''); token = info.token || '' }

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
  download: items => call('/downloads', { method: 'POST', body: { items } }),
  cancelDownload: id => call(`/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  retryDownload: id => call(`/downloads/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} }),
  clearDownloads: () => call('/downloads', { method: 'DELETE' }),

  source: () => call('/source'),
  installSource: () => call('/source/install', { method: 'POST', body: {} }),
  verifyInfo: () => call('/source/verify-info', { method: 'POST', body: {} }),
  verifyComplete: body => call('/source/verify-complete', { method: 'POST', body }),
}

const withToken = url => token ? `${url}${url.includes('?') ? '&' : '?'}t=${token}` : url
export const streamUrl = id => withToken(`${base}/api/stream/${encodeURIComponent(id)}`)
export const artUrl = id => withToken(`${base}/api/art/${encodeURIComponent(id)}`)
