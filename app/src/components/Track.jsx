// A song in a list. On the right, its state in Écho's ring language:
//   ● filled  you have it (plays offline)
//   ○ ring    from the catalogue (downloads when you play it)
//   ◔ arc     downloading
//   ◎ pulse   playing now
import React from 'react'
import { MoreVertical, Music2, Play, ListPlus, ListEnd, Download, User, Disc3, Trash2, Heart, ListMusic, Plus, MinusCircle, ThumbsDown, Check, Disc } from 'lucide-react'
import { useApp } from '../store'
import { usePlayer, keyOf, coverOf, playNext, addToQueue, toggleLike, playList } from '../player'
import { api } from '../api'
import { t, plural } from '../i18n'

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
export function songMenu(song, { playlistId = null, onChanged = null } = {}) {
  const app = useApp.getState()
  const items = [
    { label: t('Lire ensuite'), icon: ListPlus, onSelect: () => playNext([song]) },
    { label: t('Ajouter à la file'), icon: ListEnd, onSelect: () => addToQueue([song]) },
    { label: t('Ajouter à une playlist'), icon: ListMusic, onSelect: () => addToPlaylistMenu([song]) },
  ]
  if (playlistId && song.item_id) items.push({ label: t('Retirer de la playlist'), icon: MinusCircle, onSelect: async () => { await api.removeFromPlaylist(playlistId, song.item_id); onChanged?.() } })
  if (song.local_id) {
    const liked = usePlayer.getState().liked[song.local_id] ?? !!song.liked
    items.push({ label: liked ? t('Retirer des titres aimés') : t('Ajouter aux titres aimés'), icon: Heart, onSelect: () => toggleLike(song.local_id) })
  }
  if (song.artist) items.push({ label: t('Créer un mix de cet artiste'), detail: t('Que des titres de {name}', { name: mainArtistOf(song) }), icon: Disc, accent: true, onSelect: () => createArtistMix(song) })
  items.push({ label: t('Je n’aime pas ce titre'), detail: t('Il ne te sera plus proposé'), icon: ThumbsDown, onSelect: () => dislikeSong(song) })
  if (!song.local_id && song.deezer_id) items.push({ label: t('Télécharger'), icon: Download, onSelect: () => downloadSongs([song]) })
  if (song.artist) items.push({ label: t('Aller à l’artiste'), icon: User, onSelect: () => goToArtist(song) })
  if (song.album_id) items.push({ label: t('Aller à l’album'), icon: Disc3, onSelect: () => app.open({ type: 'catalogue-album', id: song.album_id }) })
  else if (song.local_id && song.album) items.push({ label: t('Aller à l’album'), icon: Disc3, onSelect: () => app.open({ type: 'album', album: song.album, artist: song.album_artist || song.artist }) })
  if (song.local_id) items.push({ label: t('Supprimer du téléphone'), icon: Trash2, danger: true, onSelect: async () => { const r = await api.remove(song.local_id).catch(e => ({ error: e.message })); if (r?.error) app.toast(r.error); app.libraryChanged() } })
  app.showSheet({ title: song.title, subtitle: song.artist, items })
}

const mainArtistOf = song => String(song.artist || '').split(/\s*(?:,|&|;|\/|\bfeat\.?|\bft\.?)\s*/i)[0]

/** "Créer un mix de cet artiste": only their songs, kept in "Tes mixes" (Pour toi). */
export async function createArtistMix(song) {
  const app = useApp.getState()
  const name = mainArtistOf(song)
  app.toast(t('Création du mix {name}…', { name }))
  try {
    let id = song.artist_id
    if (!id) { const found = await api.findArtist(name); id = found?.id }
    if (!id) throw new Error(t('Artiste introuvable dans le catalogue.'))
    const pl = await api.createArtistMix(id)
    app.libraryChanged()
    app.open({ type: 'playlist', id: pl.id })
  } catch (e) { app.toast(e.message) }
}

