// Your music: songs, albums, artists, liked. Everything here plays offline.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search as SearchIcon, Shuffle, Loader2, User, Disc3, Plus } from 'lucide-react'
import { api, artUrl } from '../api'
import { useApp } from '../store'
import { playList } from '../player'
import { TrackList } from '../components/Track'
import { HeadActions } from '../components/Chrome'
import Back from '../components/Back'
import { t, plural } from '../i18n'
import { ArtistMixCard } from './Home'

const asSongs = rows => rows.map(r => ({ ...r, local_id: r.id }))
let remembered = { view: 'songs', sort: 'added', filter: '' }

/** Long lists render as you scroll. */
function useProgressive(items, step = 120) {
  const [count, setCount] = useState(step)
  const sentinel = useRef(null)
  useEffect(() => setCount(step), [items, step])
  useEffect(() => {
    const el = sentinel.current
    if (!el) return undefined
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setCount(c => c + step) }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [items, step, count])
  return [items.slice(0, count), count < items.length ? <div ref={sentinel} style={{ height: 1 }} /> : null]
}

export default function Library() {
  const [view, setView] = useState(remembered.view === 'follows' ? 'songs' : remembered.view)
  const [sort, setSort] = useState(remembered.sort)
  const [filter, setFilter] = useState(remembered.filter)
  const [loaded, setLoaded] = useState({ key: '', rows: null })
  const version = useApp(s => s.libraryVersion)
  const open = useApp(s => s.open)
  // Rows belong to the view they were fetched for: never draw songs as albums.
  const rows = loaded.key === view ? loaded.rows : null
  remembered = { view, sort, filter }

  useEffect(() => {
    let alive = true
    if (view === 'follows') return undefined
    const timer = setTimeout(async () => {
      const q = filter.trim()
      const r = view === 'songs' ? await api.tracks({ sort, q, limit: 5000 })
        : view === 'liked' ? await api.tracks({ liked: true, q, sort: 'added', limit: 5000 })
          : view === 'albums' ? await api.albums({ q })
            : await api.artists({ q })
      if (alive) setLoaded({ key: view, rows: r })
    }, filter ? 200 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [view, sort, filter, version])

  const songs = useMemo(() => (view === 'songs' || view === 'liked') && rows ? asSongs(rows) : [], [rows, view])
  const [visibleSongs, songsMore] = useProgressive(songs)
  const [visibleRows, rowsMore] = useProgressive(view === 'albums' || view === 'artists' ? (rows || []) : [], 60)

  const views = [['songs', 'Titres'], ['albums', 'Albums'], ['artists', 'Artistes'], ['liked', 'J’aime']]
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Bibliothèque')}</h1><HeadActions /></div>
      <div className="segments" role="group" aria-label={t('Bibliothèque')}>
        {views.map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>{t(label)}</button>)}
      </div>
      {<>
      <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
        <label className="field" style={{ flex: 1, minWidth: 0, height: 44 }}>
          <SearchIcon size={18} />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('Filtrer')} aria-label={t('Filtrer')} />
        </label>
        {(view === 'songs' || view === 'liked') && songs.length > 1 && (
          <button type="button" className="btn primary small" style={{ height: 44, width: 44, padding: 0, borderRadius: 22, flex: 'none' }} aria-label={t('Lecture aléatoire')} onClick={() => playList(songs, 0, { shuffle: true })}><Shuffle size={20} /></button>
        )}
      </div>
      {view === 'songs' && (
        <div className="segments" style={{ marginTop: 12 }} role="group" aria-label="Tri">
          {[['added', 'Récents'], ['title', 'A–Z'], ['artist', 'Artistes'], ['played', 'Plus écoutés']].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={sort === id} onClick={() => setSort(id)} style={{ height: 32, fontSize: 13.5 }}>{t(label)}</button>
          ))}
        </div>
      )}

      {!rows && <div className="empty"><Loader2 className="spin" /></div>}
      {rows && !rows.length && (
        <div className="empty">
          <strong>{t('Aucun titre pour l’instant.')}</strong>
          {!filter && <>{t('Choisis tes dossiers de musique dans les réglages, ou trouve des titres dans Rechercher.')}<div className="btn-row" style={{ justifyContent: 'center' }}><button type="button" className="btn quiet" onClick={() => open({ type: 'settings' })}>{t('Réglages')}</button></div></>}
        </div>
      )}

      {(view === 'songs' || view === 'liked') && rows?.length > 0 && (
        <section style={{ marginTop: 10 }}>
          <p className="note" style={{ margin: '6px 0' }}>{plural(songs.length, '1 titre', '{n} titres')}</p>
          <TrackList songs={visibleSongs} all={songs} onPlayAt={i => playList(songs, i)} />
          {songsMore}
        </section>
      )}
      {view === 'albums' && rows?.length > 0 && (
        <section className="grid2" style={{ marginTop: 18 }}>
          {visibleRows.map(a => (
            <button key={`${a.album}-${a.artist}`} type="button" className="album-tile" onClick={() => open({ type: 'album', album: a.album, artist: a.artist })}>
              {a.art_id ? <img className="art" src={artUrl(a.art_id)} alt="" loading="lazy" /> : <div className="art" style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)' }}><Disc3 size={32} /></div>}
              <div className="name">{a.album}</div>
              <div className="sub">{a.artist}</div>
            </button>
          ))}
          {rowsMore}
        </section>
      )}
      {view === 'artists' && rows?.length > 0 && (
        <section style={{ marginTop: 10 }}>
          {visibleRows.map(a => (
            <button key={a.name} type="button" className="artist-row" onClick={() => open({ type: 'artist', name: a.name })}>
              {a.art_id ? <img src={artUrl(a.art_id)} alt="" loading="lazy" /> : <div className="ph" style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)' }}><User size={22} /></div>}
              <span style={{ minWidth: 0 }}><div className="name">{a.name}</div><div className="sub">{plural(a.count, '1 titre', '{n} titres')}</div></span>
            </button>
          ))}
          {rowsMore}
        </section>
      )}
      </>}
    </div>
  )
}

