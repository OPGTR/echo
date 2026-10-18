// What surrounds every screen: the tab bar, the mini player (its play button
// rings with the song's progress), the full player with lyrics and casting,
// the queue, sheets, toasts.
import React, { useEffect, useRef, useState } from 'react'
import { Sparkles, Search, Library, ListMusic, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Heart, ChevronDown, Loader2, Download, Settings, X, MicVocal, Cast, Smartphone, Tv, Speaker, ArrowUpCircle, Check } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { usePlayer, toggle, next, previous, seek, toggleShuffle, cycleRepeat, toggleLike, openFull, coverOf, keyOf, jumpTo, removeFromQueue, codecLabel, castScan, castTo, stopCasting } from '../player'
import { onEngine } from '../engine'
import { Cover, StateMark, goToArtist } from './Track'
import { t } from '../i18n'

export function TabBar() {
  const tab = useApp(s => s.tab)
  const stack = useApp(s => s.stack)
  const setTab = useApp(s => s.setTab)
  const unseen = useApp(s => s.follows.unseen)
  const tabs = [['home', Sparkles, 'Pour toi'], ['search', Search, 'Rechercher'], ['playlists', ListMusic, 'Playlists'], ['library', Library, 'Bibliothèque']]
  return (
    <nav className="tabbar" aria-label="Écho">
      {tabs.map(([id, Icon, label]) => (
        <button key={id} type="button" aria-current={tab === id && !stack.length ? 'page' : undefined} onClick={() => setTab(id)}>
          <span className="tab-icon"><Icon size={22} strokeWidth={tab === id ? 2.3 : 1.8} />{id === 'library' && unseen > 0 && <i className="dot" aria-label={t('Nouveautés')} />}</span>
          <span className="tab-label">{t(label)}</span>
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
        <circle className="ring-bg" cx={size / 2} cy={size / 2} r={r} fill={big ? 'var(--sodium)' : 'none'} stroke="color-mix(in srgb, var(--sodium) 25%, transparent)" strokeWidth="3" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={big ? 'var(--text)' : 'var(--sodium)'} strokeWidth="3" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - pct)} />
      </svg>
      <span className="ring-icon" style={{ position: 'relative', display: 'grid', placeItems: 'center', color: big ? 'var(--sodium-ink)' : 'var(--sodium)' }}>
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

/** The codec of the song playing: green dot for lossless. */
function CodecBadge({ song }) {
  const details = usePlayer(s => (song?.local_id ? s.details[song.local_id] : null))
  const info = codecLabel(details)
  if (!info) return null
  const extra = details?.bits && details?.sample_rate && info.lossless ? `${details.bits} bits · ${(details.sample_rate / 1000).toLocaleString('fr-FR')} kHz` : details?.bitrate ? `${Math.round(details.bitrate / 1000)} kbps` : ''
  return (
    <button type="button" className="sq-btn badge" aria-label={`${t('Qualité')} : ${info.label} ${extra}`} title={extra}
      onClick={() => useApp.getState().toast(`${info.label}${extra ? ` · ${extra}` : ''}${info.lossless ? ` · ${t('sans perte')}` : ''}`)}>
      <i className={`codec-dot ${info.lossless ? 'lossless' : ''}`} />{info.label}
    </button>
  )
}

export function FullPlayer() {
  const open = usePlayer(s => s.fullOpen)
  const song = usePlayer(s => s.queue[s.index])
  const { position, duration, shuffle, repeat, loading, playing, cast } = usePlayer()
  const liked = usePlayer(s => (song?.local_id ? !!s.liked[song.local_id] : false))
  const failed = usePlayer(s => s.failed)
  const [scrub, setScrub] = useState(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [castOpen, setCastOpen] = useState(false)
  const job = useApp(s => (song && !song.local_id && song.deezer_id ? s.downloads.find(d => d.deezer_id === String(song.deezer_id)) : null))
  if (!open || !song) return null
  const cover = coverOf(song)
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat
  const device = cast.casting && cast.device ? cast.device : null
  const DeviceIcon = device ? (device.kind === 'speaker' ? Speaker : Tv) : Smartphone
  return (
    <div className="full" role="dialog" aria-modal="true" aria-label={t('Lecture')}>
      {cover && <div className="glow" style={{ backgroundImage: `url("${cover}")` }} />}
      <div className="bar">
        <button type="button" className="icon-btn" style={{ color: 'var(--text)' }} onClick={() => openFull(false)} aria-label={t('Fermer')}><ChevronDown size={28} /></button>
        <button type="button" className="icon-btn" style={{ color: 'var(--text)' }} onClick={() => setQueueOpen(true)} aria-label={t('File d’attente')}><ListMusic size={22} /></button>
      </div>
      <div className="player-tools">
        <CodecBadge song={song} />
        <button type="button" className="sq-btn" onClick={() => setLyricsOpen(true)} aria-label={t('Paroles et karaoké')}><MicVocal size={18} /></button>
      </div>
      <Cover song={song} className="cover-big" />
      <div className="player-bottom">
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
        <div className={`fetching ${failed ? 'err' : ''}`} role="status">
          {failed ? t('Pas pu télécharger ce titre. Touche lecture pour réessayer.') : !song.local_id && playing ? (job?.status === 'saving' ? t('Enregistrement…') : `${t('Téléchargement…')} ${job?.progress ? Math.round(job.progress) + ' %' : ''}`) : ''}
        </div>
        <div className="seek">
          <input type="range" min="0" max={Math.max(1, duration)} step="0.5" value={scrub ?? position}
            aria-label={t('Position')}
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
        <div className="device-row">
          <button type="button" className={`device-pill ${device ? 'on' : ''}`} onClick={() => setCastOpen(true)} aria-label={`${t('Écoute sur')} ${device ? device.name : t('Ce téléphone')}, ${t('changer d’appareil')}`}>
            {device ? <Cast size={20} /> : <DeviceIcon size={20} />}{device ? device.name : t('Ce téléphone')}
          </button>
        </div>
      </div>
      {queueOpen && <QueueSheet onClose={() => setQueueOpen(false)} />}
      {lyricsOpen && <Karaoke song={song} onClose={() => setLyricsOpen(false)} />}
      {castOpen && <CastSheet onClose={() => setCastOpen(false)} />}
    </div>
  )
}

// ------------------------------------------------------------------ lyrics
/** Synced lyrics, big, the line being sung lit; touch a line to go there. */
function Karaoke({ song, onClose }) {
  const [data, setData] = useState(null)
  const position = usePlayer(s => s.position)
  const playing = usePlayer(s => s.playing)
  const box = useRef(null)
  useEffect(() => {
    let alive = true
    setData(null)
    api.lyrics(song).then(d => { if (alive) setData(d) }).catch(() => { if (alive) setData({ found: false, synced: [] }) })
    return () => { alive = false }
  }, [song.title, song.artist])
  const lines = data?.synced || []
  // A little ahead, so the line lights as it's sung.
  const now = position + 0.25
  let current = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].t <= now) current = i; else break
  useEffect(() => {
    const el = box.current?.querySelector(`[data-line="${current}"]`)
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current])
  const progress = current >= 0 && current + 1 < lines.length ? Math.min(1, (now - lines[current].t) / Math.max(0.5, lines[current + 1].t - lines[current].t)) : 0
  return (
    <div className="karaoke" role="dialog" aria-modal="true" aria-label={t('Paroles')}>
      <div className="k-head">
        <button type="button" className="icon-btn" style={{ color: 'var(--text)' }} onClick={onClose} aria-label={t('Retour au lecteur')}><ChevronDown size={28} /></button>
        <Cover song={song} />
        <div className="text"><div className="title">{song.title}</div><div className="sub">{song.artist}</div></div>
      </div>
      <div className="k-lines" ref={box}>
        {!data && <div className="empty"><Loader2 className="spin" /></div>}
        {data && !data.found && <div className="empty"><strong>{t('Pas de paroles pour ce titre.')}</strong>{t('Elles viennent de LRCLIB, une base libre : certains titres n’y sont pas encore.')}</div>}
        {data?.found && !lines.length && <div className="k-plain">{data.plain}</div>}
        {lines.map((l, i) => (
          <button type="button" key={i} data-line={i} className={`k-line ${i === current ? 'now' : i < current ? 'past' : ''}`} onClick={() => seek(l.t)}
            style={i === current ? { '--k': `${Math.round(progress * 100)}%` } : undefined}>
            {l.line || '♪'}
          </button>
        ))}
      </div>
      {lines.length > 0 && <p className="k-note">{t('Paroles synchronisées · touche une ligne pour y aller')}</p>}
      <div className="k-controls">
        <button type="button" className="icon-btn" onClick={previous} aria-label={t('Précédent')}><SkipBack size={26} fill="currentColor" /></button>
        <button type="button" className="k-play" onClick={toggle} aria-label={playing ? t('Pause') : t('Lire')}>{playing ? <Pause size={26} fill="currentColor" strokeWidth={0} /> : <Play size={26} fill="currentColor" strokeWidth={0} />}</button>
        <button type="button" className="icon-btn" onClick={() => next()} aria-label={t('Suivant')}><SkipForward size={26} fill="currentColor" /></button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ casting
function CastSheet({ onClose }) {
  const [devices, setDevices] = useState(null)
  const cast = usePlayer(s => s.cast)
  useEffect(() => {
    castScan(true).then(setDevices)
    const off = onEngine(e => { if (e.type === 'devices') setDevices(e.devices || []) })
    const timer = setTimeout(() => setDevices(d => d || []), 6000)
    return () => { off(); clearTimeout(timer); castScan(false) }
  }, [])
  const onPhone = !cast.casting
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={t('Écouter sur')}>
        <div className="grab" />
        <h3>{t('Écouter sur')}</h3>
        <div className="sheet-sub">{t('Appareils sur le même Wi-Fi que ton téléphone')}</div>
        <button type="button" className={`device ${onPhone ? 'on' : ''}`} onClick={async () => { if (!onPhone) await stopCasting(); onClose() }}>
          <span className="di"><Smartphone size={22} /></span>
          <span className="text"><span className="title">{t('Ce téléphone')}</span>{onPhone && <span className="sub">{t('En cours')}</span>}</span>
          {onPhone && <Check size={20} />}
        </button>
        {devices === null && <div className="device"><span className="di"><Loader2 size={22} className="spin" /></span><span className="text"><span className="sub">{t('Recherche des appareils…')}</span></span></div>}
        {(devices || []).map(d => {
          const Icon = d.kind === 'speaker' ? Speaker : Tv
          const on = cast.casting && cast.device?.id === d.id
          return (
            <button type="button" key={d.id} className={`device ${on ? 'on' : ''}`} onClick={async () => { await castTo(d); onClose() }}>
              <span className="di"><Icon size={22} /></span>
              <span className="text"><span className="title">{d.name}</span><span className="sub">{d.connecting ? t('Connexion…') : on ? t('En cours') : d.description || 'Chromecast'}</span></span>
              {on && <Check size={20} />}
            </button>
          )
        })}
        {devices && !devices.length && <p className="note" style={{ marginTop: 10 }}>{t('Aucune TV ni enceinte trouvée. Vérifie qu’elle est allumée et sur le même Wi-Fi.')}</p>}
      </div>
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
        {!upNext.length && <p className="note">{t('Rien après ce titre.')}</p>}
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
        {sheet.items.map((item, i) => (
          <button key={`${item.label}-${i}`} type="button" className={`sheet-item ${item.danger ? 'danger' : ''} ${item.checked ? 'checked' : ''}`} onClick={() => { if (!item.keepOpen) close(); item.onSelect() }}>
            {item.icon ? <item.icon size={20} /> : <span style={{ width: 20 }} />}<span style={{ flex: 1 }}>{item.label}</span>{item.hint && <span className="hint">{item.hint}</span>}{item.checked && <Check size={20} className="check" />}
          </button>
        ))}
        {sheet.footer}
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

/** Downloads and Settings, top right of each tab (and the update, when there is one). */
export function HeadActions({ withUpdate = false }) {
  const open = useApp(s => s.open)
  const downloads = useApp(s => s.downloads)
  const update = useApp(s => s.update)
  const active = downloads.filter(d => ['queued', 'downloading', 'saving'].includes(d.status))
  const failed = downloads.some(d => d.status === 'error')
  const pct = active.length ? active.reduce((n, d) => n + (d.progress || 0), 0) / active.length : 0
  return (
    <>
      {withUpdate && update?.available && (
        <button type="button" className="icon-btn on" onClick={() => open({ type: 'update' })} aria-label={t('Mise à jour disponible')} style={{ position: 'relative' }}>
          <ArrowUpCircle size={22} /><i className="head-dot" />
        </button>
      )}
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
