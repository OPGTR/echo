// Downloads, setting up a source, the first-run steps and the start-up screen.
import React, { useEffect, useState } from 'react'
import { Loader2, RotateCcw, X, FolderPlus, Check, AlertCircle } from 'lucide-react'
import { api } from '../api'
import { useApp, pokeDownloads } from '../store'
import { playList } from '../player'
import { Cover, StateMark } from '../components/Track'
import Back from '../components/Back'
import { pickFolder, requestMusicAccess, openAppSettings, verifyWindow, storagePaths } from '../native'
import { t } from '../i18n'
import { version } from '../version'

// ------------------------------------------------------------- downloads
export function Downloads() {
  const downloads = useApp(s => s.downloads)
  useEffect(() => { pokeDownloads() }, [])
  const via = d => (d.message?.startsWith('via:') ? ` · ${t('via {s}', { s: d.message.slice(4) })}` : '')
  const trying = d => (d.message?.startsWith('try:') ? ` · ${t('essai avec {s}', { s: d.message.slice(4) })}` : '')
  const label = d => ({ queued: t('En file'), downloading: `${t('Téléchargement…')} ${Math.round(d.progress || 0)} %${trying(d)}`, saving: t('Enregistrement…'), done: `${t('Terminé')}${via(d)}`, error: t('Échec'), cancelled: t('Annulé') }[d.status])
  return (
    <div className="page">
      <Back>{downloads.some(d => ['done', 'error', 'cancelled'].includes(d.status)) && <button type="button" className="btn quiet small" onClick={async () => { await api.clearDownloads(); pokeDownloads() }}>{t('Effacer les terminés')}</button>}</Back>
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Téléchargements')}</h1></div>
      {!downloads.length && <div className="empty"><strong>{t('Aucun téléchargement.')}</strong>{t('Lance un titre que tu n’as pas : il se télécharge, puis se lit.')}</div>}
      {downloads.map(d => {
        const song = { deezer_id: d.deezer_id, local_id: d.status === 'done' ? d.track_id : null, title: d.title, artist: d.artist, cover: d.cover, has_art: 1 }
        const active = ['queued', 'downloading', 'saving'].includes(d.status)
        return (
          <div className="dl" key={d.id}>
            <button type="button" className="open" disabled={d.status !== 'done'} onClick={() => playList([song], 0)}>
              <Cover song={song} />
              <span className="text">
                <span className="title wrap2">{d.title || d.deezer_id}</span>
                {d.artist && <span className="sub wrap2">{d.artist}</span>}
                <span className={`state-line ${d.status === 'error' ? 'err' : active ? 'on' : ''}`}>{d.status === 'error' ? `${label(d)} : ${d.error}` : label(d)}</span>
                {d.status === 'downloading' && <span className="bar-track thin"><i style={{ width: `${Math.max(3, Math.round(d.progress || 0))}%` }} /></span>}
              </span>
            </button>
            {active ? <StateMark song={song} progress={d.status === 'queued' ? 0 : d.progress} /> : d.status === 'done' ? <Check size={20} color="var(--muted)" /> : null}
            {active && <button type="button" className="icon-btn" aria-label={t('Annuler')} onClick={async () => { await api.cancelDownload(d.id); pokeDownloads() }}><X size={20} /></button>}
            {['error', 'cancelled'].includes(d.status) && <button type="button" className="icon-btn" aria-label={t('Réessayer')} onClick={async () => { await api.retryDownload(d.id); pokeDownloads() }}><RotateCcw size={20} /></button>}
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------- sources
/** Installs a source if needed (Deezer by default), then runs its one-time check. */
export async function setUpSource({ install = true, id = 'deezer' } = {}) {
  const app = useApp.getState()
  let state = await api.sources()
  let src = state.sources.find(x => x.id === id)
  if (!src?.installed) {
    if (!install) return state
    state = await api.installSourceId(id)
    src = state.sources.find(x => x.id === id)
  }
  if (src?.ready) { app.refreshSource(); return state }
  const info = await api.verifyInfo(id)
  if (info?.url && !info?.authenticated) {
    const result = await verifyWindow({ url: info.url, callback: info.callback, domains: info.domains || [] })
    await api.verifyComplete({ id, url: result?.url || null, cookies: result?.cookies || [] })
  }
  await app.refreshSource()
  return api.sources()
}

// ----------------------------------------------------------- first run
export function Onboarding({ onDone }) {
  const [step, setStep] = useState(0)
  const [denied, setDenied] = useState(false)
  const [folders, setFolders] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (step !== 1) return
    ;(async () => {
      const paths = await storagePaths()
      const current = (await api.settings().catch(() => null))?.music_folders || []
      setFolders(current.length ? current : paths.musicDir ? [paths.musicDir] : [])
    })()
  }, [step])

  const allow = async () => {
    setBusy(true)
    try { const r = await requestMusicAccess(); if (r.media || r.allFiles) { setDenied(false); setStep(1) } else setDenied(true) } catch { setDenied(true) } finally { setBusy(false) }
  }
  const finishFolders = async () => {
    await api.saveSettings({ music_folders: folders })
    api.scan().catch(() => {})
    setStep(2)
  }
  const source = async () => {
    setBusy(true); setError('')
    try { await setUpSource(); finish() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const finish = async () => { await api.saveSettings({ onboarded: true }).catch(() => {}); onDone() }

  return (
    <div className="center-screen">
      <div className="steps">{[0, 1, 2].map(i => <i key={i} className={i <= step ? 'on' : ''} />)}</div>
      {step === 0 && <>
        <h1>{t('Accès à ta musique')}</h1>
        <p className="note">{t('Écho lit les fichiers audio de ton téléphone. Rien ne quitte ton appareil.')}</p>
        {denied && <p className="note" style={{ color: 'var(--danger)' }}>{t('Accès refusé. Autorise « Musique et audio » dans les réglages de l’appli.')}</p>}
        <div className="btn-row">
          <button type="button" className="btn primary" disabled={busy} onClick={allow}>{t('Autoriser')}</button>
          {denied && <button type="button" className="btn quiet" onClick={openAppSettings}>{t('Ouvrir les réglages')}</button>}
          <button type="button" className="btn quiet" onClick={() => setStep(1)}>{t('Plus tard')}</button>
        </div>
      </>}
      {step === 1 && <>
        <h1>{t('Où est ta musique ?')}</h1>
        <p className="note">{t('Écho lira ces dossiers. Tu pourras en ajouter plus tard.')}</p>
        {folders.map(f => (
          <div className="folder" key={f}><span>{f}</span><button type="button" className="btn quiet small" onClick={() => setFolders(folders.filter(x => x !== f))}>{t('Retirer')}</button></div>
        ))}
        <div className="btn-row">
          <button type="button" className="btn quiet" onClick={async () => { const f = await pickFolder(); if (f && !folders.includes(f)) setFolders([...folders, f]) }}><FolderPlus size={18} />{t('Ajouter un dossier')}</button>
          <button type="button" className="btn primary" onClick={finishFolders}>{t('Continuer')}</button>
        </div>
      </>}
      {step === 2 && <>
        <h1>{t('Télécharger de la musique')}</h1>
        <p className="note">{t('Pour télécharger les titres que tu découvres, Écho utilise l’extension Deezer de Mornye. Elle peut demander une vérification rapide (un captcha).')}</p>
        {error && <p className="note" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="btn-row">
          <button type="button" className="btn primary" disabled={busy} onClick={source}>{busy && <Loader2 size={18} className="spin" />}{t('Installer et vérifier')}</button>
          <button type="button" className="btn quiet" onClick={finish}>{t('Passer')}</button>
        </div>
      </>}
    </div>
  )
}

// Said while Écho starts, a different one each time.
const SPLASH = [
  'Accordage des guitares…',
  'On souffle sur le vinyle…',
  'Le batteur cherche ses baguettes.',
  'Chauffe les enceintes, pas les voisins.',
  'Échauffement des cordes vocales…',
  'Rembobinage de la cassette…',
  'Le DJ choisit le prochain son.',
  'Un, deux, un, deux… test micro.',
  'Les basses arrivent, les voisins aussi.',
  'Mise en place du refrain.',
  'On range les CD par couleur.',
  'Le métronome se met à l’heure.',
  'Fais de la place au dernier rang.',
  'Recherche du bon tempo…',
  'Le saxophone fait ses gammes.',
  'Rappel ! Rappel !',
  'Chut, ça commence.',
  'Les écouteurs se démêlent tout seuls (presque).',
  'Version longue, sans coupure pub.',
  'Lumière sur la scène…',
  'Le piano est accordé, promis.',
  'Ce soir, playlist sans fausse note.',
  'On cherche la face B.',
  'Le public allume ses briquets.',
  'Mode aléatoire, mais pas trop.',
  'Les ondes se propagent…',
  'Ta musique, chez toi, hors ligne.',
  'Le volume est à 11.',
  'Pas de pub. Juste du son.',
  'Écho… écho… écho…',
  'Lecture de la partition…',
  'Les violons s’accordent sur un la.',
  'Encore un petit solo et on y va.',
  'Ça va groover.',
  'Le refrain tourne déjà dans ta tête.',
]

function splashLine() {
  let last = -1
  try { last = Number(localStorage.getItem('echo-splash') ?? -1) } catch {}
  let i = Math.floor(Math.random() * SPLASH.length)
  if (i === last) i = (i + 1) % SPLASH.length
  try { localStorage.setItem('echo-splash', String(i)) } catch {}
  return SPLASH[i]
}

export function Startup({ error, logs, onRetry }) {
  const [slow, setSlow] = useState(false)
  const [line] = useState(splashLine)
  useEffect(() => { const timer = setTimeout(() => setSlow(true), 4000); return () => clearTimeout(timer) }, [])
  return (
    <div className={`center-screen ${error ? '' : 'startup'}`} style={error ? { alignItems: 'flex-start' } : undefined}>
      <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
        {[34, 26, 18].map((r, i) => <circle key={r} cx="36" cy="36" r={r} fill="none" stroke="var(--sodium)" strokeOpacity={0.35 + i * 0.25} strokeWidth="2.5" />)}
        <circle cx="36" cy="36" r="8" fill="var(--sodium)" />
      </svg>
      {error ? <>
        <h1>{t('Écho n’a pas pu démarrer')}</h1>
        <p className="note">{error}</p>
        <div className="btn-row"><button type="button" className="btn primary" onClick={onRetry}>{t('Réessayer')}</button></div>
        {logs?.length > 0 && <pre>{logs.slice(-20).join('\n')}</pre>}
      </> : <>
        <h1>Écho</h1>
        <p className="splash-line" role="status">{line}</p>
        {slow && <p className="note" style={{ fontSize: 13.5, marginTop: 6 }}>{t('Premier démarrage, Écho se prépare…')}</p>}
      </>}
    </div>
  )
}
