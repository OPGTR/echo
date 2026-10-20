// "Pour toi": a greeting, today's mixes (made from what you listen to), what
// you were listening to, what arrived lately.
import React, { useEffect, useState } from 'react'
import { Loader2, Play, Plus, Check } from 'lucide-react'
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

export const mixTitle = mix => mix.kind === 'daily' ? t('Mix du jour {n}', { n: mix.index }) : mix.kind === 'discover' ? t('Découvertes') : mix.kind === 'rediscover' ? t('À redécouvrir') : mix.kind === 'artist' ? t('Mix {name}', { name: mix.seed }) : t('Populaire en ce moment')
export const mixLine = mix => mix.kind === 'daily' ? t('Autour de {name}', { name: mix.seed }) : mix.kind === 'discover' ? t('Des artistes proches des tiens, que tu n’as pas encore.') : mix.kind === 'rediscover' ? t('Tes anciens favoris : tu les écoutais beaucoup, un peu moins aujourd’hui.') : mix.kind === 'artist' ? t('Que des titres de {name} : les connus, ceux de ses albums, et ceux que tu n’as jamais écoutés.', { name: mix.seed }) : t('Ce que tout le monde écoute en ce moment.')
export const mixWho = mix => mix.kind === 'rediscover' ? t('Tes anciens favoris') : mix.kind === 'discover' ? t('Des artistes que tu n’as pas encore') : mix.artists?.slice(0, 3).join(', ')
export const mixCenter = mix => { if (mix.picture) return mix.picture; const c = mix.covers?.find(x => x && !String(x).startsWith('local:')); return c || mix.tracks?.find(x => x.cover)?.cover || null }

export function MixArt({ mix, big = false }) {
  return <Rings seed={mix.id + (mix.seed || '') + (mix.kind)} label={mix.kind === 'daily' || mix.kind === 'artist' ? mix.seed : mix.kind === 'rediscover' ? t('À redécouvrir') : ''} center={mixCenter(mix)} big={big} />
}