/** "Je n'aime pas ce titre": never proposed again (mixes, Pour toi). */
export async function dislikeSong(song) {
  const app = useApp.getState()
  try {
    await api.dislike(song)
    app.toast(t('« {title} » ne te sera plus proposé.', { title: song.title }), { label: t('Annuler'), run: () => api.undislike(song).catch(() => {}) })
  } catch (e) { app.toast(e.message) }
}

/** The name of a new playlist, asked in an Écho window. */
export function askPlaylistName(value = '', { title = t('Nouvelle playlist'), confirm = t('Créer') } = {}) {
  return useApp.getState().ask({ kind: 'text', title, label: t('Nom de la playlist'), value, placeholder: t('Ma playlist'), hint: t('Tu pourras la renommer plus tard.'), confirm })
}

/** Which playlist? (or a new one) */
export async function addToPlaylistMenu(songs) {
  const app = useApp.getState()
  let lists = []
  try { lists = (await api.playlists()).filter(p => p.kind !== 'mix') } catch {}
  const add = async pl => {
    try { await api.addToPlaylist(pl.id, songs); app.toast(t('Ajouté à « {name} ».', { name: pl.name })) } catch (e) { app.toast(e.message) }
  }
  app.showSheet({
    title: t('Ajouter à une playlist'),
    subtitle: songs.length === 1 ? `${songs[0].title} · ${songs[0].artist}` : t('{n} titres', { n: songs.length }),
    items: [
      { label: t('Nouvelle playlist'), icon: Plus, onSelect: async () => {
        const name = await askPlaylistName('')
        if (name === null) return
        try { const pl = await api.createPlaylist(name || t('Nouvelle playlist'), songs); app.toast(t('Playlist « {name} » créée.', { name: pl.name })) } catch (e) { app.toast(e.message) }
      } },
      ...lists.map(pl => ({ label: pl.name, icon: ListMusic, hint: String(pl.count), onSelect: () => add(pl) })),
    ],
  })
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
  if (!source?.installed) { app.toast(t('Pour télécharger ce titre, installe d’abord une source (Réglages).'), { label: t('Réglages'), run: () => app.open({ type: 'sources' }) }); return }
  await api.download(wanted)
  const { pokeDownloads } = await import('../store')
  pokeDownloads()
  app.toast(t('{n} titres ajoutés aux téléchargements.', { n: wanted.length }), { label: t('Téléchargements'), run: () => app.open({ type: 'downloads' }) })
}

/** How a song is told apart in a selection (a playlist can hold a song twice). */
export const selKey = song => (song.item_id ? `i:${song.item_id}` : keyOf(song))

/** Folds accents and case, so "cote" finds "Côté". */
export const fold = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/** The text with the part matching `q` (accents and case aside) in the accent colour. */
export function Marked({ text, q }) {
  const needle = fold(q).trim()
  const chars = Array.from(String(text || ''))
  if (!needle) return chars.join('')
  let folded = '', at = []
  chars.forEach((c, i) => { const f = fold(c); folded += f; for (let k = 0; k < f.length; k++) at.push(i) })
  const hit = folded.indexOf(needle)
  if (hit < 0) return chars.join('')
  const start = at[hit], end = at[hit + needle.length - 1] + 1
  return <>{chars.slice(0, start).join('')}<mark className="hit">{chars.slice(start, end).join('')}</mark>{chars.slice(end).join('')}</>
}

