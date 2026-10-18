// "Pour toi": a greeting, today's mixes (made from what you listen to), what
// you were listening to, what arrived lately.
import React, { useEffect, useState } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { playList, coverOf } from '../player'
import Rings from '../components/Rings'
import { TrackList, Cover, downloadSongs } from '../components/Track'
import Back from '../components/Back'
import { HeadActions } from '../components/Chrome'
import { t } from '../i18n'

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return t('Bonne nuit')
  if (h < 12) return t('Bonjour')
  if (h < 18) return t('Bon après-midi')
  return t('Bonsoir')
}

export const mixTitle = mix => mix.kind === 'daily' ? t('Mix du jour {n}', { n: mix.index }) : mix.kind === 'discover' ? t('Découvertes') : t('Populaire en ce moment')
export const mixLine = mix => mix.kind === 'daily' ? t('Autour de {name}', { name: mix.seed }) : mix.kind === 'discover' ? t('Des artistes proches des tiens, que tu n’as pas encore.') : t('Ce que tout le monde écoute en ce moment.')
export const mixCenter = mix => { const c = mix.covers?.find(x => x && !String(x).startsWith('local:')); return c || null }

export function MixArt({ mix, big = false }) {
  return <Rings seed={mix.id + (mix.seed || '') + (mix.kind)} label={mix.kind === 'daily' ? mix.seed : ''} center={mixCenter(mix)} big={big} />
}

export default function Home() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [recent, setRecent] = useState([])
  const [added, setAdded] = useState([])
  const open = useApp(s => s.open)
  const version = useApp(s => s.libraryVersion)

  const load = async (force = false) => {
    setLoading(true)
    try { setData(await api.forYou(force)) } catch (e) { setData({ error: e.message, mixes: [] }) } finally { setLoading(false) }
  }
  useEffect(() => { load(false) }, [])
  useEffect(() => {
    api.history(8).then(setRecent).catch(() => {})
    api.tracks({ sort: 'added', limit: 8 }).then(setAdded).catch(() => {})
  }, [version])

  const mixes = data?.mixes || []
  const local = rows => rows.map(r => ({ ...r, local_id: r.id }))
  return (
    <div className="page">
      <div className="page-head" style={{ minHeight: 0, paddingBottom: 0 }}>
        <span style={{ flex: 1 }} />
        <button type="button" className="icon-btn" onClick={() => load(true)} disabled={loading} aria-label={t('Actualiser')}>
          {loading ? <Loader2 size={20} className="spin" /> : <RefreshCw size={20} />}
        </button>
        <HeadActions />
      </div>
      <div className="hello">
        <h1>{greeting()}</h1>
        <p>{data?.basedOn?.length ? t('Basé sur {names}', { names: data.basedOn.slice(0, 3).join(', ') }) : t('Tes mixes du jour, faits avec ce que tu écoutes.')}</p>
      </div>

      <section className="section" aria-label={t('Pour toi')}>
        {loading && !mixes.length ? (
          <div className="rail">{[0, 1, 2].map(i => <div key={i} className="mix-card"><div className="art" style={{ background: 'var(--surface)' }} /></div>)}</div>
        ) : mixes.length ? (
          <div className="rail">
            {mixes.map(mix => (
              <button key={mix.id} type="button" className="mix-card" onClick={() => open({ type: 'mix', mix })}>
                <div className="art"><MixArt mix={mix} /></div>
                <div className="name">{mixTitle(mix)}</div>
                <div className="who">{mix.artists?.slice(0, 3).join(', ')}</div>
              </button>
            ))}
          </div>
        ) : (
          <p className="note">{data?.error ? t('Les mixes ont besoin d’Internet. Ta musique, elle, marche hors ligne.') : t('Écoute quelques titres : tes mixes se construiront autour.')}</p>
        )}
      </section>

      {recent.length > 0 && (
        <section className="section">
          <h2>{t('Reprendre')}</h2>
          <TrackList songs={local(recent).slice(0, 5)} />
        </section>
      )}
      {added.length > 0 && (
        <section className="section">
          <h2>{t('Ajoutés récemment')}</h2>
          <div className="rail">
            {local(added).map((song, i) => (
              <button key={song.id} type="button" className="album-tile" onClick={() => playList(local(added), i)}>
                <Cover song={song} className="art" />
                <div className="name">{song.title}</div>
                <div className="sub">{song.artist}</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export function MixScreen({ mix }) {
  const songs = mix.tracks
  return (
    <div className="page">
      <Back />
      <div className="hero">
        <div className="art"><MixArt mix={mix} big /></div>
        <h1>{mixTitle(mix)}</h1>
        <p>{mixLine(mix)}</p>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => playList(songs, 0)}>{t('Lire')}</button>
          <button type="button" className="btn quiet" onClick={() => playList(songs, 0, { shuffle: true })}>{t('Lecture aléatoire')}</button>
          <button type="button" className="btn quiet" onClick={() => downloadSongs(songs)}>{t('Tout télécharger')}</button>
        </div>
      </div>
      <section className="section"><TrackList songs={songs} /></section>
    </div>
  )
}
