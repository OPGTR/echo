import React, { useEffect, useState } from 'react'
import { useApp, watchDownloads } from './store'
import { usePlayer, openFull, restoreSession } from './player'
import { api, setServer } from './api'
import { connectServer, serverLogs, storagePaths, onBackButton, minimize, onResume } from './native'
import Home, { MixScreen } from './screens/Home'
import Search, { CatalogueAlbum, CatalogueArtist } from './screens/Search'
import Library, { LocalAlbum, LocalArtist } from './screens/Library'
import { Downloads, Onboarding, Startup } from './screens/Settings'
import Playlists, { PlaylistScreen, ImportScreen, MixCreate, LikedScreen, AddSongs } from './screens/Playlists'
import { SettingsHome, ThemeScreen, EqualizerScreen, QualityScreen, AudioTest, SourcesScreen, FoldersScreen, StartScreen, UpdateScreen } from './screens/Preferences'
import { DEFAULT_PREFS } from './store'
import { applyTheme } from './theme'
import { applyEqualizer } from './player'
import { appInfo } from './native'
import { TabBar, MiniPlayer, FullPlayer, ActionSheet, Toasts } from './components/Chrome'

function Screen() {
  const tab = useApp(s => s.tab)
  const top = useApp(s => s.stack[s.stack.length - 1])
  if (top) {
    switch (top.type) {
      case 'mix': return <MixScreen key={top.mix.id} mix={top.mix} />
      case 'catalogue-album': return <CatalogueAlbum key={top.id} id={top.id} />
      case 'catalogue-artist': return <CatalogueArtist key={top.id} id={top.id} />
      case 'album': return <LocalAlbum key={top.album + top.artist} album={top.album} artist={top.artist} />
      case 'artist': return <LocalArtist key={top.name} name={top.name} />
      case 'downloads': return <Downloads />
      case 'settings': return <SettingsHome />
      case 'theme': return <ThemeScreen focus={top.focus} />
      case 'equalizer': return <EqualizerScreen />
      case 'quality': return <QualityScreen />
      case 'audio-test': return <AudioTest />
      case 'sources': return <SourcesScreen focus={top.focus} verify={!!top.verify} />
      case 'folders': return <FoldersScreen />
      case 'start': return <StartScreen />
      case 'update': return <UpdateScreen />
      case 'playlist': return <PlaylistScreen key={top.id} id={top.id} />
      case 'liked': return <LikedScreen />
      case 'add-songs': return <AddSongs id={top.id} />
      case 'import': return <ImportScreen />
      case 'mix-create': return <MixCreate />
      default: return null
    }
  }
  if (tab === 'search') return <Search />
  if (tab === 'playlists') return <Playlists />
  if (tab === 'library') return <Library />
  return <Home />
}

export default function App() {
  const [phase, setPhase] = useState('starting') // starting | onboarding | ready | failed
  const [error, setError] = useState('')
  const [logs, setLogs] = useState([])

  const start = async () => {
    setPhase('starting'); setError('')
    try {
      setServer(await connectServer())
      const paths = await storagePaths()
      const settings = await api.platform({ musicDir: paths.musicDir, mediaDir: paths.mediaDir })
      watchDownloads()
      useApp.getState().refreshSource()
      // Your choices: theme, equalizer, start page, sections.
      const saved = await api.prefs().catch(() => ({}))
      const prefs = { ...DEFAULT_PREFS, ...saved, sections: { ...DEFAULT_PREFS.sections, ...(saved.sections || {}) }, eq: { ...DEFAULT_PREFS.eq, ...(saved.eq || {}) } }
      useApp.setState({ prefs, tab: prefs.startTab || 'home' })
      applyTheme(prefs)
      applyEqualizer(prefs.eq)
      restoreSession()
      setPhase(settings.onboarded ? 'ready' : 'onboarding')
      // In the background: new releases of artists you follow, a new version of Écho.
      useApp.getState().refreshFollows()
      appInfo().then(async info => {
        useApp.setState({ appBuild: Number(info.build) || 0 })
        try { useApp.setState({ update: await api.update(Number(info.build) || 0) }) } catch {}
      })
    } catch (e) {
      setError(e.message || String(e))
      setLogs(await serverLogs().catch(() => []))
      setPhase('failed')
    }
  }
  useEffect(() => { start() }, [])

  // The phone's back button: close what's open, go back, else leave Écho in
  // the background (the music keeps playing).
  useEffect(() => {
    let off = () => {}
    onBackButton(() => {
      if (usePlayer.getState().fullOpen) { openFull(false); return }
      if (!useApp.getState().back()) minimize()
    }).then(fn => { off = fn })
    return () => off()
  }, [])
  // Back in Écho: new files may have arrived (USB, another app).
  useEffect(() => {
    let off = () => {}
    onResume(() => {
      if (phase !== 'ready') return
      api.scan().then(() => setTimeout(() => useApp.getState().libraryChanged(), 4000)).catch(() => {})
      if (useApp.getState().prefs.theme === 'material') applyTheme(useApp.getState().prefs)
    }).then(fn => { off = fn })
    return () => off()
  }, [phase])

  // Pages scroll back to the top when they change.
  const top = useApp(s => s.stack.length + ':' + s.tab)
  useEffect(() => { document.querySelector('.page')?.scrollTo(0, 0) }, [top])

  if (phase === 'starting' || phase === 'failed') return <Startup error={phase === 'failed' ? error : ''} logs={logs} onRetry={start} />
  if (phase === 'onboarding') return <Onboarding onDone={() => setPhase('ready')} />
  return (
    <div className="app">
      <Screen />
      <div className="dock">
        <MiniPlayer />
        <TabBar />
      </div>
      <FullPlayer />
      <ActionSheet />
      <Toasts />
    </div>
  )
}
