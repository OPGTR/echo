// A song in a list. On the right, its state in Écho's ring language:
//   ● filled  you have it (plays offline)
//   ○ ring    from the catalogue (downloads when you play it)
//   ◔ arc     downloading
//   ◎ pulse   playing now
import React from 'react'
import { MoreVertical, Music2, Play, ListPlus, ListEnd, Download, User, Disc3, Trash2, Heart } from 'lucide-react'
import { useApp } from '../store'
import { usePlayer, keyOf, coverOf, playNext, addToQueue, toggleLike, playList } from '../player'
import { api } from '../api'
import { t } from '../i18n'

export function StateMark({ song, progress = null, size = 22 }) {
  const isCurrent = usePlayer(s => { const c = s.queue[s.index]; return !!c && keyOf(c) === keyOf(song) })
  const playing = usePlayer(s => s.playing)
  const c = size / 2
  if (isCurrent && playing) {
    return (
      <svg width={size} height={size} viewBox="0 0 22 22" aria-label={t('Lecture')}>
        <circle cx="11" cy="11" r="4" fill="var(--sodium)" />
        <circle className="pulse" cx="11" cy="11" r="6" fill="none" stroke="var(--sodium)" strokeWidth="1.5" />
      </svg>
    )
  }
  if (progress !== null) {
    const r = c - 2.5, len = 2 * Math.PI * r
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={t('Téléchargement…')} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--sodium)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - Math.max(0.04, progress / 100))} />
      </svg>
    )
  }
  if (song.local_id) return <svg width={size} height={size} viewBox="0 0 22 22" aria-label={t('Tu l’as')}><circle cx="11" cy="11" r="4" fill="var(--muted)" /></svg>
  return <svg width={size} height={size} viewBox="0 0 22 22" aria-label={t('À télécharger')}><circle cx="11" cy="11" r="5" fill="none" stroke="var(--faint)" strokeWidth="1.6" /></svg>
}

export function Cover({ song, className = 'cover', size }) {
  const src = coverOf(song)
  const [broken, setBroken] = React.useState(false)
  if (!src || broken) return <div className={className} style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)', ...(size ? { width: size, height: size } : {}) }}><Music2 size={18} /></div>
  return <img className={className} src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} style={size ? { width: size, height: size } : undefined} />
}

/** The song's menu (the ⋮ button, or a long press). */
export function songMenu(song) {
  const app = useApp.getState()
  const items = [
    { label: t('Lire ensuite'), icon: ListPlus, onSelect: () => playNext([song]) },
    { label: t('Ajouter à la file'), icon: ListEnd, onSelect: () => addToQueue([song]) },
  ]
  if (song.local_id) {
    const liked = usePlayer.getState().liked[song.local_id] ?? !!song.liked
    items.push({ label: liked ? t('Retirer des titres aimés') : t('Ajouter aux titres aimés'), icon: Heart, onSelect: () => toggleLike(song.local_id) })
  }
  if (!song.local_id && song.deezer_id) items.push({ label: t('Télécharger'), icon: Download, onSelect: () => downloadSongs([song]) })
  if (song.artist) items.push({ label: t('Aller à l’artiste'), icon: User, onSelect: () => goToArtist(song) })
  if (song.album_id) items.push({ label: t('Aller à l’album'), icon: Disc3, onSelect: () => app.open({ type: 'catalogue-album', id: song.album_id }) })
  else if (song.local_id && song.album) items.push({ label: t('Aller à l’album'), icon: Disc3, onSelect: () => app.open({ type: 'album', album: song.album, artist: song.album_artist || song.artist }) })
  if (song.local_id) items.push({ label: t('Supprimer du téléphone'), icon: Trash2, danger: true, onSelect: async () => { const r = await api.remove(song.local_id).catch(e => ({ error: e.message })); if (r?.error) app.toast(r.error); app.libraryChanged() } })
  app.showSheet({ title: song.title, subtitle: song.artist, items })
}

export function goToArtist(song) {
  const app = useApp.getState()
  if (song.artist_id) app.open({ type: 'catalogue-artist', id: song.artist_id })
  else app.open({ type: 'artist', name: String(song.artist || '').split(/\s+(?:feat\.?|ft\.?)\s+|\s*,\s*/i)[0] })
}

export async function downloadSongs(songs) {
  const app = useApp.getState()
  const wanted = songs.filter(s => !s.local_id && s.deezer_id)
  if (!wanted.length) { app.toast(t('Tu as déjà tous ces titres.')); return }
  const source = app.source || await app.refreshSource()
  if (!source?.installed) { app.toast(t('Pour télécharger ce titre, installe d’abord la source Deezer (Réglages).'), { label: t('Réglages'), run: () => app.open({ type: 'settings' }) }); return }
  await api.download(wanted)
  const { pokeDownloads } = await import('../store')
  pokeDownloads()
  app.toast(t('{n} titres ajoutés aux téléchargements.', { n: wanted.length }), { label: t('Téléchargements'), run: () => app.open({ type: 'downloads' }) })
}

export function TrackRow({ song, onPlay, number = null, showCover = true }) {
  const isCurrent = usePlayer(s => { const c = s.queue[s.index]; return !!c && keyOf(c) === keyOf(song) })
  const job = useApp(s => (!song.local_id && song.deezer_id ? s.downloads.find(d => d.deezer_id === String(song.deezer_id) && ['queued', 'downloading', 'saving'].includes(d.status)) : null))
  let pressTimer = null
  const startPress = () => { pressTimer = setTimeout(() => { pressTimer = 'fired'; songMenu(song) }, 480) }
  const endPress = () => { if (pressTimer && pressTimer !== 'fired') clearTimeout(pressTimer) }
  return (
    <div className="row">
      <button type="button" className={`track ${isCurrent ? 'current' : ''}`}
        onClick={() => { if (pressTimer === 'fired') { pressTimer = null; return } onPlay?.() }}
        onTouchStart={startPress} onTouchEnd={endPress} onTouchMove={endPress}
        onContextMenu={e => { e.preventDefault(); songMenu(song) }}>
        {number !== null && <span className="track-num">{number}</span>}
        {showCover && <Cover song={song} />}
        <span className="text">
          <span className="title" style={{ display: 'block' }}>{song.title}{song.version ? ` ${song.version}` : ''}</span>
          <span className="sub" style={{ display: 'block' }}>{song.artist}</span>
        </span>
        <span className="state"><StateMark song={song} progress={job ? (job.status === 'queued' ? 0 : job.progress) : null} /></span>
      </button>
      <button type="button" className="more" aria-label={t('Plus')} onClick={() => songMenu(song)}><MoreVertical size={18} /></button>
    </div>
  )
}

export function TrackList({ songs, context, numbered = false, showCover = true, onPlayAt }) {
  return (
    <div className="tracks">
      {songs.map((song, i) => (
        <TrackRow key={`${keyOf(song)}-${i}`} song={song} number={numbered ? (song.track_no || i + 1) : null} showCover={showCover}
          onPlay={() => (onPlayAt ? onPlayAt(i) : playList(songs, i))} />
      ))}
    </div>
  )
}
