// Search: your library first, then Deezer's catalogue (songs, artists,
// albums). A song you don't have downloads when you play it.
import React, { useEffect, useRef, useState } from 'react'
import { Search as SearchIcon, X, Loader2, User } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { playList } from '../player'
import { TrackList, downloadSongs } from '../components/Track'
import { HeadActions } from '../components/Chrome'
import Back from '../components/Back'
import { t } from '../i18n'

let lastQuery = ''

export default function Search() {
  const [query, setQuery] = useState(lastQuery)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const open = useApp(s => s.open)
  const input = useRef(null)
  const seq = useRef(0)

  useEffect(() => { if (!query) input.current?.focus() }, [])
  useEffect(() => {
    lastQuery = query
    const q = query.trim()
    if (q.length < 2) { setResult(null); return }
    const n = ++seq.current
    setBusy(true)
    const timer = setTimeout(async () => {
      try { const r = await api.search(q); if (n === seq.current) setResult(r) } catch { if (n === seq.current) setResult({ error: true }) } finally { if (n === seq.current) setBusy(false) }
    }, 320)
    return () => clearTimeout(timer)
  }, [query])

  const local = (result?.library || []).map(r => ({ ...r, local_id: r.id }))
  const cat = result?.catalogue || { tracks: [], artists: [], albums: [] }
  const nothing = result && !local.length && !cat.tracks.length && !cat.artists.length && !cat.albums.length

  return (
    <div className="page">
      <div className="page-head"><h1>{t('Rechercher')}</h1><HeadActions /></div>
      <div className="sticky-top">
        <label className="field">
          {busy ? <Loader2 size={20} className="spin" /> : <SearchIcon size={20} />}
          <input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Titres, artistes, albums')} enterKeyHint="search" aria-label={t('Rechercher')} autoComplete="off" spellCheck={false} />
          {query && <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => { setQuery(''); input.current?.focus() }} aria-label={t('Fermer')}><X size={18} /></button>}
        </label>
      </div>

      {!result && <p className="note" style={{ marginTop: 18 }}>{t('Cherche un titre, un artiste ou un album. Ce que tu n’as pas se télécharge quand tu le lances.')}</p>}
      {result?.offline && <p className="note" style={{ marginTop: 14 }}>{t('Hors ligne : seulement ta bibliothèque.')}</p>}
      {nothing && <div className="empty"><strong>{t('Rien trouvé pour « {q} ».', { q: query.trim() })}</strong></div>}

      {local.length > 0 && (
        <section className="section">
          <h2>{t('Dans ta bibliothèque')}</h2>
          <TrackList songs={local.slice(0, 5)} />
        </section>
      )}
      {cat.tracks.length > 0 && (
        <section className="section">
          <h2>{t('Titres')}</h2>
          <TrackList songs={cat.tracks} />
        </section>
      )}
      {cat.artists.length > 0 && (
        <section className="section">
          <h2>{t('Artistes')}</h2>
          <div className="rail">
            {cat.artists.map(a => (
              <button key={a.id} type="button" className="artist-bubble" onClick={() => open({ type: 'catalogue-artist', id: a.id })}>
                {a.picture ? <img src={a.picture} alt="" loading="lazy" /> : <div className="ph" />}
                <div className="name">{a.name}</div>
              </button>
            ))}
          </div>
        </section>
      )}
      {cat.albums.length > 0 && (
        <section className="section">
          <h2>{t('Albums')}</h2>
          <div className="grid2">
            {cat.albums.map(a => (
              <button key={a.id} type="button" className="album-tile" onClick={() => open({ type: 'catalogue-album', id: a.id })}>
                {a.cover ? <img className="art" src={a.cover} alt="" loading="lazy" /> : <div className="art" />}
                <div className="name">{a.title}</div>
                <div className="sub">{a.artist}{a.year ? `, ${a.year}` : ''}</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export function CatalogueAlbum({ id }) {
  const [album, setAlbum] = useState(null)
  const [error, setError] = useState('')
  const open = useApp(s => s.open)
  const version = useApp(s => s.libraryVersion)
  useEffect(() => { api.catalogueAlbum(id).then(setAlbum).catch(e => setError(e.message)) }, [id, version])
  if (error) return <div className="page"><Back /><div className="empty"><strong>{t('Recherche dans le catalogue impossible.')}</strong>{error}</div></div>
  if (!album) return <div className="page"><Back /><div className="empty"><Loader2 className="spin" /></div></div>
  return (
    <div className="page">
      <Back />
      <div className="hero">
        <div className="art">{album.cover ? <img src={album.cover} alt="" /> : null}</div>
        <h1>{album.title}</h1>
        <p>
          <button type="button" onClick={() => album.tracks[0]?.artist_id && open({ type: 'catalogue-artist', id: album.tracks[0].artist_id })} style={{ color: 'var(--text)', fontWeight: 600 }}>{album.artist}</button>
          {album.year ? `, ${album.year}` : ''}
        </p>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => playList(album.tracks, 0)}>{t('Lire')}</button>
          <button type="button" className="btn quiet" onClick={() => downloadSongs(album.tracks)}>{t('Tout télécharger')}</button>
        </div>
      </div>
      <section className="section"><TrackList songs={album.tracks} numbered showCover={false} /></section>
    </div>
  )
}

export function CatalogueArtist({ id }) {
  const [artist, setArtist] = useState(null)
  const [error, setError] = useState('')
  const open = useApp(s => s.open)
  const version = useApp(s => s.libraryVersion)
  useEffect(() => { api.catalogueArtist(id).then(setArtist).catch(e => setError(e.message)) }, [id, version])
  if (error) return <div className="page"><Back /><div className="empty"><strong>{t('Recherche dans le catalogue impossible.')}</strong>{error}</div></div>
  if (!artist) return <div className="page"><Back /><div className="empty"><Loader2 className="spin" /></div></div>
  return (
    <div className="page">
      <Back />
      <div className="hero round">
        <div className="art">{artist.picture ? <img src={artist.picture} alt="" /> : <div style={{ width: '100%', height: '100%', background: 'var(--surface)', display: 'grid', placeItems: 'center' }}><User size={48} /></div>}</div>
        <h1>{artist.name}</h1>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => playList(artist.top, 0)}>{t('Lire')}</button>
          <button type="button" className="btn quiet" onClick={() => playList(artist.top, 0, { shuffle: true })}>{t('Lecture aléatoire')}</button>
        </div>
      </div>
      {artist.top.length > 0 && <section className="section"><h2>{t('Titres populaires')}</h2><TrackList songs={artist.top.slice(0, 10)} /></section>}
      {artist.albums.length > 0 && (
        <section className="section">
          <h2>{t('Albums et singles')}</h2>
          <div className="rail">
            {artist.albums.map(a => (
              <button key={a.id} type="button" className="album-tile" onClick={() => open({ type: 'catalogue-album', id: a.id })}>
                {a.cover ? <img className="art" src={a.cover} alt="" loading="lazy" /> : <div className="art" />}
                <div className="name">{a.title}</div>
                <div className="sub">{a.year || ''}</div>
              </button>
            ))}
          </div>
        </section>
      )}
      {artist.related.length > 0 && (
        <section className="section">
          <h2>{t('Artistes proches')}</h2>
          <div className="rail">
            {artist.related.map(a => (
              <button key={a.id} type="button" className="artist-bubble" onClick={() => open({ type: 'catalogue-artist', id: a.id })}>
                {a.picture ? <img src={a.picture} alt="" loading="lazy" /> : <div className="ph" />}
                <div className="name">{a.name}</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
