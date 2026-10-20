// The app's state: navigation (a stack of screens), toasts, downloads, the
// source's state. The player has its own store (player.js).
import { create } from 'zustand'
import { api } from './api'
import { scanFiles } from './native'

export const DEFAULT_PREFS = {
  theme: 'indigo', // indigo | glass | luce | material | fixed
  accent: '#f2c14e', // the fixed color
  icon: 'Default',
  startTab: 'home',
  sections: { follows: true, daily: true, custom: true, rediscover: true, discover: true, chart: true },
  eq: { enabled: false, preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 },
  audioTest: null, // { limit: Hz, at, recommended }
}

let toastSeq = 0
export const useApp = create((set, get) => ({
  tab: 'home',
  stack: [], // screens opened over the tab: { type, ...params }
  toasts: [],
  sheet: null, // an action sheet: { title, items: [{ label, icon, onSelect, danger }] }
  selection: null, // several songs picked by a long press: { items: { key: song }, all: [songs], playlistId }
  dialog: null, // an Écho window asking for a name or a color: { kind: 'text' | 'color', ..., resolve }
  downloads: [],
  source: null,
  libraryVersion: 0,
  prefs: DEFAULT_PREFS,
  follows: { artists: [], news: [], unseen: 0 },
  update: null, // { available, version, build, assets }
  appBuild: 0,

  setPrefs: patch => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs })
    api.savePrefs(patch).catch(() => {})
    return prefs
  },
  refreshFollows: async (force = false) => { try { const follows = await api.follows(force); set({ follows }); return follows } catch { return get().follows } },

  setTab: tab => set({ tab, stack: [], selection: null }),
  open: screen => set(s => ({ stack: [...s.stack, screen], selection: null })),
  back: () => {
    const s = get()
    if (s.selection && !s.sheet && !s.dialog) { set({ selection: null }); return true }
    if (s.dialog) { s.closeDialog(null); return true }
    if (s.sheet) { set({ sheet: null }); return true }
    if (s.stack.length) { set({ stack: s.stack.slice(0, -1), selection: null }); return true }
    const start = s.prefs.startTab || 'home'
    if (s.tab !== start) { set({ tab: start }); return true }
    return false
  },
  showSheet: sheet => set({ sheet }),
  select: (song, key, { all = [], playlistId = null } = {}) => set(s => {
    const cur = s.selection || { items: {}, all, playlistId }
    const items = { ...cur.items }
    if (items[key]) delete items[key]; else items[key] = song
    return { selection: Object.keys(items).length ? { ...cur, all: all.length ? all : cur.all, items } : null }
  }),
  selectAll: keyOf => set(s => (s.selection ? { selection: { ...s.selection, items: Object.fromEntries(s.selection.all.map(x => [keyOf(x), x])) } } : {})),
  clearSelection: () => set({ selection: null }),
  /** Asks in an Écho window; resolves with the answer, or null when cancelled. */
  ask: dialog => new Promise(resolve => { get().dialog?.resolve(null); set({ dialog: { ...dialog, resolve } }) }),
  closeDialog: (value = null) => { const d = get().dialog; set({ dialog: null }); d?.resolve(value) },
  closeSheet: () => set({ sheet: null }),

  toast: (message, action = null) => {
    const id = ++toastSeq
    // One message at a time, briefly (a little longer with a button to touch).
    set({ toasts: [{ id, message, action }] })
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })), action ? 2800 : 1600)
  },
  dismissToast: id => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),

  libraryChanged: () => set(s => ({ libraryVersion: s.libraryVersion + 1 })),

  refreshSource: async () => { try { const source = await api.source(); set({ source }); return source } catch { return get().source } },
  refreshDownloads: async () => {
    try {
      const list = await api.downloads()
      const before = get().downloads
      const finished = list.some(d => d.status === 'done' && before.find(b => b.id === d.id && b.status !== 'done'))
      set({ downloads: list })
      if (finished) get().libraryChanged()
      return list
    } catch { return get().downloads }
  },
}))

// Downloads are watched while any runs (quickly) or now and then.
let pollTimer = null
let seenDone = null
export function watchDownloads() {
  if (pollTimer) return
  const tick = async () => {
    const list = await useApp.getState().refreshDownloads()
    // New songs: tell Android, so other music apps see them too.
    const done = list.filter(d => d.status === 'done' && d.path)
    if (seenDone) { const fresh = done.filter(d => !seenDone.has(d.id)).map(d => d.path); if (fresh.length) scanFiles(fresh) }
    seenDone = new Set(done.map(d => d.id))
    const busy = list.some(d => ['queued', 'downloading', 'saving'].includes(d.status))
    pollTimer = setTimeout(tick, busy ? 800 : 5000)
  }
  tick()
}
export function pokeDownloads() {
  clearTimeout(pollTimer); pollTimer = null; watchDownloads()
}
