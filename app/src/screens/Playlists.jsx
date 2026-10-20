// Playlists: yours, imported ones and the mixes you keep; a playlist's page
// (sort, custom order by dragging), importing a link, and "Ton mix".
import React, { useEffect, useRef, useState } from 'react'
import { Plus, Download, ArrowDownUp, ChevronDown, GripVertical, Loader2, Link as LinkIcon, Check, X, Search as SearchIcon, Pencil, Trash2, Heart, Shuffle, ListMusic, Image as ImageIcon, Smartphone } from 'lucide-react'
import { api, artUrl } from '../api'
import { useApp } from '../store'
import { playList } from '../player'
import { TrackRow, Cover, songMenu, downloadSongs, askPlaylistName } from '../components/Track'
import { HeadActions } from '../components/Chrome'
import Rings from '../components/Rings'
import Back from '../components/Back'
import { t, plural } from '../i18n'

const fmtLength = secs => { const m = Math.round((secs || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min` }
const coverSrc = c => (String(c).startsWith('local:') ? artUrl(c.slice(6)) : c)
const SOURCE = { spotify: 'Spotify', ytmusic: 'YouTube Music', deezer: 'Deezer' }

export function Mosaic({ pl, size = 60 }) {
  // Always a square of `size`, whatever is (or isn't) in it.
  const box = { width: size, height: size, minWidth: size, maxWidth: size, minHeight: size, maxHeight: size }
  if (pl.kind === 'mix' && !pl.custom_cover) return <div className="mosaic" style={box}><Rings seed={pl.id} center={pl.covers?.[0] ? coverSrc(pl.covers[0]) : null} /></div>
  const covers = pl.covers || []
  if (!covers.length || (covers.length < 4 && !covers[0])) return <div className="mosaic blank" style={box}><ListMusic size={Math.round(size / 3)} /></div>
  if (covers.length < 4 && covers[0]) return <img className="mosaic" src={coverSrc(covers[0])} alt="" style={box} />
  return <div className="mosaic grid" style={box}>{covers.slice(0, 4).map((c, i) => (c ? <img key={`${c}-${i}`} src={coverSrc(c)} alt="" loading="lazy" /> : <span key={i} className="cell blank" />))}</div>
}

const sortLabel = { custom: 'Ordre perso', title: 'Titre', artist: 'Artiste', added: 'Date d’ajout', played: 'Les plus écoutés', duration: 'Durée' }

export default function Playlists() {
  const [lists, setLists] = useState(null)
  const [order, setOrder] = useState(() => { try { return localStorage.getItem('echo-pl-order') || 'custom' } catch { return 'custom' } })
  const open = useApp(s => s.open)
  const version = useApp(s => s.libraryVersion)
  useEffect(() => { api.playlists().then(setLists).catch(() => setLists([])) }, [version])
  const sorted = lists ? [...lists].sort(order === 'name' ? (a, b) => a.name.localeCompare(b.name, 'fr') : order === 'recent' ? (a, b) => b.updated_at - a.updated_at : () => 0) : null
  const create = async () => {
    const name = await askPlaylistName('')
    if (name === null) return
    const pl = await api.createPlaylist(name || t('Nouvelle playlist'))
    useApp.getState().libraryChanged()
    open({ type: 'playlist', id: pl.id })
  }
  const pickOrder = () => useApp.getState().showSheet({
    title: t('Trier les playlists'),
    items: [['custom', 'Ordre perso'], ['name', 'Nom'], ['recent', 'Modifiées récemment']].map(([id, label]) => ({ label: t(label), checked: order === id, onSelect: () => { setOrder(id); try { localStorage.setItem('echo-pl-order', id) } catch {} } })),
  })
  // Long press on a playlist: put them in your order by dragging.
  const [arranging, setArranging] = useState(null) // the playlists, in the order being made
  const [drag, setDrag] = useState(null)
  const press = useRef(null)
  const startArrange = () => { setOrder('custom'); try { localStorage.setItem('echo-pl-order', 'custom') } catch {} ; setArranging(lists ? [...lists] : []); navigator.vibrate?.(12) }
  const finish = async () => {
    const ids = arranging.map(p => p.id)
    setArranging(null)
    try { setLists(await api.arrangePlaylists(ids)) } catch (e) { useApp.getState().toast(e.message) }
  }
  const ROW = 76
  const startDrag = (e, from) => {
    e.preventDefault()
    const y0 = e.clientY, el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    let to = from
    const move = ev => { const dy = ev.clientY - y0; to = Math.max(0, Math.min(arranging.length - 1, from + Math.round(dy / ROW))); setDrag({ from, to, dy }) }
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      setDrag(null)
      if (to === from) return
      const next = [...arranging]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); setArranging(next)
    }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
    setDrag({ from, to: from, dy: 0 })
  }
  const shift = i => {
    if (!drag) return 0
    if (i === drag.from) return drag.dy
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -ROW
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return ROW
    return 0
  }
  const pressStart = e => { const p = e.touches?.[0]; press.current = { x: p?.clientX, y: p?.clientY, timer: setTimeout(() => { press.current = { fired: true }; startArrange() }, 480) } }
  const pressMove = e => { const p = e.touches?.[0], st = press.current; if (st?.timer && p && Math.hypot(p.clientX - st.x, p.clientY - st.y) > 10) { clearTimeout(st.timer); press.current = null } }
  const pressEnd = () => { if (press.current?.timer) clearTimeout(press.current.timer) }
  const sub = pl => [pl.kind === 'mix' ? t('Mix gardé') : pl.source ? t('Importée de {s}', { s: SOURCE[pl.source] || pl.source }) : null, plural(pl.count, '1 titre', '{n} titres'), pl.duration ? fmtLength(pl.duration) : null].filter(Boolean).join(' · ')
  if (arranging) return (
    <div className="page">
      <div className="page-head"><h1>{t('Playlists')}</h1><button type="button" className="link-btn" style={{ marginTop: 0, fontSize: 15 }} onClick={finish}>{t('OK')}</button></div>
      <p className="note" style={{ marginTop: 0 }}>{t('Glisse une playlist par sa poignée pour la déplacer, puis touche OK.')}</p>
      <div className="pl-row static">
        <span className="mosaic liked" style={{ width: 60, height: 60 }}><Heart size={26} fill="currentColor" /></span>
        <span className="text"><span className="title">{t('Titres aimés')}</span><span className="sub">{t('Toujours en premier')}</span></span>
      </div>
      {arranging.map((pl, i) => (
        <div key={pl.id} className={`pl-row arranging ${drag?.from === i ? 'lifted' : ''}`} style={{ transform: `translateY(${shift(i)}px)`, transition: drag && drag.from !== i ? 'transform .15s' : 'none' }}>
          <Mosaic pl={pl} />
          <span className="text"><span className="title">{pl.name}</span><span className="sub">{sub(pl)}</span></span>
          <button type="button" className="grip" onPointerDown={e => startDrag(e, i)} aria-label={t('Déplacer « {name} »', { name: pl.name })}><GripVertical size={22} /></button>
        </div>
      ))}
    </div>
  )
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Playlists')}</h1><HeadActions /></div>
      <div className="two-btns">
        <button type="button" className="btn primary" onClick={create}><Plus size={20} />{t('Nouvelle')}</button>
        <button type="button" className="btn quiet" onClick={() => open({ type: 'import' })}><Download size={20} />{t('Importer')}</button>
      </div>
      <button type="button" className="sort-btn" onClick={pickOrder}><ArrowDownUp size={17} />{t('Trier')} : <b>{t(order === 'name' ? 'Nom' : order === 'recent' ? 'Modifiées récemment' : 'Ordre perso')}</b><ChevronDown size={16} /></button>
      {!sorted && <div className="empty"><Loader2 className="spin" /></div>}
      <button type="button" className="pl-row" onClick={() => open({ type: 'liked' })}>
        <span className="mosaic liked" style={{ width: 60, height: 60 }}><Heart size={26} fill="currentColor" /></span>
        <span className="text"><span className="title">{t('Titres aimés')}</span><span className="sub">{t('Tes coups de cœur')}</span></span>
      </button>
      {sorted?.map(pl => (
        <button type="button" key={pl.id} className="pl-row" onClick={() => { if (press.current?.fired) { press.current = null; return } open({ type: 'playlist', id: pl.id }) }}
          onTouchStart={pressStart} onTouchMove={pressMove} onTouchEnd={pressEnd} onContextMenu={e => { e.preventDefault(); startArrange() }}>
          <Mosaic pl={pl} />
          <span className="text">
            <span className="title">{pl.name}</span>
            <span className="sub">{sub(pl)}</span>
          </span>
        </button>
      ))}
      {sorted && !sorted.length && <p className="note" style={{ marginTop: 18 }}>{t('Crée une playlist, ou importe celles de Spotify, YouTube Music ou Deezer avec leur lien.')}</p>}
      {sorted && sorted.length > 1 && <p className="note" style={{ marginTop: 14, fontSize: 13 }}>{t('Appui long sur une playlist pour changer leur ordre.')}</p>}
    </div>
  )
}

// --------------------------------------------------------------- a playlist
export function PlaylistScreen({ id }) {
  const [pl, setPl] = useState(null)
  const [error, setError] = useState('')
  const [drag, setDrag] = useState(null) // { from, to, dy }
  const version = useApp(s => s.libraryVersion)
  const back = useApp(s => s.back)
  const listRef = useRef(null)
  const load = () => api.playlist(id).then(setPl).catch(e => setError(e.message))
  useEffect(() => { load() }, [id, version])
  if (error) return <div className="page"><Back /><div className="empty"><strong>{error}</strong></div></div>
  if (!pl) return <div className="page"><Back /><div className="empty"><Loader2 className="spin" /></div></div>
  const songs = pl.tracks
  const custom = pl.sort === 'custom'

  const setSort = async (sort, dir = pl.sort_dir) => setPl(await api.updatePlaylist(pl.id, { sort, sort_dir: dir }))
  const sortSheet = () => useApp.getState().showSheet({
    title: t('Trier par'),
    items: Object.entries(sortLabel).map(([key, label]) => ({ label: t(label), checked: pl.sort === key, hint: key === 'custom' ? t('glisse les titres') : null, onSelect: () => setSort(key) })),
    footer: (
      <div className="dir-row" role="group" aria-label={t('Sens')}>
        <button type="button" aria-pressed={pl.sort_dir !== 'desc'} onClick={() => { setSort(pl.sort, 'asc'); useApp.getState().closeSheet() }}>{t('Croissant')}</button>
        <button type="button" aria-pressed={pl.sort_dir === 'desc'} onClick={() => { setSort(pl.sort, 'desc'); useApp.getState().closeSheet() }}>{t('Décroissant')}</button>
      </div>
    ),
  })
  const more = () => useApp.getState().showSheet({
    title: pl.name,
    items: [
      { label: t('Renommer'), icon: Pencil, onSelect: async () => { const name = await askPlaylistName(pl.name, { title: t('Renommer la playlist'), confirm: t('Renommer') }); if (name) setPl(await api.updatePlaylist(pl.id, { name })) } },
      { label: t('Tout télécharger'), icon: Download, onSelect: () => downloadSongs(songs) },
      { label: t('Changer l’image'), icon: ImageIcon, onSelect: () => (songs.length >= 4 ? useApp.getState().open({ type: 'cover', id: pl.id }) : useApp.getState().toast(t('Il faut au moins 4 titres pour composer l’image.'))) },
      { label: t('Supprimer la playlist'), icon: Trash2, danger: true, onSelect: async () => { if (await useApp.getState().ask({ kind: 'confirm', title: t('Supprimer « {name} » ?', { name: pl.name }), hint: t('Les titres restent sur ton téléphone.'), confirm: t('Supprimer'), danger: true })) { await api.deletePlaylist(pl.id); useApp.getState().libraryChanged(); back() } } },
    ],
  })

  // Custom order: drag a song by its handle.
  const ROW = 62
  const startDrag = (e, from) => {
    if (!custom) return
    e.preventDefault()
    const y0 = e.clientY
    const el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    let to = from
    const move = ev => {
      const dy = ev.clientY - y0
      to = Math.max(0, Math.min(songs.length - 1, from + Math.round(dy / ROW)))
      setDrag({ from, to, dy })
    }
    const up = async () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
      if (to === from) return
      const ids = songs.map(s => s.item_id)
      const [moved] = ids.splice(from, 1)
      ids.splice(to, 0, moved)
      const reordered = ids.map(x => songs.find(s => s.item_id === x))
      setPl({ ...pl, tracks: reordered })
      setPl(await api.reorderPlaylist(pl.id, ids))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    setDrag({ from, to: from, dy: 0 })
  }
  const shift = i => {
    if (!drag) return 0
    if (i === drag.from) return drag.dy
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -ROW
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return ROW
    return 0
  }
  const missing = pl.meta?.missing || []
  return (
    <div className="page">
      <Back><button type="button" className="icon-btn" onClick={more} aria-label={t('Plus')}><span style={{ fontSize: 22, lineHeight: 0, color: 'var(--text)' }}>⋯</span></button></Back>
      <div className="pl-hero">
        <button type="button" className="pl-cover" onClick={() => songs.length >= 4 ? useApp.getState().open({ type: 'cover', id: pl.id }) : useApp.getState().toast(t('Il faut au moins 4 titres pour composer l’image.'))} aria-label={t('Changer l’image de la playlist')}>
          <Mosaic pl={pl} size={120} />
          <span className="pl-cover-btn"><ImageIcon size={17} /></span>
        </button>
        <div style={{ minWidth: 0 }}>
          <h1>{pl.name}</h1>
          <p>{[plural(pl.count, '1 titre', '{n} titres'), pl.duration ? fmtLength(pl.duration) : null, pl.source ? t('Importée de {s}', { s: SOURCE[pl.source] || pl.source }) : null].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div className="btn-row">
        <button type="button" className="btn primary" disabled={!songs.length} onClick={() => playList(songs, 0, { context: 'playlist' })}>{t('Lire')}</button>
        <button type="button" className="btn quiet" disabled={!songs.length} onClick={() => playList(songs, 0, { shuffle: true, context: 'playlist' })}><Shuffle size={18} />{t('Aléatoire')}</button>
        <button type="button" className="btn quiet" onClick={() => useApp.getState().open({ type: 'add-songs', id: pl.id })} aria-label={t('Ajouter des titres')}><Plus size={20} /></button>
      </div>
      <button type="button" className="sort-btn" onClick={sortSheet}><ArrowDownUp size={17} />{t('Trier')} : <b>{t(sortLabel[pl.sort] || 'Ordre perso')}</b>{pl.sort !== 'custom' && <span className="dir">{pl.sort_dir === 'desc' ? '↓' : '↑'}</span>}<ChevronDown size={16} /></button>
      {missing.length > 0 && <p className="note">{t('{n} titres de la playlist d’origine n’ont pas été trouvés.', { n: missing.length })}</p>}
      <div className="tracks pl-tracks" ref={listRef}>
        {songs.map((song, i) => (
          <div key={song.item_id} className={`pl-item ${drag?.from === i ? 'dragging' : ''}`} style={{ transform: `translateY(${shift(i)}px)`, transition: drag && drag.from !== i ? 'transform .15s' : 'none' }}>
            {custom && <button type="button" className="grip" onPointerDown={e => startDrag(e, i)} aria-label={t('Déplacer « {title} »', { title: song.title })}><GripVertical size={20} /></button>}
            <TrackRow song={song} group={songs} playlistId={pl.id} onPlay={() => playList(songs, i, { context: 'playlist' })} menu={s => songMenu(s, { playlistId: pl.id, onChanged: load })} />
          </div>
        ))}
      </div>
      {!songs.length && <div className="empty"><strong>{t('Playlist vide.')}</strong>{t('Ajoute des titres avec le bouton +, ou depuis le menu ⋮ d’un titre.')}</div>}
    </div>
  )
}

// ------------------------------------------------------- liked songs list
export function LikedScreen() {
  const [rows, setRows] = useState(null)
  const version = useApp(s => s.libraryVersion)
  useEffect(() => { api.tracks({ liked: true, sort: 'added', limit: 5000 }).then(r => setRows(r.map(x => ({ ...x, local_id: x.id })))).catch(() => setRows([])) }, [version])
  return (
    <div className="page">
      <Back />
      <div className="pl-hero">
        <span className="mosaic liked" style={{ width: 120, height: 120 }}><Heart size={48} fill="currentColor" /></span>
        <div><h1>{t('Titres aimés')}</h1><p>{rows ? plural(rows.length, '1 titre', '{n} titres') : ''}</p></div>
      </div>
      <div className="btn-row">
        <button type="button" className="btn primary" disabled={!rows?.length} onClick={() => playList(rows, 0, { context: 'playlist' })}>{t('Lire')}</button>
        <button type="button" className="btn quiet" disabled={!rows?.length} onClick={() => playList(rows, 0, { shuffle: true, context: 'playlist' })}><Shuffle size={18} />{t('Aléatoire')}</button>
      </div>
      <div className="tracks" style={{ marginTop: 14 }}>
        {(rows || []).map((song, i) => <TrackRow key={song.local_id} song={song} onPlay={() => playList(rows, i, { context: 'playlist' })} />)}
      </div>
    </div>
  )
}

// ------------------------------------------------------- adding songs
export function AddSongs({ id }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('local') // local: on the phone · catalogue: to download
  const [res, setRes] = useState(null)
  const [mine, setMine] = useState(null)
  const [pl, setPl] = useState(null)
  const [added, setAdded] = useState({})
  const [total, setTotal] = useState(0)
  useEffect(() => { api.playlist(id).then(setPl).catch(() => {}) }, [id])
  // On the phone: the songs you play most first, or the ones matching.
  useEffect(() => {
    const text = q.trim()
    const timer = setTimeout(async () => {
      try { setMine((await api.tracks({ sort: text ? 'title' : 'played', q: text, limit: 300 })).map(r => ({ ...r, local_id: r.id }))) } catch { setMine([]) }
    }, text ? 200 : 0)
    return () => clearTimeout(timer)
  }, [q])
  useEffect(() => { api.stats().then(st => setTotal(st.tracks || st.total || 0)).catch(() => {}) }, [])
  // To download: the catalogue.
  useEffect(() => {
    const text = q.trim()
    if (tab !== 'catalogue' || text.length < 2) { setRes(null); return undefined }
    const timer = setTimeout(async () => { try { setRes(await api.search(text)) } catch { setRes({ catalogue: { tracks: [] } }) } }, 300)
    return () => clearTimeout(timer)
  }, [q, tab])
  const inList = new Set((pl?.tracks || []).map(s => s.local_id || s.deezer_id))
  const songs = tab === 'local' ? (mine || []) : (res?.catalogue?.tracks || []).filter(s => !s.local_id)
  const picked = Object.keys(added).filter(k => added[k])
  const toggle = song => { const key = song.local_id || song.deezer_id; setAdded({ ...added, [key]: added[key] ? null : song }) }
  const save = async () => {
    const list = Object.values(added).filter(Boolean)
    if (!list.length) return
    await api.addToPlaylist(id, list).catch(e => useApp.getState().toast(e.message))
    useApp.getState().libraryChanged()
    useApp.getState().toast(list.length === 1 ? t('1 titre ajouté à « {name} ».', { name: pl?.name || '' }) : t('{n} titres ajoutés à « {name} ».', { n: list.length, name: pl?.name || '' }))
    useApp.getState().back()
  }
  return (
    <div className="page with-footer">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{pl ? t('Ajouter à « {name} »', { name: pl.name }) : t('Ajouter des titres')}</h1></div>
      <label className="field"><SearchIcon size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Rechercher un titre')} aria-label={t('Rechercher')} /></label>
      <div className="tabs2" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'local'} onClick={() => setTab('local')}><Smartphone size={17} />{t('Disponibles')}{total > 0 && <span className="count">{total}</span>}</button>
        <button type="button" role="tab" aria-selected={tab === 'catalogue'} onClick={() => setTab('catalogue')}><Download size={17} />{t('À télécharger')}</button>
      </div>
      <p className="note" style={{ margin: '12px 0 2px', fontSize: 13.5 }}>{tab === 'local' ? t('Se lisent tout de suite, même hors ligne. Les plus écoutés d’abord.') : t('Cherche un titre : il se téléchargera quand tu l’écouteras.')}</p>
      <div className="tracks" style={{ marginTop: 4 }}>
        {tab === 'local' && !mine && <div className="empty"><Loader2 className="spin" /></div>}
        {tab === 'catalogue' && q.trim().length < 2 && <div className="empty">{t('Tape au moins 2 lettres.')}</div>}
        {songs.map(song => {
          const key = song.local_id || song.deezer_id
          const already = inList.has(key)
          return (
            <div className="row" key={key}>
              <div className="track" style={{ pointerEvents: 'none' }}><Cover song={song} /><span className="text"><span className="title" style={{ display: 'block' }}>{song.title}</span><span className="sub" style={{ display: 'block' }}>{already ? t('Déjà dans la playlist') : song.artist}</span></span></div>
              <button type="button" className={`add-dot ${added[key] ? 'on' : ''}`} onClick={() => toggle(song)} disabled={already} aria-pressed={!!added[key]} aria-label={t('Ajouter')}>{added[key] ? <Check size={18} strokeWidth={2.6} /> : <Plus size={18} strokeWidth={2.4} />}</button>
            </div>
          )
        })}
      </div>
      <div className="page-footer"><button type="button" className="btn primary wide" disabled={!picked.length} onClick={save}>{picked.length ? plural(picked.length, 'Ajouter 1 titre', 'Ajouter {n} titres') : t('Choisis des titres')}</button></div>
    </div>
  )
}

// ------------------------------------------------------ playlist picture
/** The playlist's picture: 4 of its songs, in the order you touch them. */
export function CoverPicker({ id }) {
  const [pl, setPl] = useState(null)
  const [order, setOrder] = useState([])
  useEffect(() => { api.playlist(id).then(p => { setPl(p); setOrder((p.meta?.cover_items || []).slice(0, 4)) }).catch(() => {}) }, [id])
  if (!pl) return <div className="page"><Back /><div className="empty"><Loader2 className="spin" /></div></div>
  const songs = (pl.tracks || []).filter(s => s.cover || s.local_id)
  const touch = item => setOrder(order.includes(item) ? order.filter(x => x !== item) : order.length >= 4 ? [...order.slice(1), item] : [...order, item])
  const preview = order.map(x => songs.find(s => s.item_id === x)).filter(Boolean)
  const save = async items => { await api.updatePlaylist(id, { cover_items: items }); useApp.getState().libraryChanged(); useApp.getState().back() }
  return (
    <div className="page with-footer">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Image de la playlist')}</h1></div>
      <div className="cover-head">
        <div className="mosaic grid" style={{ width: 104, height: 104, minWidth: 104 }}>
          {[0, 1, 2, 3].map(i => preview[i] ? <Cover key={i} song={preview[i]} className="cell" /> : <span key={i} className="cell blank" />)}
        </div>
        <p className="note" style={{ margin: 0 }}>{t('Choisis 4 titres de la playlist. Ils forment l’image, dans l’ordre où tu les touches.')}</p>
      </div>
      <div className="cover-grid">
        {songs.map(song => {
          const n = order.indexOf(song.item_id) + 1
          return (
            <button key={song.item_id} type="button" className={`cover-pick ${n ? 'on' : ''}`} aria-pressed={!!n} onClick={() => touch(song.item_id)}>
              <Cover song={song} className="art" />{n > 0 && <span className="n">{n}</span>}
              <span className="name">{song.title}</span>
            </button>
          )
        })}
      </div>
      <div className="page-footer two-btns">
        <button type="button" className="btn quiet" onClick={() => save([])}>{t('Par défaut')}</button>
        <button type="button" className="btn primary" disabled={order.length !== 4} onClick={() => save(order)}>{order.length === 4 ? t('Enregistrer') : t('{n} sur 4', { n: order.length })}</button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- import
export function ImportScreen() {
  const [service, setService] = useState('spotify')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(true)
  const app = useApp()
  const go = async () => {
    setBusy(true); setError('')
    try {
      const pl = await api.importPlaylist(url.trim())
      const missing = pl.tracks.filter(s => !s.local_id)
      if (now && missing.length) await downloadSongs(missing)
      app.libraryChanged()
      app.back()
      app.open({ type: 'playlist', id: pl.id })
      app.toast(t('« {name} » importée : {n} titres.', { name: pl.name, n: pl.count }))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const hint = { spotify: 'open.spotify.com/playlist/…', ytmusic: 'music.youtube.com/playlist?list=…', deezer: 'deezer.com/playlist/…' }[service]
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Importer une playlist')}</h1></div>
      <p className="note" style={{ marginTop: -4 }}>{t('Depuis quel service ?')}</p>
      <div className="svc-row" role="radiogroup" aria-label={t('Service')}>
        {[['spotify', 'Spotify'], ['ytmusic', 'YouTube Music'], ['deezer', 'Deezer']].map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={service === id} onClick={() => setService(id)}>{label}</button>
        ))}
      </div>
      <label className="lbl" htmlFor="pl-link">{t('Lien de la playlist')}</label>
      <div className="field"><LinkIcon size={20} /><input id="pl-link" value={url} onChange={e => setUrl(e.target.value)} placeholder={hint} inputMode="url" autoComplete="off" /></div>
      <p className="note" style={{ marginTop: 8 }}>{t('Dans l’appli du service : ⋯ › Partager › Copier le lien.')}</p>
      <div className="card-surface toggle-row">
        <span className="text"><span className="title">{t('Télécharger les titres manquants maintenant')}</span><span className="sub">{t('Sinon, chacun se télécharge quand tu le lances.')}</span></span>
        <button type="button" role="switch" aria-checked={now} className={`switch ${now ? 'on' : ''}`} onClick={() => setNow(!now)} aria-label={t('Télécharger maintenant')}><i /></button>
      </div>
      {error && <p className="note err">{error}</p>}
      <div className="btn-row">
        <button type="button" className="btn primary wide" disabled={busy || url.trim().length < 8} onClick={go}>{busy ? <><Loader2 size={18} className="spin" />{t('Import en cours…')}</> : t('Importer la playlist')}</button>
      </div>
      {busy && service !== 'deezer' && <p className="note">{t('Chaque titre est cherché dans le catalogue : ça peut prendre une minute pour une longue playlist.')}</p>}
    </div>
  )
}

// ------------------------------------------------------------- "Ton mix"
export function MixCreate() {
  const [artists, setArtists] = useState(null)
  const [picked, setPicked] = useState([])
  const [q, setQ] = useState('')
  const [found, setFound] = useState([])
  const [era, setEra] = useState('both')
  const [busy, setBusy] = useState(false)
  const app = useApp()
  useEffect(() => { api.mixArtists().then(setArtists).catch(() => setArtists([])) }, [])
  useEffect(() => {
    const text = q.trim()
    if (text.length < 2) { setFound([]); return undefined }
    const timer = setTimeout(async () => { try { setFound((await api.search(text)).catalogue.artists.slice(0, 6)) } catch { setFound([]) } }, 300)
    return () => clearTimeout(timer)
  }, [q])
  const isPicked = a => picked.some(p => (p.id && p.id === a.id) || p.name === a.name)
  const toggle = a => setPicked(isPicked(a) ? picked.filter(p => !((p.id && p.id === a.id) || p.name === a.name)) : picked.length >= 3 ? picked : [...picked, a])
  const create = async () => {
    setBusy(true)
    try {
      const pl = await api.customMix(picked.map(p => ({ id: p.id, name: p.name })), era)
      app.libraryChanged()
      app.back()
      app.open({ type: 'playlist', id: pl.id })
    } catch (e) { app.toast(e.message) } finally { setBusy(false) }
  }
  const row = a => (
    <button type="button" key={a.id || a.name} className="pick-row" onClick={() => toggle(a)} aria-pressed={isPicked(a)} disabled={!isPicked(a) && picked.length >= 3}>
      {a.picture ? <img src={a.picture} alt="" /> : <span className="ph" />}
      <span className="text"><span className="title">{a.name}</span>{a.score ? <span className="sub">{t('Dans tes écoutes')}</span> : a.fans ? <span className="sub">{t('{n} fans', { n: a.fans.toLocaleString('fr-FR') })}</span> : null}</span>
      <span className={`check ${isPicked(a) ? 'on' : ''}`}>{isPicked(a) && <Check size={16} strokeWidth={3} />}</span>
    </button>
  )
  return (
    <div className="page with-footer">
      <Back />
      <div className="page-head" style={{ paddingTop: 0, minHeight: 0 }}><h1>{t('Créer ton mix')}</h1></div>
      <p className="note" style={{ marginTop: 0 }}>{t('Choisis 2 ou 3 artistes. Écho mélange leurs titres avec des artistes proches.')}</p>
      <div className="chips">
        {picked.map(p => <button key={p.id || p.name} type="button" className="chip on" onClick={() => toggle(p)}>{p.name}<X size={15} /></button>)}
        {picked.length < 3 && <span className="chip ghost">{picked.length ? t('{n} de plus possible', { n: 3 - picked.length }) : t('Jusqu’à 3 artistes')}</span>}
      </div>
      <label className="field" style={{ marginTop: 14 }}><SearchIcon size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Chercher un artiste')} aria-label={t('Chercher un artiste')} /></label>
      {found.length > 0 && <div style={{ marginTop: 8 }}>{found.map(row)}</div>}
      {!q && <>
        <h2 className="mini-h">{t('Tes artistes les plus écoutés')}</h2>
        {!artists && <div className="empty"><Loader2 className="spin" /></div>}
        {artists?.map(row)}
        {artists && !artists.length && <p className="note">{t('Écoute quelques titres, ou cherche un artiste.')}</p>}
      </>}
      <h2 className="mini-h">{t('Époque des titres')}</h2>
      <div className="segments" role="group" aria-label={t('Époque')}>
        {[['both', 'Les deux'], ['recent', 'Récentes'], ['old', 'Anciennes']].map(([id, label]) => <button key={id} type="button" aria-pressed={era === id} onClick={() => setEra(id)}>{t(label)}</button>)}
      </div>
      <div className="page-footer">
        <button type="button" className="btn primary wide" disabled={picked.length < 1 || busy} onClick={create}>{busy ? <><Loader2 size={18} className="spin" />{t('Création…')}</> : t('Créer le mix · 30 titres')}</button>
      </div>
    </div>
  )
}
