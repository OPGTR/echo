// The app's state: navigation (a stack of screens), toasts, downloads, the
// source's state. The player has its own store (player.js).
import { create } from 'zustand'
import { api } from './api'

let toastSeq = 0
export const useApp = create((set, get) => ({
  tab: 'home',
  stack: [], // screens opened over the tab: { type, ...params }
  toasts: [],
  sheet: null, // an action sheet: { title, items: [{ label, icon, onSelect, danger }] }
  downloads: [],
  source: null,
  libraryVersion: 0,

  setTab: tab => set({ tab, stack: [] }),
  open: screen => set(s => ({ stack: [...s.stack, screen] })),
  back: () => {
    const s = get()
    if (s.sheet) { set({ sheet: null }); return true }
    if (s.stack.length) { set({ stack: s.stack.slice(0, -1) }); return true }
    if (s.tab !== 'home') { set({ tab: 'home' }); return true }
    return false
  },
  showSheet: sheet => set({ sheet }),
  closeSheet: () => set({ sheet: null }),

  toast: (message, action = null) => {
    const id = ++toastSeq
    set(s => ({ toasts: [...s.toasts.slice(-2), { id, message, action }] }))
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })), action ? 7000 : 3500)
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
export function watchDownloads() {
  if (pollTimer) return
  const tick = async () => {
    const list = await useApp.getState().refreshDownloads()
    const busy = list.some(d => ['queued', 'downloading', 'saving'].includes(d.status))
    pollTimer = setTimeout(tick, busy ? 800 : 5000)
  }
  tick()
}
export function pokeDownloads() {
  clearTimeout(pollTimer); pollTimer = null; watchDownloads()
}