export function TrackRow({ song, onPlay, number = null, showCover = true, menu = null, group = null, playlistId = null, highlight = '' }) {
  const isCurrent = usePlayer(s => { const c = s.queue[s.index]; return !!c && keyOf(c) === keyOf(song) })
  const job = useApp(s => (!song.local_id && song.deezer_id ? s.downloads.find(d => d.deezer_id === String(song.deezer_id) && ['queued', 'downloading', 'saving'].includes(d.status)) : null))
  const key = selKey(song)
  const selecting = useApp(s => !!s.selection)
  const picked = useApp(s => !!s.selection?.items[key])
  const press = React.useRef(null)
  const openMenu = () => (menu ? menu(song) : songMenu(song))
  const pick = () => useApp.getState().select(song, key, { all: group || [song], playlistId })
  // A long press starts picking several songs; then a touch adds or removes one.
  const startPress = e => {
    const p = e.touches?.[0]
    press.current = { x: p?.clientX, y: p?.clientY, timer: setTimeout(() => { press.current = { fired: true }; navigator.vibrate?.(12); pick() }, 450) }
  }
  const movePress = e => {
    const p = e.touches?.[0], st = press.current
    if (st?.timer && p && Math.hypot(p.clientX - st.x, p.clientY - st.y) > 10) { clearTimeout(st.timer); press.current = null }
  }
  const endPress = () => { if (press.current?.timer) clearTimeout(press.current.timer) }
  return (
    <div className={`row ${picked ? 'picked' : ''}`}>
      <button type="button" className={`track ${isCurrent ? 'current' : ''}`} aria-pressed={selecting ? picked : undefined}
        onClick={() => { if (press.current?.fired) { press.current = null; return } if (selecting) pick(); else onPlay?.() }}
        onTouchStart={startPress} onTouchEnd={endPress} onTouchMove={movePress}
        onContextMenu={e => { e.preventDefault(); if (!press.current?.fired) pick() }}>
        {selecting && <span className={`pick-dot ${picked ? 'on' : ''}`} aria-hidden="true">{picked && <Check size={16} strokeWidth={3} />}</span>}
        {number !== null && !selecting && <span className="track-num">{number}</span>}
        {showCover && <Cover song={song} />}
        <span className="text">
          <span className="title" style={{ display: 'block' }}><Marked text={song.title} q={highlight} />{song.version ? ` ${song.version}` : ''}</span>
          <span className="sub" style={{ display: 'block' }}><Marked text={song.artist} q={highlight} /></span>
        </span>
        {!selecting && <span className="state"><StateMark song={song} progress={job ? (job.status === 'queued' ? 0 : job.progress) : null} /></span>}
      </button>
      {!selecting && <button type="button" className="more" aria-label={t('Plus')} onClick={openMenu}><MoreVertical size={18} /></button>}
    </div>
  )
}

export function TrackList({ songs, all = null, context = 'list', numbered = false, showCover = true, onPlayAt, menu, playlistId = null }) {
  return (
    <div className="tracks">
      {songs.map((song, i) => (
        <TrackRow key={`${keyOf(song)}-${i}`} song={song} number={numbered ? (song.track_no || i + 1) : null} showCover={showCover} menu={menu} group={all || songs} playlistId={playlistId}
          onPlay={() => (onPlayAt ? onPlayAt(i) : context === 'search' ? playList([song], 0, { context }) : playList(songs, i, { context }))} />
      ))}
    </div>
  )
}