/** Artists you follow; a dot on those who released something new. */
export function FollowsScreen() {
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Suivis')}</h1></div>
      <Follows />
    </div>
  )
}

function Follows() {
  const follows = useApp(s => s.follows)
  const refresh = useApp(s => s.refreshFollows)
  const open = useApp(s => s.open)
  useEffect(() => { refresh(true) }, [])
  const see = async a => { if (a.new) useApp.setState({ follows: await api.followSeen(a.id) }); open({ type: 'catalogue-artist', id: a.id }) }
  return (
    <div className="follows">
      {follows.artists.length > 0 && <p className="note" style={{ marginTop: 16 }}>{t('Un point jaune : nouveau titre ou album depuis ta dernière visite.')}</p>}
      <div className="who-grid">
        {follows.artists.map(a => (
          <button key={a.id} type="button" className="who" onClick={() => see(a)}>
            <span className="face">{a.picture ? <img src={a.picture} alt="" loading="lazy" /> : <User size={30} />}{a.new && <i className="new-dot" />}</span>
            <span className="name">{a.name}</span>
            {a.new && a.latest && <span className="what">{t(a.latest.type === 'album' ? 'Nouvel album' : a.latest.type === 'ep' ? 'Nouvel EP' : 'Nouveau single')}</span>}
          </button>
        ))}
        <button type="button" className="who" onClick={() => useApp.getState().setTab('search')}>
          <span className="face add"><Plus size={28} /></span><span className="name" style={{ color: 'var(--muted)' }}>{t('Suivre')}</span>
        </button>
      </div>
      {!follows.artists.length && <p className="note">{t('Suis un artiste depuis sa page (bouton Suivre) : ses nouveaux titres et albums apparaîtront ici.')}</p>}
      {follows.news.length > 0 && <>
        <h2 className="mini-h" style={{ fontSize: 20, color: 'var(--text)' }}>{t('Nouveautés')}</h2>
        {follows.news.slice(0, 12).map(n => (
          <button key={n.id} type="button" className="news-row" onClick={async () => { if (n.new) useApp.setState({ follows: await api.followSeen(n.artist_id) }); open({ type: 'catalogue-album', id: n.id }) }}>
            {n.cover ? <img src={n.cover} alt="" loading="lazy" /> : <span className="ph" />}
            <span className="text"><span className="title">{n.title}{n.new && <i className="inline-dot" />}</span><span className="sub">{[n.artist, t(n.type === 'album' ? 'album' : n.type === 'ep' ? 'EP' : 'single'), n.release_date ? new Date(n.release_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : null].filter(Boolean).join(' · ')}</span></span>
          </button>
        ))}
      </>}
    </div>
  )
}

export function LocalAlbum({ album, artist }) {
  const [rows, setRows] = useState(null)
  const version = useApp(s => s.libraryVersion)
  const open = useApp(s => s.open)
  useEffect(() => { api.album(album, artist).then(setRows).catch(() => setRows([])) }, [album, artist, version])
  const songs = rows ? asSongs(rows) : []
  const cover = rows?.find(r => r.has_art)?.id
  return (
    <div className="page">
      <Back />
      <div className="hero">
        <div className="art">{cover ? <img src={artUrl(cover)} alt="" /> : <div style={{ width: '100%', height: '100%', background: 'var(--surface)' }} />}</div>
        <h1>{album}</h1>
        <p><button type="button" style={{ color: 'var(--text)', fontWeight: 600 }} onClick={() => open({ type: 'artist', name: artist })}>{artist}</button>{rows?.[0]?.year ? `, ${rows[0].year}` : ''}</p>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => playList(songs, 0)}>{t('Lire')}</button>
          <button type="button" className="btn quiet" onClick={() => playList(songs, 0, { shuffle: true })}>{t('Lecture aléatoire')}</button>
        </div>
      </div>
      <section className="section"><TrackList songs={songs} numbered showCover={false} /></section>
    </div>
  )
}

