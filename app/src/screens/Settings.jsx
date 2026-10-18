// Downloads, Settings, the first-run steps and the start-up screen.
import React, { useEffect, useState } from 'react'
import { Loader2, RotateCcw, X, FolderPlus, Check, AlertCircle } from 'lucide-react'
import { api } from '../api'
import { useApp, pokeDownloads } from '../store'
import { playList } from '../player'
import { Cover, StateMark } from '../components/Track'
import Back from '../components/Back'
import { pickFolder, requestMusicAccess, musicAccess, openAppSettings, verifyWindow, storagePaths } from '../native'
import { t } from '../i18n'
import { version } from '../version'

// ------------------------------------------------------------- downloads
export function Downloads() {
  const downloads = useApp(s => s.downloads)
  useEffect(() => { pokeDownloads() }, [])
  const label = d => ({ queued: t('En file'), downloading: `${t('Téléchargement…')} ${Math.round(d.progress || 0)} %`, saving: t('Enregistrement…'), done: t('Terminé'), error: t('Échec'), cancelled: t('Annulé') }[d.status])
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
                <span className="title" style={{ display: 'block' }}>{d.title || d.deezer_id}</span>
                <span className={`sub ${d.status === 'error' ? 'err' : ''}`} style={{ display: 'block' }}>{d.status === 'error' ? `${label(d)} : ${d.error}` : `${d.artist ? d.artist + ', ' : ''}${label(d)}`}</span>
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

// ------------------------------------------------------------- the source
/** Installs the Deezer source if needed, then runs its one-time check. */
export async function setUpSource({ install = true } = {}) {
  const app = useApp.getState()
  let source = await app.refreshSource()
  if (!source?.installed) {
    if (!install) return source
    source = await api.installSource()
    useApp.setState({ source })
  }
  if (source.ready) return source
  const info = await api.verifyInfo()
  if (info?.authenticated) return app.refreshSource()
  if (info?.url) {
    const result = await verifyWindow({ url: info.url, callback: info.callback, domains: info.domains || [] })
    await api.verifyComplete({ url: result?.url || null, cookies: result?.cookies || [] })
  }
  return app.refreshSource()
}

function SourceSetting({ autoVerify = false }) {
  const source = useApp(s => s.source)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (install) => {
    setBusy(true); setError('')
    try { await setUpSource({ install }) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  useEffect(() => { useApp.getState().refreshSource().then(s => { if (autoVerify && s?.installed && !s.ready) run(false) }) }, [])
  const text = !source?.installed ? t('Pas encore installée.') : source.ready ? t('Installée, prête.') : t('Installée. Elle demande une vérification rapide avant le premier téléchargement.')
  return (
    <div className="setting">
      <h3>{t('Source de téléchargement')}</h3>
      <p className="note">{t('Extension Deezer (SpotiFLAC)')}{source?.version ? ` ${source.version}` : ''}</p>
      <div className="status-line">{source?.ready ? <Check size={18} color="var(--sodium)" /> : <AlertCircle size={18} color="var(--muted)" />}<span>{text}</span></div>
      {error && <p className="note" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>}
      <div className="btn-row">
        {!source?.installed && <button type="button" className="btn primary" disabled={busy} onClick={() => run(true)}>{busy ? <Loader2 size={18} className="spin" /> : null}{t('Installer')}</button>}
        {source?.installed && !source.ready && <button type="button" className="btn primary" disabled={busy} onClick={() => run(false)}>{busy ? <Loader2 size={18} className="spin" /> : null}{t('Vérifier maintenant')}</button>}
        {source?.installed && <button type="button" className="btn quiet small" disabled={busy} onClick={async () => { setBusy(true); try { useApp.setState({ source: await api.installSource() }) } catch (e) { setError(e.message) } finally { setBusy(false) } }}>{t('Mettre à jour')}</button>}
      </div>
    </div>
  )
}

// --------------------------------------------------------------- settings
export function Settings({ verify = false }) {
  const [settings, setSettings] = useState(null)
  const [scan, setScan] = useState(null)
  const libraryChanged = useApp(s => s.libraryChanged)
  useEffect(() => { api.settings().then(setSettings).catch(() => {}) }, [])
  useEffect(() => {
    if (!scan?.scanning) return undefined
    const timer = setInterval(async () => {
      const s = await api.scanStatus().catch(() => null)
      if (s) setScan(s)
      if (s && !s.scanning) { clearInterval(timer); libraryChanged() }
    }, 700)
    return () => clearInterval(timer)
  }, [scan?.scanning])

  const folders = settings?.music_folders || []
  const saveFolders = async list => { const s = await api.saveSettings({ music_folders: list }); setSettings(s); setScan(await api.scan()) }
  const add = async () => { const f = await pickFolder(); if (f && !folders.includes(f)) saveFolders([...folders, f]) }

  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Réglages')}</h1></div>

      <div className="setting">
        <h3>{t('Dossiers de musique')}</h3>
        <p className="note">{t('Écho lit les fichiers audio de ces dossiers.')}</p>
        {folders.map(f => (
          <div className="folder" key={f}>
            <span>{f}</span>
            <button type="button" className="btn quiet small" onClick={() => saveFolders(folders.filter(x => x !== f))}>{t('Retirer')}</button>
          </div>
        ))}
        <div className="btn-row">
          <button type="button" className="btn quiet" onClick={add}><FolderPlus size={18} />{t('Ajouter un dossier')}</button>
          <button type="button" className="btn quiet" disabled={scan?.scanning} onClick={async () => setScan(await api.scan())}>{scan?.scanning ? <Loader2 size={18} className="spin" /> : <RotateCcw size={18} />}{t('Relire la bibliothèque')}</button>
        </div>
        {scan?.scanning && <p className="note" style={{ marginTop: 8 }}>{t('Lecture du dossier… {done}/{total}', { done: scan.done, total: scan.total || '…' })}</p>}
      </div>

      <SourceSetting autoVerify={verify} />

      <div className="setting">
        <h3>{t('Les téléchargements vont dans')}</h3>
        <p className="note" style={{ overflowWrap: 'anywhere' }}>{settings?.download_dir_used || '…'}</p>
      </div>

      <div className="setting" style={{ borderBottom: 0 }}>
        <h3>{t('À propos')}</h3>
        <p className="note">{t('Écho {v}. Moteur de téléchargement adapté de Lokal (MIT).', { v: version })}</p>
      </div>
    </div>
  )
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
        <p className="note">{t('Pour télécharger les titres que tu découvres, Écho utilise l’extension Deezer de SpotiFLAC. Elle demande une vérification rapide (un captcha) une fois.')}</p>
        {error && <p className="note" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="btn-row">
          <button type="button" className="btn primary" disabled={busy} onClick={source}>{busy && <Loader2 size={18} className="spin" />}{t('Installer et vérifier')}</button>
          <button type="button" className="btn quiet" onClick={finish}>{t('Passer')}</button>
        </div>
      </>}
    </div>
  )
}

export function Startup({ error, logs, onRetry }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setSlow(true), 4000); return () => clearTimeout(timer) }, [])
  return (
    <div className="center-screen" style={{ alignItems: 'flex-start' }}>
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
        <p className="note">{slow ? t('Premier démarrage, Écho se prépare…') : t('Démarrage…')}</p>
      </>}
    </div>
  )
}
