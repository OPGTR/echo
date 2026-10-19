// Themes: Nuit indigo (Écho's own), Liquid glass, Luce, Material You (the
// phone's wallpaper colors) and a fixed color of your choice. Each sets the
// color tokens; glass and Luce also change surfaces (styles.css).
import { dynamicColors } from './native'
import { liquidGlass } from './glass'

const root = () => document.documentElement

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const luminance = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
/** Text that reads on top of `hex`. */
export const inkOn = hex => { const rgb = hexToRgb(hex); return rgb && luminance(rgb) > 0.35 ? '#1b1500' : '#ffffff' }

const VARS = ['--night', '--deep', '--surface', '--line', '--text', '--muted', '--faint', '--sodium', '--sodium-ink']

export async function applyTheme(prefs = {}) {
  const el = root()
  const theme = prefs.theme || 'indigo'
  VARS.forEach(v => el.style.removeProperty(v))
  el.dataset.theme = theme === 'material' || theme === 'fixed' ? 'indigo' : theme
  liquidGlass(theme === 'glass')
  let accent = null
  if (theme === 'fixed') accent = prefs.accent || '#f2c14e'
  if (theme === 'material') {
    const c = await dynamicColors()
    if (c?.available) {
      el.style.setProperty('--night', c.n900)
      el.style.setProperty('--deep', c.n800)
      el.style.setProperty('--surface', c.b800)
      el.style.setProperty('--line', c.b700)
      el.style.setProperty('--text', c.n50)
      el.style.setProperty('--muted', c.n200)
      el.style.setProperty('--faint', c.a300)
      accent = c.a200
    } else accent = '#a8c7fa'
  }
  if (accent) {
    el.style.setProperty('--sodium', accent)
    el.style.setProperty('--sodium-ink', inkOn(accent))
  }
  const night = getComputedStyle(el).getPropertyValue('--night').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', night || '#1a1838')
}