export function LocalArtist({ name }) {
  const [rows, setRows] = useState(null)
  const [remote, setRemote] = useState(undefined)
  const version = useApp(s => s.libraryVersion)
  const open = useApp(s => s.open)
  useEffect(() => { api.artist(name).then(setRows).catch(() => setRows([])) }, [name, version])
  useEffect(() => { api.findArtist(name).then(setRemote).catch(() => setRemote(null)) }, [name])
  const songs = rows ? asSongs(rows) : []
  const cover = rows?.find(r => r.has_art)?.id
  return (
    <div className="page">
      <Back />
      <div className="hero round">
        <div className="art">{remote?.picture ? <img src={remote.picture} alt="" /> : cover ? <img src={artUrl(cover)} alt="" /> : <div style={{ width: '100%', height: '100%', background: 'var(--surface)' }} />}</div>
        <h1>{name}</h1>
        <p>{plural(songs.length, '1 titre', '{n} titres')}</p>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => playList(songs, 0)}>{t('Lire')}</button>
          <button type="button" className="btn quiet" onClick={() => playList(songs, 0, { shuffle: true })}>{t('Lecture aléatoire')}</button>
          {remote && <button type="button" className="btn quiet" onClick={() => open({ type: 'catalogue-artist', id: remote.id })}>{t('Dans le catalogue')}</button>}
        </div>
      </div>
      {remote && <ArtistMixCard id={remote.id} name={remote.name || name} picture={remote.picture} />}
      <section className="section"><h2>{t('Sur ton téléphone')}</h2><TrackList songs={songs} /></section>
    </div>
  )
}