/** "Du nouveau chez tes artistes": the artists you follow, a ring on those who released something. */
function NewFromArtists() {
  const follows = useApp(s => s.follows)
  const open = useApp(s => s.open)
  const artists = [...follows.artists].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0))
  const see = async a => { if (a.new) useApp.setState({ follows: await api.followSeen(a.id) }); open({ type: 'catalogue-artist', id: a.id }) }
  if (!artists.length) return null
  return (
    <section className="news-from" aria-label={t('Du nouveau chez tes artistes')}>
      <div className="between"><h2 className="small-h">{t('Du nouveau chez tes artistes')}</h2><button type="button" className="link-btn" style={{ marginTop: 0 }} onClick={() => open({ type: 'follows' })}>{t('Suivis')}</button></div>
      <div className="rail" style={{ gap: 10 }}>
        {artists.map(a => (
          <button key={a.id} type="button" className="bub" onClick={() => see(a)} aria-label={a.new ? t('{name}, nouveauté', { name: a.name }) : a.name}>
            <span className={`face ${a.new ? 'new' : ''}`}>{a.picture ? <img src={a.picture} alt="" loading="lazy" /> : null}</span>
            <span className="lbl">{a.name}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** The mix of one artist (only their songs): made and kept in "Tes mixes". */
export function ArtistMixCard({ id, name, picture }) {
  const [busy, setBusy] = useState(false)
  const make = async () => {
    setBusy(true)
    try { const pl = await api.createArtistMix(id); useApp.getState().libraryChanged(); return pl } catch (e) { useApp.getState().toast(e.message); return null } finally { setBusy(false) }
  }
  const mixOf = { id: `artist-${id}`, kind: 'artist', seed: name, picture }
  return (
    <div className="artist-mix card-surface">
      <button type="button" className="am-open" disabled={busy} onClick={async () => { const pl = await make(); if (pl) useApp.getState().open({ type: 'playlist', id: pl.id }) }}>
        <span className="am-art"><MixArt mix={mixOf} /></span>
        <span className="text"><span className="title">{t('Mix {name}', { name })}</span><span className="sub">{t('Que ses titres : les connus, ceux de ses albums, et ceux que tu n’as jamais écoutés')}</span></span>
      </button>
      <button type="button" className="am-play" aria-label={t('Lire le mix')} disabled={busy} onClick={async () => { const pl = await make(); if (pl) playList(pl.tracks, 0, { context: 'mix' }) }}>
        {busy ? <Loader2 size={20} className="spin" /> : <Play size={20} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />}
      </button>
    </div>
  )
}

/** "Tes mixes": the mixes you made, side by side; + puts one in your playlists. */
function YourMixes() {
  const [list, setList] = useState(null)
  const version = useApp(s => s.libraryVersion)
  const open = useApp(s => s.open)
  useEffect(() => { api.myMixes().then(setList).catch(() => setList([])) }, [version])
  if (!list?.length) return null
  const keep = async (e, pl) => {
    e.stopPropagation()
    const next = await api.keepMix(pl.id, !pl.meta?.saved).catch(() => null)
    if (!next) return
    setList(list.map(x => (x.id === pl.id ? next : x)))
    useApp.getState().toast(next.meta?.saved ? t('« {name} » est dans tes playlists.', { name: pl.name }) : t('« {name} » retiré de tes playlists.', { name: pl.name }))
  }
  return (
    <section className="section">
      <div className="between"><h2 style={{ margin: 0 }}>{t('Tes mixes')}</h2><span className="note" style={{ fontSize: 13 }}>{t('+ : ajouter à tes playlists')}</span></div>
      <div className="rail" style={{ marginTop: 12 }}>
        {list.map(pl => (
          <div key={pl.id} className="mix-card" role="button" tabIndex={0} onClick={() => open({ type: 'playlist', id: pl.id })} onKeyDown={e => { if (e.key === 'Enter') open({ type: 'playlist', id: pl.id }) }}>
            <div className="art">
              <Rings seed={pl.id} label={pl.meta?.artist?.name || ''} center={pl.meta?.artist?.picture || (pl.covers || []).find(c => c && !String(c).startsWith('local:')) || null} />
              <button type="button" className={`keep ${pl.meta?.saved ? 'on' : ''}`} onClick={e => keep(e, pl)} aria-label={pl.meta?.saved ? t('Dans tes playlists') : t('Ajouter à mes playlists')} aria-pressed={!!pl.meta?.saved}>
                {pl.meta?.saved ? <Check size={16} strokeWidth={2.8} /> : <Plus size={16} strokeWidth={2.8} />}
              </button>
            </div>
            <div className="name">{pl.name.replace(/^Ton mix · /, '')}</div>
            <div className="who">{pl.meta?.saved ? t('Dans tes playlists') : t('{n} titres', { n: pl.count })}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function Home() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [era, setEra] = useState(null)
  const open = useApp(s => s.open)
  const sections = useApp(s => s.prefs.sections || {})
  const show = key => sections[key] !== false

  const load = async (force = false) => {
    setLoading(true)
    try { const r = await api.forYou(force); setData(r); setEra(r.era || 'both') } catch (e) { setData({ error: e.message, mixes: [] }) } finally { setLoading(false) }
  }
  useEffect(() => { load(false) }, [])
  const chooseEra = async value => {
    if (value === era) return
    setEra(value)
    await api.saveSettings({ mix_era: value }).catch(() => {})
    load(false)
  }

  const mixes = (data?.mixes || []).filter(m => (m.kind === 'daily' ? show('daily') : m.kind === 'discover' ? show('discover') : m.kind === 'rediscover' ? show('rediscover') : show('chart')))
  return (
    <div className="page">
      <div className="page-head" style={{ minHeight: 0, paddingBottom: 0 }}>
        <span style={{ flex: 1 }} />
        <HeadActions withUpdate />
      </div>
      <div className="hello">
        <h1>{greeting()}</h1>
      </div>

      {show('follows') && <NewFromArtists />}

      {(show('daily') || show('discover') || show('chart') || show('rediscover')) && (
        <section className="section" aria-label={t('Tes mixes du jour')}>
          <h2>{t('Tes mixes du jour')}</h2>
          <div className="segments era" role="group" aria-label={t('Époque des recommandations')}>
            {[['both', 'Les deux'], ['recent', 'Récentes'], ['old', 'Anciennes']].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={era === id} onClick={() => chooseEra(id)}>{t(label)}</button>
            ))}
          </div>
          <p className="era-note">{t('Récentes : moins d’un an · Anciennes : plus d’un an')}</p>
          {loading && !mixes.length ? (
            <div className="rail" style={{ marginTop: 12 }}>{[0, 1, 2].map(i => <div key={i} className="mix-card"><div className="art" style={{ background: 'var(--surface)' }} /></div>)}</div>
          ) : mixes.length ? (
            <div className="rail" style={{ marginTop: 12, opacity: loading ? 0.55 : 1 }}>
              {mixes.map(mix => (
                <button key={mix.id} type="button" className="mix-card" onClick={() => open({ type: 'mix', mix })}>
                  <div className="art"><MixArt mix={mix} /></div>
                  <div className="name">{mixTitle(mix)}</div>
                  <div className="who">{mixWho(mix)}</div>
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

      {show('custom') && <YourMixes />}
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
          <button type="button" className="btn primary" onClick={() => playList(songs, 0, { context: 'mix' })}>{t('Lire')}</button>
          <button type="button" className="btn quiet" onClick={() => playList(songs, 0, { shuffle: true, context: 'mix' })}>{t('Lecture aléatoire')}</button>
          <button type="button" className="btn quiet" onClick={() => downloadSongs(songs)}>{t('Tout télécharger')}</button>
        </div>
      </div>
      <section className="section"><TrackList songs={songs} /></section>
    </div>
  )
}
