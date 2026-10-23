// Motion that follows the finger: springs that start from where things are
// and how fast they go, so a panel can be caught mid-way, thrown, and lands
// without a seam (Apple's "Designing Fluid Interfaces").

/** "Supprimer les animations" in Android's settings: no movement, no springs. */
export const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * A spring from `from` (moving at `velocity` units/s) to `to`. Apple's two
 * settings: `response` (s, how quickly it gets there) and `damping` (1 = no
 * overshoot, 0.8 = a little bounce). `onFrame(value)` writes it on screen.
 * Returns stop(), which leaves the value where it is (`current()` reads it).
 */
export function spring({ from, to, velocity = 0, response = 0.35, damping = 1, onFrame, onDone }) {
  const k = Math.pow((2 * Math.PI) / response, 2)
  const c = 2 * damping * Math.sqrt(k)
  let x = from, v = velocity, last = performance.now(), raf = 0, stopped = false
  // Close enough: a fraction of the way (works for pixels and for 0–1 progress alike).
  const settle = Math.max(Math.abs(to - from) * 0.002, Math.abs(velocity) * 0.0005, 1e-4)
  if (reducedMotion()) { onFrame(to); onDone?.(); return { stop() {}, current: () => to, velocity: () => 0 } }
  const step = now => {
    if (stopped) return
    const dt = Math.min(0.032, (now - last) / 1000)
    last = now
    for (let i = 0; i < 4; i++) { const a = -k * (x - to) - c * v; v += (a * dt) / 4; x += (v * dt) / 4 }
    if (Math.abs(x - to) < settle && Math.abs(v) < settle * 10) { x = to; v = 0; onFrame(x); onDone?.(); return }
    onFrame(x)
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return { stop() { stopped = true; cancelAnimationFrame(raf) }, current: () => x, velocity: () => v }
}

/** Past an edge, the further you pull the less it follows (no hard wall). */
export const rubber = (over, size, c = 0.55) => (over * size * c) / (size + c * Math.abs(over))

/** Where a throw at `velocity` (units/s) would come to rest, like a scroll slowing down. */
export const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate)

/** The finger's speed at release: the last 100 ms of movement, in units/s. */
export function tracker() {
  let samples = []
  return {
    reset(value) { samples = [{ value, at: performance.now() }] },
    add(value) {
      const at = performance.now()
      samples.push({ value, at })
      while (samples.length > 2 && at - samples[0].at > 100) samples.shift()
    },
    velocity() {
      if (samples.length < 2) return 0
      const a = samples[0], b = samples[samples.length - 1]
      return b.at > a.at ? ((b.value - a.value) / (b.at - a.at)) * 1000 : 0
    },
  }
}
