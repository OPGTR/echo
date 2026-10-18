// Écho's signature: a mix's cover is its echo. Concentric rings spread from
// a center that holds one of the mix's covers, like a record's label; the
// colours come from the mix (the same mix always looks the same).
import React, { useId } from 'react'

const HUES = [
  ['#f2c14e', '#3a2f7a'], // sodium on indigo
  ['#8fd3c7', '#203a5c'], // ice mint on deep blue
  ['#f09ab6', '#41245e'], // rose on plum
  ['#b9a6ff', '#2a2560'], // lilac on night
  ['#7fb7ff', '#1d2e5e'], // sky on navy
  ['#e8b27a', '#4a2a3f'], // amber on wine
]

function hash(text) {
  let h = 2166136261
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return h >>> 0
}

export default function Rings({ seed = '', label = '', center = null, size = 164, big = false }) {
  const id = useId().replace(/:/g, '')
  const h = hash(seed)
  const [ink, ground] = HUES[h % HUES.length]
  const rings = 7 + (h % 4)
  const offset = ((h >> 4) % 20) - 10
  const cx = 50 + offset * 0.6
  const cy = 50 - offset * 0.3
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-label={label} style={{ display: 'block' }}>
      <defs>
        <clipPath id={`c${id}`}><circle cx={cx} cy={cy} r="15" /></clipPath>
      </defs>
      <rect width="100" height="100" fill={ground} />
      {Array.from({ length: rings }, (_, i) => {
        const r = 19 + i * (big ? 9 : 10)
        const strong = i % 3 === 0
        return <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={ink} strokeWidth={strong ? 2.4 : 1.1} strokeOpacity={Math.max(0.12, 0.85 - i * 0.1)} />
      })}
      <circle cx={cx} cy={cy} r="16.5" fill={ink} />
      {center
        ? <image href={center} x={cx - 15} y={cy - 15} width="30" height="30" clipPath={`url(#c${id})`} preserveAspectRatio="xMidYMid slice" />
        : <circle cx={cx} cy={cy} r="3" fill={ground} />}
      {label && (
        <text x="8" y="92" fill="#fff" fontFamily="'Bricolage Grotesque Variable', sans-serif" fontWeight="700" fontSize={label.length > 14 ? 8 : 10} style={{ letterSpacing: '-0.02em' }}>
          {label.length > 22 ? label.slice(0, 21) + '…' : label}
        </text>
      )}
    </svg>
  )
}
