// What surrounds every screen: the tab bar, the mini player (its play button
// rings with the song's progress), the full player, the queue, sheets, toasts.
import React, { useEffect, useState } from 'react'
import { Sparkles, Search, Library, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Heart, ChevronDown, ListMusic, Loader2, Download, Settings, X } from 'lucide-react'
import { useApp } from '../store'
import { usePlayer, toggle, next, previous, seek, toggleShuffle, cycleRepeat, toggleLike, openFull, coverOf, keyOf, jumpTo, removeFromQueue } from '../player'
import { Cover, StateMark, goToArtist } from './Track'
import { t } from '../i18n'

export function TabBar() {
  const tab = useApp(s => s.tab)
  const stack = useApp(s => s.stack)
  const setTab = useApp(s => s.setTab)
  const tabs = [['home', Sparkles, 'Pour toi'], ['search', Search, 'Rechercher'], ['library', Library, 'Bibliothèque']]
  return (
    <nav className="tabbar" aria-label="Écho">
      {tabs.map(([id, Icon, label]) => (
        <button key={id} type="button" aria-current={tab === id && !stack.length ? 'page' : undefined} onClick={() => setTab(id)}>
          <Icon size={22} strokeWidth={tab === id ? 2.3 : 1.8} />
          {t(label)}
        </button>
      ))}
    </nav>
  )
}

/** The play button, with the song's progress drawn as a ring around it. */
export function RingPlay({ big = false }) {
  const playing = usePlayer(s => s.playing)
  const loading = usePlayer(s => s.loading)
  const position = usePlayer(s => s.position)
  const duration = usePlayer(s => s.duration)
  const size = big ? 84 : 52
  const r = size / 2 - 3
  const len = 2 * Math.PI * r
  const pct = duration > 0 ? Math.min(1, position / duration) : 0
  return (
    <button type="button" className={`ring-play ${big ? 'big' : ''}`} onClick={e => { e.stopPropagation(); toggle() }} aria-label={playing ? t('Pause') : t('Lire')}>
      <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill={big ? 'var(--sodium)' : 'none'} stroke="color-mix(in srgb, var(--sodium) 25%, transparent)" strokeWidth="3" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={big ? 'var(--text)' : 'var(--sodium)'} strokeWidth="3" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - pct)} />
      </svg>
      <span style={{ position: 'relative', display: 'grid', placeItems: 'center', color: big ? 'var(--sodium-ink)' : 'var(--sodium)' }}>
        {loading && playing ? <Loader2 size={big ? 30 : 20} className="spin" /> : playing ? <Pause size={big ? 32 : 20} fill="currentColor" strokeWidth={0} /> : <Play size={big ? 32 : 20} fill="currentColor" strokeWidth={0} style={{ marginLeft: big ? 4 : 2 }} />}
      </span>
    </button>
  )
}

export function MiniPlayer() {
  const song = usePlayer(s => s.queue[s.index])
  if (!song) return null
  return (
    <div className="mini" role="button" tabIndex={0} onClick={() => openFull(true)} onKeyDown={e => { if (e.key === 'Enter') openFull(true) }} aria-label={t('Lecture')}>
      <Cover song={song} />
      <div className="text">
        <div className="title">{song.title}</div>
        <div className="sub">{song.artist}</div>
      </div>
      <RingPlay />
      <button type="button" className="icon-btn" style={{ color: 'var(--text)' }} onClick={e => { e.stopPropagation(); next() }} aria-label={t('Suivant')}><SkipForward size={22} fill="currentColor" /></button>
    </div>
  )
}

