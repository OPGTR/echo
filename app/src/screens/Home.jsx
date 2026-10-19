// "Pour toi": a greeting, today's mixes (made from what you listen to), what
// you were listening to, what arrived lately.
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { playList, coverOf } from '../player'
import Rings from '../components/Rings'
import { TrackList, TrackRow, Cover, downloadSongs } from '../components/Track'
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

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const sinceLabel = ts => { const d = new Date(ts); return t('rien depuis {m}', { m: MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '') }) }

export default function Home() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [era, setEra] = useState(null)
  const [recent, setRecent] = useState([])
  const [added, setAdded] = useState([])
  const open = useApp(s => s.open)
  const version = useApp(s => s.libraryVersion)
  const sections = useApp(s => s.prefs.sections || {})
  const show = key => sections[key] !== false

  const load = async (force = false) => {
    setLoading(true)
    try { const r = await api.forYou(force); setData(r); setEra(r.era || 'both') } catch (e) { setData({ error: e.message, mixes: [] }) } finally { setLoading(false) }
  }
  useEffect(() => { load(false) }, [])
  useEffect(() => {
    api.history(8).then(setRecent).catch(() => {})
    api.tracks({ sort: 'added', limit: 8 }).then(setAdded).catch(() => {})
  }, [version])
  const chooseEra = async value => {
    if (value === era) return
    setEra(value)
    await api.saveSettings({ mix_era: value }).catch(() => {})
    load(false)
  }

  const mixes = (data?.mixes || []).filter(m => (m.kind === 'daily' ? show('daily') : m.kind === 'discover' ? show('discover') : show('chart')))
  const local = rows => rows.map(r => ({ ...r, local_id: r.id }))
  const rediscover = data?.rediscover || []
  return (
    <div className="page">
      <div className="page-head" style={{ minHeight: 0, paddingBottom: 0 }}>
        <span style={{ flex: 1 }} />
        <HeadActions withUpdate />
      </div>
      <div className="hello">
        <h1>{greeting()}</h1>
        <p>{data?.basedOn?.length ? t('Basé sur {names}', { names: data.basedOn.slice(0, 3).join(', ') }) : t('Tes mixes du jour, faits avec ce que tu écoutes.')}</p>
      </div>

      {(show('daily') || show('discover') || show('chart')) && (
        <section className="section" aria-label={t('Tes mixes du jour')}>
          <h2>{t('Tes mixes du jour')}</h2>
          <div className="segments era" role="group" aria-label={t('Époque des recommandations')}>
            {[['both', 'Les deux'], ['recent', 'Récentes'], ['old', 'Anciennes']].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={era === id} onClick={() => chooseEra(id)}>{t(label)}</button>
            ))}
          </div>
          {loading && !mixes.length ? (
            <div className="rail" style={{ marginTop: 14 }}>{[0, 1, 2].map(i => <div key={i} className="mix-card"><div className="art" style={{ background: 'var(--surface)' }} /></div>)}</div>
          ) : mixes.length ? (
            <div className="rail" style={{ marginTop: 14, opacity: loading ? 0.55 : 1 }}>
              {mixes.map(mix => (
                <button key={mix.id} type="button" className="mix-card" onClick={() => open({ type: 'mix', mix })}>
                  <div className="art"><MixArt mix={mix} /></div>
                  <div className="name">{mixTitle(mix)}</div>
                  <div className="who">{mix.artists?.slice(0, 3).join(', ')}</div>
                </button>
              ))}
            </div>
          ) : (
            <p className="note" style={{ marginTop: 12 }}>{data?.error ? t('Les mixes ont besoin d’Internet. Ta musique, elle, marche hors ligne.') : t('Écoute quelques titres : tes mixes se construiront autour.')}</p>
          )}
        </section>
      )}

      {show('custom') && (
        <button type="button" className="your-mix card-surface" onClick={() => open({ type: 'mix-create' })}>
          <span className="faces" aria-hidden="true"><i /><i /><i className="add" /></span>
          <span className="text"><span className="title">{t('Ton mix')}</span><span className="sub">{t('Mélange 2 ou 3 artistes que tu aimes')}</span></span>
          <span className="btn primary small">{t('Créer')}</span>
        </button>
      )}

      {show('rediscover') && rediscover.length > 0 && (
        <section className="section">
          <h2>{t('À redécouvrir')}</h2>
          <p className="lead">{t('Tu les écoutais beaucoup, un peu moins aujourd’hui.')}</p>
          <div className="tracks rediscover">
            {rediscover.slice(0, 6).map((song, i) => (
              <TrackRow key={song.local_id} number={String(i + 1).padStart(2, '0')} song={{ ...song, artist: `${song.artist} · ${t('{n} écoutes', { n: song.play_count })}, ${sinceLabel(song.last_played)}` }} onPlay={() => playList(rediscover, i, { context: 'rediscover' })} />
            ))}
          </div>
        </section>
      )}

      {show('resume') && recent.length > 0 && (
        <section className="section">
          <h2>{t('Reprendre')}</h2>
          <TrackList songs={local(recent).slice(0, 5)} />
        </section>
      )}
      {show('added') && added.length > 0 && (
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