/** The menu of several songs (after a long press): the song menu, for all of them. */
export function selectionMenu() {
  const app = useApp.getState()
  const sel = app.selection
  if (!sel) return
  const songs = Object.values(sel.items)
  const n = songs.length
  const done = () => useApp.getState().clearSelection()
  const local = songs.filter(s => s.local_id)
  const missing = songs.filter(s => !s.local_id && s.deezer_id)
  const sameArtist = songs.every(s => s.artist && s.artist === songs[0].artist)
  const sameAlbum = songs.every(s => s.album && s.album === songs[0].album) && sameArtist
  const items = [
    { label: t('Lire ensuite'), icon: ListPlus, onSelect: () => { playNext(songs); done() } },
    { label: t('Ajouter à la file'), icon: ListEnd, onSelect: () => { addToQueue(songs); done() } },
    { label: t('Ajouter à une playlist'), icon: ListMusic, onSelect: () => { addToPlaylistMenu(songs); done() } },
    { label: t('Nouvelle playlist avec ces titres'), icon: Plus, onSelect: async () => {
      const name = await askPlaylistName('')
      if (name === null) return
      try { const pl = await api.createPlaylist(name || t('Nouvelle playlist'), songs); app.toast(t('Playlist « {name} » créée.', { name: pl.name }), { label: t('Ouvrir'), run: () => useApp.getState().open({ type: 'playlist', id: pl.id }) }); app.libraryChanged() } catch (e) { app.toast(e.message) }
      done()
    } },
  ]
  if (local.length) items.push({ label: t('Ajouter aux titres aimés'), icon: Heart, detail: local.length < n ? t('{n} titres sur ton téléphone', { n: local.length }) : null, onSelect: async () => {
    for (const s of local) { usePlayer.setState(st => ({ liked: { ...st.liked, [s.local_id]: true } })); await api.like(s.local_id, true).catch(() => {}) }
    app.libraryChanged(); app.toast(plural(local.length, '1 titre ajouté aux titres aimés.', '{n} titres ajoutés aux titres aimés.')); done()
  } })
  if (sel.playlistId && songs.some(s => s.item_id)) items.push({ label: t('Retirer de la playlist'), icon: MinusCircle, onSelect: async () => {
    for (const s of songs.filter(x => x.item_id)) await api.removeFromPlaylist(sel.playlistId, s.item_id).catch(() => {})
    app.libraryChanged(); done()
  } })
  if (missing.length) items.push({ label: t('Télécharger'), icon: Download, detail: plural(missing.length, '1 titre n’est pas encore sur ton téléphone', '{n} titres ne sont pas encore sur ton téléphone'), onSelect: () => { downloadSongs(missing); done() } })
  items.push({ label: n === 1 ? t('Je n’aime pas ce titre') : t('Je n’aime pas ces titres'), detail: n === 1 ? t('Il ne te sera plus proposé') : t('Ils ne te seront plus proposés'), icon: ThumbsDown, accent: true, onSelect: async () => {
    for (const s of songs) await api.dislike(s).catch(() => {})
    app.toast(plural(n, '1 titre ne te sera plus proposé.', '{n} titres ne te seront plus proposés.'), { label: t('Annuler'), run: () => songs.forEach(s => api.undislike(s).catch(() => {})) })
    done()
  } })
  if (sameArtist) items.push({ label: t('Créer un mix de cet artiste'), detail: t('Que des titres de {name}', { name: mainArtistOf(songs[0]) }), icon: Disc, onSelect: () => { done(); createArtistMix(songs[0]) } })
  if (sameArtist) items.push({ label: t('Aller à l’artiste'), icon: User, onSelect: () => { done(); goToArtist(songs[0]) } })
  if (sameAlbum && songs[0].local_id) items.push({ label: t('Aller à l’album'), icon: Disc3, onSelect: () => { done(); app.open({ type: 'album', album: songs[0].album, artist: songs[0].album_artist || songs[0].artist }) } })
  if (local.length) items.push({ label: t('Supprimer du téléphone'), icon: Trash2, danger: true, detail: plural(local.length, '1 titre', '{n} titres'), onSelect: async () => {
    const ok = await app.ask({ kind: 'confirm', title: plural(local.length, 'Supprimer 1 titre du téléphone ?', 'Supprimer {n} titres du téléphone ?'), hint: t('Les fichiers sont effacés de ton téléphone.'), confirm: t('Supprimer'), danger: true })
    if (!ok) return
    for (const s of local) await api.remove(s.local_id).catch(() => {})
    app.libraryChanged(); done()
  } })
  app.showSheet({ title: plural(n, '1 titre', '{n} titres'), subtitle: songs.slice(0, 3).map(s => s.title).join(', ') + (n > 3 ? '…' : ''), stack: songs.slice(0, 3), items })
}