const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export function FullPlayer() {
  const open = usePlayer(s => s.fullOpen)
  const song = usePlayer(s => s.queue[s.index])
  const { position, duration, shuffle, repeat, loading, playing } = usePlayer()
  const liked = usePlayer(s => (song?.local_id ? !!s.liked[song.local_id] : false))
  const [scrub, setScrub] = useState(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const job = useApp(s => (song && !song.local_id && song.deezer_id ? s.downloads.find(d => d.deezer_id === String(song.deezer_id)) : null))
  if (!open || !song) return null
  const cover = coverOf(song)
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat
  return (
    <div className="full" role="dialog" aria-modal="true" aria-label={t('Lecture')}>
      {cover && <div className="glow" style={{ backgroundImage: `url("${cover}")` }} />}
      <div className="bar">
        <button type="button" className="icon-btn" style={{ color: 'var(--text)' }} onClick={() => openFull(false)} aria-label={t('Fermer')}><ChevronDown size={28} /></button>
        <button type="button" className="icon-btn" style={{ color: 'var(--text)' }} onClick={() => setQueueOpen(true)} aria-label={t('File d’attente')}><ListMusic size={22} /></button>
      </div>
      <Cover song={song} className="cover-big" />
      <div className="meta">
        <div className="text">
          <h2>{song.title}</h2>
          <button type="button" className="artist" onClick={() => { openFull(false); goToArtist(song) }}>{song.artist}</button>
        </div>
        {song.local_id && (
          <button type="button" className={`icon-btn ${liked ? 'on' : ''}`} onClick={() => toggleLike(song.local_id)} aria-label={liked ? t('Retirer des titres aimés') : t('Ajouter aux titres aimés')}>
            <Heart size={24} fill={liked ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
      <div className="fetching" role="status">
        {!song.local_id && playing ? (job?.status === 'saving' ? t('Enregistrement…') : `${t('Téléchargement…')} ${job?.progress ? Math.round(job.progress) + ' %' : ''}`) : loading && playing ? '' : ''}
      </div>
      <div className="seek">
        <input type="range" min="0" max={Math.max(1, duration)} step="0.5" value={scrub ?? position}
          aria-label={t('Lecture')}
          onChange={e => setScrub(Number(e.target.value))}
          onPointerUp={() => { if (scrub !== null) { seek(scrub); setScrub(null) } }}
          onTouchEnd={() => { if (scrub !== null) { seek(scrub); setScrub(null) } }}
          onKeyUp={() => { if (scrub !== null) { seek(scrub); setScrub(null) } }} />
        <div className="times"><span>{fmt(scrub ?? position)}</span><span>{fmt(duration)}</span></div>
      </div>
      <div className="controls">
        <button type="button" className={`icon-btn ${shuffle ? 'on' : 'dim'}`} onClick={toggleShuffle} aria-label={t('Aléatoire')} aria-pressed={shuffle}><Shuffle size={22} /></button>
        <button type="button" className="icon-btn" onClick={previous} aria-label={t('Précédent')}><SkipBack size={30} fill="currentColor" /></button>
        <RingPlay big />
        <button type="button" className="icon-btn" onClick={() => next()} aria-label={t('Suivant')}><SkipForward size={30} fill="currentColor" /></button>
        <button type="button" className={`icon-btn ${repeat !== 'off' ? 'on' : 'dim'}`} onClick={cycleRepeat} aria-label={t('Répéter')} aria-pressed={repeat !== 'off'}><RepeatIcon size={22} /></button>
      </div>
      {queueOpen && <QueueSheet onClose={() => setQueueOpen(false)} />}
    </div>
  )
}

function QueueSheet({ onClose }) {
  const queue = usePlayer(s => s.queue)
  const index = usePlayer(s => s.index)
  const upNext = queue.map((song, i) => ({ song, i })).filter(x => x.i > index).slice(0, 200)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={t('File d’attente')}>
        <div className="grab" />
        <h3>{t('À suivre')}</h3>
        <div className="tracks">
          {upNext.map(({ song, i }) => (
            <div className="row" key={`${keyOf(song)}-${i}`}>
              <button type="button" className="track" onClick={() => { jumpTo(i); onClose() }}>
                <Cover song={song} />
                <span className="text"><span className="title" style={{ display: 'block' }}>{song.title}</span><span className="sub" style={{ display: 'block' }}>{song.artist}</span></span>
                <span className="state"><StateMark song={song} /></span>
              </button>
              <button type="button" className="more" aria-label={t('Retirer')} onClick={() => removeFromQueue(i)}><X size={18} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ActionSheet() {
  const sheet = useApp(s => s.sheet)
  const close = useApp(s => s.closeSheet)
  if (!sheet) return null
  return (
    <div className="scrim" onClick={close}>
      <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={sheet.title}>
        <div className="grab" />
        <h3>{sheet.title}</h3>
        {sheet.subtitle && <div className="sheet-sub">{sheet.subtitle}</div>}
        {sheet.items.map(item => (
          <button key={item.label} type="button" className={`sheet-item ${item.danger ? 'danger' : ''}`} onClick={() => { close(); item.onSelect() }}>
            {item.icon && <item.icon size={20} />}{item.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useApp(s => s.toasts)
  const dismiss = useApp(s => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map(x => (
        <div className="toast" key={x.id}>
          <span>{x.message}</span>
          {x.action && <button type="button" onClick={() => { dismiss(x.id); x.action.run() }}>{x.action.label}</button>}
        </div>
      ))}
    </div>
  )
}

/** Downloads and Settings, top right of each tab. Downloads shows its progress. */
export function HeadActions() {
  const open = useApp(s => s.open)
  const downloads = useApp(s => s.downloads)
  const active = downloads.filter(d => ['queued', 'downloading', 'saving'].includes(d.status))
  const failed = downloads.some(d => d.status === 'error')
  const pct = active.length ? active.reduce((n, d) => n + (d.progress || 0), 0) / active.length : 0
  return (
    <>
      <button type="button" className={`icon-btn ${active.length ? 'on' : ''}`} onClick={() => open({ type: 'downloads' })}
        aria-label={`${t('Téléchargements')}${active.length ? ` (${active.length})` : ''}`} style={{ position: 'relative' }}>
        {active.length ? (
          <svg width="26" height="26" viewBox="0 0 26 26" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="13" cy="13" r="10" fill="none" stroke="var(--line)" strokeWidth="2.5" />
            <circle cx="13" cy="13" r="10" fill="none" stroke="var(--sodium)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={62.8} strokeDashoffset={62.8 * (1 - Math.max(0.06, pct / 100))} />
          </svg>
        ) : <Download size={22} />}
        {failed && !active.length && <span style={{ position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: 4, background: 'var(--danger)' }} />}
      </button>
      <button type="button" className="icon-btn" onClick={() => open({ type: 'settings' })} aria-label={t('Réglages')}><Settings size={22} /></button>
    </>
  )
}
