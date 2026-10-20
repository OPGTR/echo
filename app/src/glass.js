// Liquid glass: each pane bends what passes under it, like a real piece of
// glass. A lens is made for each pane from its own size and corners: the
// edges refract strongly (the rim of a curved glass), the middle magnifies a
// little. It is an SVG displacement map used as the pane's backdrop filter
// (Chromium, so Android's WebView); elsewhere the panes are just frosted.

const PANES = [
  '.player-bottom', '.sheet', '.card-surface', '.set-card', '.q-opt', '.device-pill', '.sq-btn',
  '.chip', '.segments button', '.btn.quiet', '.field', '.mix-card .art', '.start-grid button', '.svc-row button', '.dir-row button',
].join(', ')
const FILTER = 'blur(5px) saturate(1.8) brightness(1.08)'
// Menus frost more, so what they say stays easy to read. The music bubble
// and the tab bar are frosted glass without a lens (styles.css): a lens
// on them doesn't line up with what scrolls under them.
const FROSTED = '.sheet'
const FILTER_FROSTED = 'blur(12px) saturate(1.6) brightness(.92)'

let on = false
let defs = null
const made = new Map() // "w×h×r" -> filter id
let watched = new WeakSet()
let resize = null
let mutations = null
let pending = false

/** Distance to the edge of a rounded box (negative inside). */
function sdf(x, y, w, h, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - h / 2) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** The displacement map: red = sideways, green = up/down, around 128. */
function lensMap(w, h, r) {
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(w, h)
  const bezel = Math.min(40, Math.min(w, h) * 0.45)
  const rim = 0.42 * bezel // refraction at the very edge, without folding
  const dx = new Float32Array(w * h), dy = new Float32Array(w * h)
  let max = 1e-3
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5
      const d = sdf(px, py, w, h, r)
      let ox = -(px - w / 2) * 0.07, oy = -(py - h / 2) * 0.07 // a slight magnifying glass
      const inside = -d
      if (inside >= 0 && inside < bezel) {
        const gx = sdf(px + 1, py, w, h, r) - sdf(px - 1, py, w, h, r)
        const gy = sdf(px, py + 1, w, h, r) - sdf(px, py - 1, w, h, r)
        const n = Math.hypot(gx, gy) || 1
        const t = 1 - inside / bezel
        const m = rim * t * t
        ox -= gx / n * m; oy -= gy / n * m // the rim bends what is under it inward
      }
      const i = y * w + x
      dx[i] = ox; dy[i] = oy
      max = Math.max(max, Math.abs(ox), Math.abs(oy))
    }
  }
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = Math.round(128 + dx[i] / max * 127)
    img.data[i * 4 + 1] = Math.round(128 + dy[i] / max * 127)
    img.data[i * 4 + 2] = 128
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return { url: canvas.toDataURL('image/png'), scale: Math.round(max * 2 * 10) / 10 }
}

function filterFor(w, h, r) {
  const key = `${w}x${h}x${r}`
  if (made.has(key)) return made.get(key)
  if (!defs) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0')
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none'
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    svg.appendChild(defs)
    document.body.appendChild(svg)
  }
  const id = `lens-${made.size + 1}`
  const { url, scale } = lensMap(w, h, r)
  const NS = 'http://www.w3.org/2000/svg'
  const f = document.createElementNS(NS, 'filter')
  for (const [k, v] of Object.entries({ id, x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) f.setAttribute(k, String(v))
  const image = document.createElementNS(NS, 'feImage')
  for (const [k, v] of Object.entries({ href: url, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map' })) image.setAttribute(k, String(v))
  const disp = document.createElementNS(NS, 'feDisplacementMap')
  for (const [k, v] of Object.entries({ in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G' })) disp.setAttribute(k, String(v))
  f.append(image, disp)
  defs.appendChild(f)
  made.set(key, id)
  return id
}

function fit(el) {
  if (!on) return
  const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight)
  if (w < 8 || h < 8 || w * h > 700 * 1200) return
  const r = Math.min(Math.round(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0), Math.floor(Math.min(w, h) / 2))
  const value = `url(#${filterFor(w, h, r)}) ${el.matches(FROSTED) ? FILTER_FROSTED : FILTER}`
  if (el.style.backdropFilter !== value) { el.style.backdropFilter = value; el.style.webkitBackdropFilter = value }
}

function scan() {
  pending = false
  if (!on) return
  document.querySelectorAll(PANES).forEach(el => {
    if (!watched.has(el)) { watched.add(el); resize.observe(el) }
    fit(el)
  })
}

/** Turns the lenses on (Liquid glass) or off (other themes). */
export function liquidGlass(enable) {
  // Only Chromium applies SVG filters to what is behind an element.
  const supported = typeof CSS !== 'undefined' && CSS.supports?.('backdrop-filter', 'url(#a) blur(1px)') && /Chrome\//.test(navigator.userAgent)
  enable = !!enable && supported
  if (enable === on) return
  on = enable
  if (on) {
    watched = new WeakSet()
    resize = new ResizeObserver(entries => entries.forEach(e => fit(e.target)))
    mutations = new MutationObserver(() => { if (!pending) { pending = true; requestAnimationFrame(scan) } })
    mutations.observe(document.body, { childList: true, subtree: true })
    scan()
  } else {
    resize?.disconnect(); mutations?.disconnect()
    document.querySelectorAll(PANES).forEach(el => { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = '' })
  }
}
