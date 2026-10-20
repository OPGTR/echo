// Settings: appearance (theme, icon), sound (equalizer, audio test), download
// quality and sources, folders, start page, updates.
import React, { useEffect, useRef, useState } from 'react'
import { ChevronRight, Check, Loader2, FolderPlus, RotateCcw, GripVertical, Plus, Upload, Info, Bluetooth, Headphones, ArrowUpCircle, ShieldCheck, Play, Pause } from 'lucide-react'
import { api } from '../api'
import { useApp, DEFAULT_PREFS } from '../store'
import { applyEqualizer, usePlayer, playList } from '../player'
import { Cover } from '../components/Track'
import { engine, BANDS } from '../engine'
import Back from '../components/Back'
import { pickFolder, setLauncherIcon, pinShortcut, installApk, appInfo, isNative, EchoNative, dynamicColors } from '../native'
import { applyTheme } from '../theme'
import { setUpSource } from './Settings'
import { t } from '../i18n'
import { version } from '../version'

const THEMES = [
  { id: 'indigo', name: 'Nuit indigo' },
  { id: 'glass', name: 'Liquid glass' },
  { id: 'luce', name: 'Luce' },
  { id: 'material', name: 'Material You', note: 'Couleurs de ton fond d’écran' },
  { id: 'fixed', name: 'Couleur fixe' },
]
const ACCENTS = [['#f2c14e', 'Jaune sodium'], ['#f59ab8', 'Rose'], ['#7fd1c1', 'Menthe'], ['#b7a6ff', 'Lilas'], ['#ff8a65', 'Corail'], ['#7fb7ff', 'Ciel']]
const TIERS = [
  { id: 'hires', name: 'FLAC 24 bits · 192 kHz', note: 'Hi-Res', size: '~ 450 Mo par album', per1000: '~ 45 Go' },
  { id: 'cd', name: 'FLAC 16 bits · 44,1 kHz', note: 'Qualité CD', size: '~ 300 Mo par album', per1000: '~ 30 Go' },
  { id: 'lossy', name: 'MP3 · 128 kbps', note: 'Léger', size: '~ 45 Mo par album', per1000: '~ 4 Go' },
]
export const EQ_PRESETS = {
  flat: { name: 'Plat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Basses+', bands: [6, 5, 4, 2, 0, 0, 0, 1, 1, 1] },
  vocal: { name: 'Voix', bands: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  electro: { name: 'Électro', bands: [5, 4, 1, 0, -2, 1, 1, 2, 4, 5] },
  acoustic: { name: 'Acoustique', bands: [3, 2, 1, 1, 1, 1, 2, 3, 2, 1] },
  custom: { name: 'Perso', bands: null },
}

function Row({ label, value, onClick, accent = false }) {
  return (
    <button type="button" className="set-row" onClick={onClick}>
      <span className="label">{label}</span>
      {value && <span className={`value ${accent ? 'accent' : ''}`}>{value}</span>}
      <ChevronRight size={18} className="chev" />
    </button>
  )
}

// ---------------------------------------------------------------- the list
/** Écho's version and what it is made with. */
async function showAbout() {
  const info = await appInfo().catch(() => ({}))
  useApp.getState().showSheet({
    title: `Écho ${version}`,
    subtitle: [info.build ? t('Build {b}', { b: info.build }) : null, info.abi || null].filter(Boolean).join(' · '),
    items: [],
    footer: (
      <div className="about">
        <div className="between"><span className="muted">{t('Moteur de téléchargement')}</span><span>{t('adapté de Lokal (MIT)')}</span></div>
        <div className="between"><span className="muted">{t('Paroles')}</span><span>LRCLIB</span></div>
        <div className="between"><span className="muted">{t('Code et notes de version')}</span><a href="https://github.com/OPGTR/echo/releases" target="_blank" rel="noreferrer" style={{ color: 'var(--sodium)', fontWeight: 650 }}>GitHub</a></div>
      </div>
    ),
  })
}

const ERA_STEPS = [3, 6, 9, 12, 18, 24, 36, 48, 60]
const monthsLabel = m => (m % 12 === 0 ? (m === 12 ? t('1 an') : t('{n} ans', { n: m / 12 })) : t('{n} mois', { n: m }))

/** How recent "Récentes" is in the daily mixes (and so where "Anciennes" starts). */
function EraRow({ settings, onSaved }) {
  const saved = settings?.mix_recent_months || 12
  const [step, setStep] = useState(null)
  const index = step ?? Math.max(0, ERA_STEPS.findIndex(m => m >= saved))
  const months = ERA_STEPS[index]
  const commit = async () => { if (step === null) return; const r = await api.saveSettings({ mix_recent_months: ERA_STEPS[step] }).catch(() => null); if (r) onSaved(r); setStep(null) }
  return (
    <div className="era-row">
      <div className="between"><span>{t('Récentes ou anciennes')}</span><b className="accent">{monthsLabel(months)}</b></div>
      <p className="note" style={{ margin: '4px 0 0', fontSize: 13 }}>{t('Dans les mixes du jour, « Récentes » = sorties depuis moins de {d}, « Anciennes » = avant.', { d: monthsLabel(months) })}</p>
      <input type="range" className="wide-range" min="0" max={ERA_STEPS.length - 1} step="1" value={index} aria-label={t('Récentes ou anciennes')}
        onChange={e => setStep(Number(e.target.value))} onPointerUp={commit} onTouchEnd={commit} onKeyUp={commit} />
      <div className="era-scale"><span>{t('3 mois')}</span><span>{t('1 an')}</span><span>{t('2 ans')}</span><span>{t('5 ans')}</span></div>
    </div>
  )
}

export function SettingsHome() {
  const open = useApp(s => s.open)
  const prefs = useApp(s => s.prefs)
  const update = useApp(s => s.update)
  const [settings, setSettings] = useState(null)
  const [sources, setSources] = useState(null)
  const [dislikes, setDislikes] = useState(null)
  useEffect(() => {
    api.dislikes().then(l => setDislikes(l.length)).catch(() => {})
    api.settings().then(setSettings).catch(() => {})
    api.sources().then(setSources).catch(() => {})
  }, [])
  const tier = TIERS.find(x => x.id === (settings?.quality_tier || 'cd'))
  const active = sources?.sources.filter(x => x.installed && x.enabled).map(x => x.name) || []
  const theme = THEMES.find(x => x.id === prefs.theme)?.name || 'Nuit indigo'
  const eq = prefs.eq?.enabled ? EQ_PRESETS[prefs.eq.preset]?.name || t('Perso') : t('Désactivé')
  const start = { home: 'Pour toi', search: 'Rechercher', playlists: 'Playlists', library: 'Bibliothèque' }[prefs.startTab || 'home']
  const folder = String(settings?.download_dir_used || '').replace(/^\/storage\/emulated\/0\//, '').replace(/^.*\/Android\/media\/[^/]+\//, 'Écho › ')
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Réglages')}</h1></div>
      <div className="grp">{t('Apparence')}</div>
      <div className="set-card">
        <Row label={t('Thème')} value={t(theme)} onClick={() => open({ type: 'theme' })} />
        <Row label={t('Icône de l’appli')} value={prefs.icon === 'Luce' ? 'Luce' : prefs.icon === 'Glass' ? 'Liquid glass' : 'Écho'} onClick={() => open({ type: 'theme', focus: 'icon' })} />
      </div>
      <div className="grp">{t('Son')}</div>
      <div className="set-card">
        <Row label={t('Égaliseur')} value={eq} onClick={() => open({ type: 'equalizer' })} />
        <Row label={t('Test audio')} value={prefs.audioTest ? t('Jusqu’à {k} kHz', { k: Math.round(prefs.audioTest.limit / 100) / 10 }) : t('Pas encore fait')} onClick={() => open({ type: 'audio-test' })} />
      </div>
      <div className="grp">{t('Préférences')}</div>
      <div className="set-card">
        <Row label={t('Qualité de téléchargement')} value={tier ? tier.name.split(' · ')[0] : ''} onClick={() => open({ type: 'quality' })} />
        <Row label={t('Sources')} value={active.length ? active.slice(0, 2).join(', ') + (active.length > 2 ? '…' : '') : t('Aucune')} accent={!active.length} onClick={() => open({ type: 'sources' })} />
        <EraRow settings={settings} onSaved={setSettings} />
        <Row label={t('Dossier des téléchargements')} value={folder || '…'} onClick={() => open({ type: 'sources', focus: 'folder' })} />
        <Row label={t('Page de démarrage')} value={t(start)} onClick={() => open({ type: 'start' })} />
      </div>
      <div className="grp">{t('Bibliothèque')}</div>
      <div className="set-card">
        <Row label={t('Dossiers de musique')} value={settings ? t('{n} dossier(s)', { n: settings.music_folders.length }) : ''} onClick={() => open({ type: 'folders' })} />
        <Row label={t('Titres que tu n’aimes pas')} value={dislikes === null ? '' : dislikes ? String(dislikes) : t('Aucun')} onClick={() => open({ type: 'dislikes' })} />
      </div>
      <div className="grp">Écho</div>
      <div className="set-card">
        <Row label={t('Mises à jour')} value={update?.available ? t('{v} disponible', { v: update.version }) : t('À jour')} accent={!!update?.available} onClick={() => open({ type: 'update' })} />
        <Row label={t('À propos')} value={version} onClick={showAbout} />
      </div>
    </div>
  )
}

// ------------------------------------------------- songs you don't like
export function DislikesScreen() {
  const [list, setList] = useState(null)
  useEffect(() => { api.dislikes().then(setList).catch(() => setList([])) }, [])
  const restore = async item => { setList(await api.undislike({ key: item.key })); useApp.getState().toast(t('« {title} » pourra de nouveau t’être proposé.', { title: item.title })) }
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Titres que tu n’aimes pas')}</h1></div>
      <p className="note" style={{ marginTop: 0 }}>{t('Ils ne te sont plus proposés dans tes mixes ni dans Pour toi. Touche « Remettre » pour changer d’avis.')}</p>
      {list === null && <div className="empty"><Loader2 className="spin" /></div>}
      {list && !list.length && <div className="empty"><strong>{t('Aucun titre écarté')}</strong>{t('Dans le menu d’un titre, choisis « Je n’aime pas ce titre ».')}</div>}
      <div className="tracks" style={{ marginTop: 10 }}>
        {(list || []).map(item => (
          <div className="row" key={item.key}>
            <div className="track" style={{ cursor: 'default' }}>
              <span className="text"><span className="title" style={{ display: 'block' }}>{item.title}</span><span className="sub" style={{ display: 'block' }}>{item.artist}</span></span>
            </div>
            <button type="button" className="btn quiet small" onClick={() => restore(item)}>{t('Remettre')}</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ theme + icon
export function ThemeScreen({ focus }) {
  const prefs = useApp(s => s.prefs)
  const setPrefs = useApp(s => s.setPrefs)
  const [material, setMaterial] = useState(null)
  const iconRef = useRef(null)
  const fileRef = useRef(null)
  useEffect(() => { dynamicColors().then(setMaterial) }, [])
  useEffect(() => { if (focus === 'icon') iconRef.current?.scrollIntoView({ block: 'start' }) }, [focus])
  const choose = patch => { const p = setPrefs(patch); applyTheme(p) }
  const pickIcon = async name => { setPrefs({ icon: name }); await setLauncherIcon(name); useApp.getState().toast(t('Icône changée. Android peut mettre quelques secondes à l’afficher.')) }
  const onFile = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const app = useApp.getState()
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) { app.toast(t('Choisis une image PNG, JPG ou WebP.')); return }
    if (file.size > 2 * 1024 * 1024) { app.toast(t('Image trop lourde : 2 Mo maximum.')); return }
    const data = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(file) })
    const size = await new Promise(resolve => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve([0, 0]); img.src = data })
    if (Math.min(...size) < 512) { app.toast(t('Image trop petite : 512 × 512 px minimum.')); return }
    try {
      const r = await pinShortcut(data, 'Écho')
      app.toast(r.requested ? t('Confirme l’ajout du raccourci sur ton écran d’accueil.') : t('Ton téléphone ne permet pas d’ajouter ce raccourci.'))
    } catch (err) { app.toast(err.message) }
  }
  const preview = id => {
    if (id === 'indigo') return <span className="pv pv-indigo"><i className="b1" /><i className="b2" /><i className="dot" /></span>
    if (id === 'glass') return <span className="pv pv-glass"><i className="blob a" /><i className="blob b" /><i className="pane" /></span>
    if (id === 'luce') return <span className="pv pv-luce"><i className="card" /><i className="lit" /><i className="amber" /></span>
    if (id === 'material') return <span className="pv" style={{ background: material?.available ? material.n800 : '#3b3226' }}><i className="b1" style={{ background: material?.available ? material.n50 : '#f4e7d7' }} /><i className="b2" style={{ background: material?.available ? material.a800 : '#6b5233' }} /><i className="pill" style={{ background: material?.available ? material.a200 : '#e9b77b' }} /></span>
    return <span className="pv" style={{ background: '#1a1838' }}><i className="b1" /><i className="b2" /><i className="dot" style={{ background: prefs.accent }} /></span>
  }
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Thème')}</h1></div>
      <div className="theme-grid" role="radiogroup" aria-label={t('Thème')}>
        {THEMES.map(th => (
          <button key={th.id} type="button" role="radio" aria-checked={prefs.theme === th.id} className="theme-opt" onClick={() => choose({ theme: th.id })}
            disabled={th.id === 'material' && isNative && material && !material.available}>
            {preview(th.id)}
            <span className="nm">{t(th.name)}</span>
            {th.note && <span className="nt">{t(th.id === 'material' && isNative && material && !material.available ? 'Android 12 ou plus' : th.note)}</span>}
          </button>
        ))}
      </div>
      {prefs.theme === 'fixed' && <>
        <div className="mini-h">{t('Couleur fixe')}</div>
        <div className="swatches" role="radiogroup" aria-label={t('Couleur fixe')}>
          {ACCENTS.map(([hex, name]) => <button key={hex} type="button" role="radio" aria-checked={prefs.accent === hex} aria-label={t(name)} style={{ background: hex }} onClick={() => choose({ accent: hex })}>{prefs.accent === hex && <Check size={18} />}</button>)}
          {!ACCENTS.some(([hex]) => hex === prefs.accent) && <button type="button" role="radio" aria-checked="true" aria-label={prefs.accent} style={{ background: prefs.accent }} onClick={() => {}}><Check size={18} /></button>}
          <button type="button" className="swatch-any" aria-label={t('Autre couleur')} onClick={async () => { const hex = await useApp.getState().ask({ kind: 'color', title: t('Couleur fixe'), value: prefs.accent, suggestions: ACCENTS, confirm: t('Choisir') }); if (hex) choose({ accent: hex }) }}><Plus size={18} /></button>
        </div>
      </>}

      <h2 className="sub-h" ref={iconRef}>{t('Icône de l’appli')}</h2>
      <div className="icon-row" role="radiogroup" aria-label={t('Icône de l’appli')}>
        {[['Default', 'icon.png', 'Écho'], ['Luce', 'icon-luce.png', 'Luce'], ['Glass', 'icon-glass.png', 'Liquid glass']].map(([id, file, name]) => (
          <button key={id} type="button" role="radio" aria-checked={(prefs.icon || 'Default') === id} className="icon-opt" onClick={() => pickIcon(id)}>
            <img src={file} alt="" /><span>{name}</span>
          </button>
        ))}
        <button type="button" className="icon-opt" onClick={() => fileRef.current?.click()}>
          <span className="upload"><Upload size={22} /></span><span>{t('Ton image')}</span>
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
      </div>
      <p className="note" style={{ marginTop: 10 }}>{t('Ton image : PNG, JPG ou WebP carré, 512 × 512 px minimum, 2 Mo maximum. Garde l’essentiel au centre : Android coupe les bords selon la forme d’icône du téléphone. Android ne laisse pas une appli remplacer sa propre icône par une image : la tienne arrive comme un raccourci sur l’écran d’accueil, qui ouvre Écho.')}</p>
    </div>
  )
}

// --------------------------------------------------------------- equalizer
/**
 * A song of yours to set the equalizer by ear, and "Sans / Avec" to hear the
 * difference while it plays (only for listening: your setting doesn't change).
 */
function EqTestSong({ eq }) {
  const [song, setSong] = useState(null)
  const [bypass, setBypass] = useState(false)
  const playing = usePlayer(s => s.playing && s.queue[s.index]?.local_id === song?.local_id)
  useEffect(() => {
    let saved = null
    try { saved = JSON.parse(localStorage.getItem('echo-eq-song') || 'null') } catch {}
    if (saved?.local_id) { setSong(saved); return }
    api.tracks({ sort: 'played', limit: 1 }).then(r => { if (r[0]) setSong({ ...r[0], local_id: r[0].id }) }).catch(() => {})
  }, [])
  // Leaving the screen: your setting is back.
  useEffect(() => () => applyEqualizer(useApp.getState().prefs.eq), [])
  useEffect(() => { applyEqualizer(bypass ? { ...eq, enabled: false } : eq) }, [bypass, eq.enabled, eq.preamp, eq.bands.join()])
  const choose = async () => {
    const rows = await api.tracks({ sort: 'played', limit: 40 }).catch(() => [])
    useApp.getState().showSheet({
      title: t('Titre pour tester'),
      subtitle: t('Un titre que tu connais bien, sur ton téléphone'),
      items: rows.map(r => ({ label: `${r.title} · ${r.artist}`, checked: song?.local_id === r.id, onSelect: () => { const s2 = { ...r, local_id: r.id }; setSong(s2); try { localStorage.setItem('echo-eq-song', JSON.stringify({ local_id: r.id, id: r.id, title: r.title, artist: r.artist, has_art: r.has_art, codec: r.codec })) } catch {} } })),
    })
  }
  const toggle = () => (playing ? (engine.pause(), usePlayer.setState({ playing: false })) : playList([song], 0, { context: 'search' }))
  if (!song) return <div className="set-card pad eq-test"><p className="note" style={{ margin: 0 }}>{t('Télécharge un titre pour pouvoir tester l’égaliseur avec ta musique.')}</p></div>
  return (
    <div className="set-card pad eq-test">
      <div className="eq-test-h">{t('Titre pour tester')}</div>
      <div className="eq-test-song">
        <Cover song={song} />
        <span className="text"><span className="title">{song.title}</span><span className="sub">{[song.artist, song.codec ? String(song.codec).toUpperCase() : null].filter(Boolean).join(' · ')}</span></span>
        <button type="button" className="btn quiet small" onClick={choose}>{t('Changer')}</button>
      </div>
      <div className="eq-test-ab">
        <button type="button" className="eq-play" onClick={toggle} aria-label={playing ? t('Pause') : t('Lire')}>{playing ? <Pause size={18} fill="currentColor" strokeWidth={0} /> : <Play size={18} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />}</button>
        <div className="tabs2" role="group" aria-label={t('Comparer')} style={{ marginTop: 0, flex: 1 }}>
          <button type="button" aria-selected={bypass} onClick={() => setBypass(true)}>{t('Sans égaliseur')}</button>
          <button type="button" aria-selected={!bypass} onClick={() => setBypass(false)} disabled={!eq.enabled}>{t('Avec')}</button>
        </div>
      </div>
      <p className="note" style={{ margin: '10px 0 0', fontSize: 12.5 }}>{eq.enabled ? t('Touche « Sans » et « Avec » pendant la lecture pour entendre la différence.') : t('Active l’égaliseur pour comparer.')}</p>
    </div>
  )
}

export function EqualizerScreen() {
  const prefs = useApp(s => s.prefs)
  const setPrefs = useApp(s => s.setPrefs)
  const eq = { ...DEFAULT_PREFS.eq, ...(prefs.eq || {}) }
  const save = patch => { const next = { ...eq, ...patch }; setPrefs({ eq: next }); applyEqualizer(next) }
  const setBand = (i, v) => { const bands = [...eq.bands]; bands[i] = v; save({ bands, preset: 'custom', custom: bands }) }
  const pickPreset = id => save({ preset: id, enabled: true, bands: id === 'custom' ? (eq.custom || eq.bands) : EQ_PRESETS[id].bands })
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}>
        <h1>{t('Égaliseur')}</h1>
        <button type="button" role="switch" aria-checked={!!eq.enabled} aria-label={t('Activer l’égaliseur')} className={`switch ${eq.enabled ? 'on' : ''}`} onClick={() => save({ enabled: !eq.enabled })}><i /></button>
      </div>
      <EqTestSong eq={eq} />
      <div className="segments" role="radiogroup" aria-label={t('Préréglages')} style={{ marginTop: 16 }}>
        {Object.entries(EQ_PRESETS).map(([id, p]) => <button key={id} type="button" aria-pressed={eq.preset === id} onClick={() => pickPreset(id)}>{t(p.name)}</button>)}
      </div>
      <div className={`eq ${eq.enabled ? '' : 'off'}`}>
        <div className="eq-zero" aria-hidden="true" />
        {BANDS.map((hz, i) => (
          <label key={hz} className="eq-band">
            <span className="db">{eq.bands[i] > 0 ? `+${eq.bands[i]}` : eq.bands[i]}</span>
            <input type="range" min="-12" max="12" step="1" value={eq.bands[i]} onChange={e => setBand(i, Number(e.target.value))} aria-label={`${hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}`} disabled={!eq.enabled} />
            <span className="hz">{hz >= 1000 ? `${hz / 1000}k` : hz}</span>
          </label>
        ))}
      </div>
      <p className="note" style={{ textAlign: 'center', margin: '4px auto 0' }}>{t('Hz · +12 dB en haut, −12 dB en bas')}</p>
      <div className="set-card pad" style={{ marginTop: 22 }}>
        <div className="between"><b>{t('Préampli')}</b><span className="muted">{eq.preamp > 0 ? `+${eq.preamp}` : eq.preamp} dB</span></div>
        <p className="note" style={{ margin: '2px 0 10px' }}>{t('Baisse un peu le volume pour éviter la saturation quand tu montes des fréquences.')}</p>
        <input type="range" className="wide-range" min="-12" max="6" step="1" value={eq.preamp} onChange={e => save({ preamp: Number(e.target.value) })} aria-label={t('Préampli')} disabled={!eq.enabled} />
      </div>
      {!isNative && <p className="note">{t('Dans le navigateur, l’égaliseur agit sur la lecture de cette page.')}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- quality
export function QualityScreen() {
  const [settings, setSettings] = useState(null)
  const open = useApp(s => s.open)
  const audioTest = useApp(s => s.prefs.audioTest)
  useEffect(() => { api.settings().then(setSettings).catch(() => {}) }, [])
  const tier = settings?.quality_tier || 'cd'
  const choose = async id => setSettings(await api.saveSettings({ quality_tier: id }))
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Qualité de téléchargement')}</h1></div>
      <div className="q-list" role="radiogroup" aria-label={t('Qualité')}>
        {TIERS.map(q => (
          <button key={q.id} type="button" role="radio" aria-checked={tier === q.id} className="q-opt" onClick={() => choose(q.id)}>
            <span className="radio" /><span className="text"><span className="title">{q.name}</span><span className="sub">{t(q.note)} · {t(q.size)}</span></span>
          </button>
        ))}
      </div>
      <div className="info-line"><Info size={18} /><span>{t('Si un titre n’existe pas dans cette qualité, Écho prend celle juste en dessous, sinon celle juste au-dessus.')}</span></div>
      <h2 className="sub-h">{t('Test audio')}</h2>
      <div className="set-card pad">
        <Spectrum limit={audioTest?.limit} />
        <p style={{ margin: '12px 0 0', lineHeight: 1.45 }}>{audioTest ? t('Ton dernier test : tu entends jusqu’à {k} kHz.', { k: Math.round(audioTest.limit / 100) / 10 }) : t('Avec tes écouteurs, écoute des sons du plus grave au plus aigu et dis jusqu’où tu les entends. Écho te propose ensuite la qualité qui te convient.')}</p>
        <button type="button" className="btn primary wide" style={{ marginTop: 14 }} onClick={() => open({ type: 'audio-test' })}>{audioTest ? t('Refaire le test') : t('Lancer le test · 2 min')}</button>
      </div>
    </div>
  )
}

function Spectrum({ limit }) {
  const bars = [30, 50, 70, 85, 100, 95, 80, 65, 50, 38, 26, 16]
  // Bars stand for 20 Hz … 20 kHz on a log scale.
  const lit = limit ? Math.round(Math.log(limit / 20) / Math.log(1000) * bars.length) : 7
  return (
    <>
      <div className="spectrum" aria-hidden="true">{bars.map((h, i) => <i key={i} style={{ height: `${h}%` }} className={i < lit ? 'on' : ''} />)}</div>
      <div className="between muted" style={{ fontSize: 11.5, marginTop: 6 }}><span>20 Hz</span><span>{limit ? `${Math.round(limit / 100) / 10} kHz` : '1 kHz'}</span><span>20 kHz</span></div>
    </>
  )
}

// -------------------------------------------------------------- audio test
const HIGH = [10000, 12000, 14000, 15000, 16000, 17000, 18000, 19000, 20000]

export function AudioTest() {
  const [step, setStep] = useState(-1) // -1 intro, 0..n tones, n result
  const [limit, setLimit] = useState(null)
  const [output, setOutput] = useState(null)
  const ctx = useRef(null)
  const osc = useRef(null)
  const setPrefs = useApp(s => s.setPrefs)
  const open = useApp(s => s.open)
  const back = useApp(s => s.back)
  useEffect(() => {
    if (isNative) EchoNative.audioOutput?.().then(setOutput).catch(() => {})
    return () => stopTone()
  }, [])
  const stopTone = () => { try { osc.current?.stop() } catch {} osc.current = null }
  const playTone = hz => {
    stopTone()
    if (!ctx.current) ctx.current = new (window.AudioContext || window.webkitAudioContext)()
    const c = ctx.current
    c.resume?.()
    const o = c.createOscillator()
    const g = c.createGain()
    o.frequency.value = hz
    g.gain.setValueAtTime(0, c.currentTime)
    g.gain.linearRampToValueAtTime(0.18, c.currentTime + 0.05)
    o.connect(g).connect(c.destination)
    o.start()
    osc.current = o
  }
  const start = () => {
    if (usePlayer.getState().playing) { engine.pause(); usePlayer.setState({ playing: false }) }
    setStep(0); playTone(HIGH[0])
  }
  const answer = heard => {
    const hz = HIGH[step]
    if (!heard || step === HIGH.length - 1) {
      stopTone()
      const found = heard ? hz : step === 0 ? 8000 : HIGH[step - 1]
      setLimit(found)
      const recommended = found >= 16000 ? 'cd' : 'lossy'
      setPrefs({ audioTest: { limit: found, at: Date.now(), recommended } })
      setStep(HIGH.length)
      return
    }
    setStep(step + 1)
    playTone(HIGH[step + 1])
  }
  if (step >= HIGH.length) return <AudioTestResult limit={limit} output={output} onDone={back} onRetry={() => setStep(-1)} />
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Test audio')}</h1></div>
      {step < 0 ? <>
        <div className="set-card pad">
          <Spectrum />
          <p style={{ margin: '12px 0 0', lineHeight: 1.45 }}>{t('Mets tes écouteurs, le volume à un niveau normal. Écho joue des sons de plus en plus aigus : dis à chaque fois si tu l’entends.')}</p>
        </div>
        <div className="info-line"><Info size={18} /><span>{t('Le test dure environ 2 minutes. La musique en cours se met en pause.')}</span></div>
        <div className="btn-row"><button type="button" className="btn primary wide" onClick={start}>{t('Commencer')}</button></div>
      </> : <>
        <div className="tone-big" aria-live="polite">
          <span className="k">{HIGH[step] / 1000}</span><span className="u">kHz</span>
        </div>
        <div className="steps" aria-hidden="true">{HIGH.map((_, i) => <i key={i} className={i <= step ? 'on' : ''} />)}</div>
        <p className="note" style={{ textAlign: 'center', margin: '18px auto' }}>{t('Tu entends un son aigu ?')}</p>
        <div className="two-btns">
          <button type="button" className="btn primary" onClick={() => answer(true)}>{t('Je l’entends')}</button>
          <button type="button" className="btn quiet" onClick={() => answer(false)}>{t('Je n’entends rien')}</button>
        </div>
      </>}
    </div>
  )
}

/** The result, with a quality to choose (and the space each takes). */
function AudioTestResult({ limit, output, onDone, onRetry }) {
  const recommended = limit >= 16000 ? 'cd' : 'lossy'
  const tier = TIERS.find(x => x.id === recommended)
  const bluetooth = output?.type === 'bluetooth'
  const choose = async () => { await api.saveSettings({ quality_tier: recommended }); useApp.getState().toast(t('Qualité : {q}.', { q: tier.name })); onDone() }
  return (
    <div className="page">
      <Back />
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>{t('Résultat du test audio')}</p>
      <h1 className="result-h">{t('Tu entends jusqu’à {k}\u00a0kHz', { k: Math.round(limit / 100) / 10 })}</h1>
      <div style={{ marginTop: 16 }}><Spectrum limit={limit} /></div>
      <div className="set-card pad" style={{ marginTop: 20 }}>
        <div style={{ fontWeight: 750, fontSize: 18 }}>{recommended === 'cd' ? t('FLAC 16 bits te suffit') : t('Le MP3 te suffit')}</div>
        <p style={{ margin: '6px 0 0', lineHeight: 1.45 }}>{recommended === 'cd'
          ? t('Le FLAC 24 bits / 192 kHz n’ajoute rien que tu puisses entendre avec ces écouteurs, et prend 50 % de place en plus.')
          : t('Au-delà de 16 kHz, le MP3 coupe les aigus que tu n’entends pas. Tu gardes beaucoup de place. Prends le FLAC si tu veux une marge.')}</p>
        {(bluetooth || !isNative) && <div className="info-line" style={{ marginTop: 12 }}><Bluetooth size={18} /><span>{bluetooth ? t('Écouteurs Bluetooth détectés : le son est recompressé pendant la transmission, quelle que soit la qualité du fichier.') : t('En Bluetooth, le son est recompressé pendant la transmission, quelle que soit la qualité du fichier.')}</span></div>}
        {output?.type === 'wired' && <div className="info-line" style={{ marginTop: 12 }}><Headphones size={18} /><span>{t('Écouteurs filaires : tu profites de toute la qualité du fichier.')}</span></div>}
      </div>
      <div className="mini-h">{t('Place pour 1 000 titres')}</div>
      {TIERS.map(q => (
        <div key={q.id} className={`size-row ${q.id === recommended ? 'on' : ''}`}>
          <b>{q.name.split(' · ')[0]}</b><i style={{ width: q.id === 'hires' ? 150 : q.id === 'cd' ? 100 : 16 }} /><span>{q.per1000}</span>
        </div>
      ))}
      <div className="btn-row" style={{ flexDirection: 'column' }}>
        <button type="button" className="btn primary wide" onClick={choose}>{t('Choisir {q}', { q: tier.name.split(' · ')[0] })}</button>
        <button type="button" className="btn ghost wide" onClick={onDone}>{t('Garder mon choix')}</button>
        <button type="button" className="btn ghost wide" onClick={onRetry}>{t('Refaire le test')}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- sources
export function SourcesScreen({ focus, verify }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(null)
  const [settings, setSettings] = useState(null)
  const [drag, setDrag] = useState(null)
  const folderRef = useRef(null)
  const app = useApp()
  const load = () => api.sources().then(setState).catch(() => {})
  useEffect(() => { load(); api.settings().then(setSettings).catch(() => {}) }, [])
  useEffect(() => { if (focus === 'folder') setTimeout(() => folderRef.current?.scrollIntoView({ block: 'start' }), 200) }, [focus])
  useEffect(() => {
    if (!verify || !state) return
    const need = state.sources.find(s => s.installed && s.enabled && !s.ready)
    if (need) run(need.id, () => setUpSource({ install: false, id: need.id }))
  }, [verify, !!state])
  const run = async (id, fn) => {
    setBusy(id)
    try { const r = await fn(); if (r?.sources) setState(r); else await load() } catch (e) { app.toast(e.message) } finally { setBusy(null); app.refreshSource() }
  }
  const list = state?.sources || []
  const ROW = 64
  const startDrag = (e, from) => {
    e.preventDefault()
    const y0 = e.clientY, el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    let to = from
    const move = ev => { const dy = ev.clientY - y0; to = Math.max(0, Math.min(list.length - 1, from + Math.round(dy / ROW))); setDrag({ from, to, dy }) }
    const up = async () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      setDrag(null)
      if (to === from) return
      const ids = list.map(s => s.id)
      const [m] = ids.splice(from, 1); ids.splice(to, 0, m)
      setState(await api.orderSources(ids))
    }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
    setDrag({ from, to: from, dy: 0 })
  }
  const shift = i => !drag ? 0 : i === drag.from ? drag.dy : drag.from < drag.to && i > drag.from && i <= drag.to ? -ROW : drag.from > drag.to && i < drag.from && i >= drag.to ? ROW : 0
  const status = s => {
    if (!s.installed) return t('Pas installée')
    if (!s.enabled) return t('Désactivée')
    if (!s.ready) return t('Vérification à faire')
    const best = (s.quality || []).map(q => `${q.id} ${q.label || ''}`).join(' ')
    return /24|hi-?res|max/i.test(best) ? t('Prête · jusqu’au FLAC 24 bits') : /flac|lossless/i.test(best) ? t('Prête · jusqu’au FLAC 16 bits') : t('Prête')
  }
  const changeFolder = async () => {
    const dir = await pickFolder()
    if (!dir) return
    const s = await api.saveSettings({ download_dir: dir })
    setSettings(s)
    app.toast(t('Les prochains téléchargements iront dans {d}.', { d: dir.replace(/^\/storage\/emulated\/0\//, '') }))
  }
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Sources')}</h1></div>
      <p className="note" style={{ marginTop: -4 }}>{t('Écho essaie les sources actives dans cet ordre. Glisse pour changer l’ordre.')}</p>
      {!state && <div className="empty"><Loader2 className="spin" /></div>}
      <div className="set-card src-list">
        {list.map((s, i) => (
          <div key={s.id} className={`src ${drag?.from === i ? 'dragging' : ''}`} style={{ transform: `translateY(${shift(i)}px)`, transition: drag && drag.from !== i ? 'transform .15s' : 'none' }}>
            <button type="button" className="grip" onPointerDown={e => startDrag(e, i)} aria-label={t('Déplacer {s}', { s: s.name })}><GripVertical size={20} /></button>
            <span className="text"><span className="title">{s.name}</span><span className={`sub ${s.installed && s.enabled && !s.ready ? 'warn' : ''}`}>{status(s)}</span></span>
            {busy === s.id ? <Loader2 size={22} className="spin" /> : !s.installed ? (
              <button type="button" className="btn quiet small" onClick={() => run(s.id, () => setUpSource({ id: s.id }))}>{t('Installer')}</button>
            ) : <>
              {s.enabled && !s.ready && <button type="button" className="btn quiet small" onClick={() => run(s.id, () => setUpSource({ install: false, id: s.id }))}><ShieldCheck size={16} />{t('Vérifier')}</button>}
              <button type="button" role="switch" aria-checked={s.enabled} aria-label={s.name} className={`switch ${s.enabled ? 'on' : ''}`} onClick={() => run(s.id, () => api.enableSource(s.id, !s.enabled))}><i /></button>
            </>}
          </div>
        ))}
        {state && <div className="src static"><span className="grip" /><span className="text"><span className="title">Spotify</span><span className="sub">{t('Pas de téléchargement depuis Spotify : sert à importer tes playlists.')}</span></span></div>}
      </div>

      <h2 className="sub-h" ref={folderRef}>{t('Dossier des téléchargements')}</h2>
      <div className="set-card pad folder-card">
        <span className="text"><span className="title">{String(settings?.download_dir_used || '…').replace(/^\/storage\/emulated\/0\//, '')}</span><span className="sub">{t('Rangé par Artiste › Album')}</span></span>
        <button type="button" className="btn quiet small" onClick={changeFolder}>{t('Changer')}</button>
      </div>
      {settings?.download_dir && <button type="button" className="link-btn" onClick={async () => setSettings(await api.saveSettings({ download_dir: null }))}>{t('Revenir à Musique/Écho')}</button>}
      <p className="note" style={{ marginTop: 10 }}>{t('Si Android refuse d’écrire dans ce dossier, Écho range le titre dans Musique/Écho et te le dit.')}</p>
    </div>
  )
}

// --------------------------------------------------------- music folders
export function FoldersScreen() {
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
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Dossiers de musique')}</h1></div>
      <p className="note" style={{ marginTop: -4 }}>{t('Écho lit les fichiers audio de ces dossiers.')}</p>
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
  )
}

// ------------------------------------------------------------- start page
export function StartScreen() {
  const prefs = useApp(s => s.prefs)
  const setPrefs = useApp(s => s.setPrefs)
  const sections = { ...DEFAULT_PREFS.sections, ...(prefs.sections || {}) }
  const toggleSection = key => setPrefs({ sections: { ...sections, [key]: !sections[key] } })
  return (
    <div className="page">
      <Back />
      <div className="page-head" style={{ paddingTop: 0 }}><h1>{t('Page de démarrage')}</h1></div>
      <p className="note" style={{ marginTop: -4 }}>{t('Écho s’ouvre sur :')}</p>
      <div className="start-grid" role="radiogroup" aria-label={t('Page de démarrage')}>
        {[['home', 'Pour toi'], ['search', 'Rechercher'], ['playlists', 'Playlists'], ['library', 'Bibliothèque']].map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={(prefs.startTab || 'home') === id} onClick={() => setPrefs({ startTab: id })}>{t(label)}</button>
        ))}
      </div>
      <h2 className="sub-h">{t('Dans « Pour toi »')}</h2>
      <p className="note" style={{ marginTop: -6 }}>{t('Choisis les catégories à afficher.')}</p>
      <div className="set-card">
        {[['follows', 'Du nouveau chez tes artistes'], ['daily', 'Mixes du jour'], ['discover', 'Découvertes'], ['rediscover', 'À redécouvrir'], ['custom', 'Ton mix'], ['chart', 'Populaire en ce moment']].map(([key, label]) => (
          <div key={key} className="toggle-line">
            <span>{t(label)}</span>
            <button type="button" role="switch" aria-checked={sections[key]} aria-label={t(label)} className={`switch ${sections[key] ? 'on' : ''}`} onClick={() => toggleSection(key)}><i /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- update
export function UpdateScreen() {
  const update = useApp(s => s.update)
  const appBuild = useApp(s => s.appBuild)
  const [job, setJob] = useState(null)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try { useApp.setState({ update: await api.update(appBuild, true) }) } catch (e) { useApp.getState().toast(t('Vérification impossible : {e}', { e: e.message })) } finally { setChecking(false) }
  }
  useEffect(() => { if (!update) check() }, [])
  useEffect(() => {
    if (job?.state !== 'downloading') return undefined
    const timer = setInterval(async () => { const s = await api.updateStatus().catch(() => null); if (s) setJob(s) }, 600)
    return () => clearInterval(timer)
  }, [job?.state])
  const start = async () => {
    const info = await appInfo()
    setJob(await api.downloadUpdate(info.abi, appBuild))
  }
  const install = async () => {
    const r = await installApk(job.file)
    if (r?.needsPermission) useApp.getState().toast(t('Autorise Écho à installer des applis, puis touche Installer à nouveau.'))
  }
  // The notes as sections ("Améliorations", "Corrections"…), from the server.
  const sections = (update?.changes || []).filter(x => x.items?.length && !/github/i.test(x.title || ''))
  const size = update?.available && update.assets ? Math.round((Object.values(update.assets)[0]?.size || 0) / 1e6) : 0
  return (
    <div className="page update-page">
      <Back />
      <div className="update-head">
        <img src="icon.png" alt="" />
        <div>
          <h1>{update?.available ? t('Écho {v} est prête', { v: update.version }) : t('Écho est à jour')}</h1>
          <p className="muted">{t('Tu as la {v}', { v: version })}{size ? ` · ${size} Mo` : ''}</p>
        </div>
      </div>
      {update?.available && sections.length > 0 && (
        <div className="changes">
          {sections.map((sec, i) => (
            <section key={i}>
              {sec.title && <h2 className="changes-h">{sec.title}</h2>}
              <ul className="notes">{sec.items.slice(0, 20).map((n, k) => <li key={k}>{n}</li>)}</ul>
            </section>
          ))}
        </div>
      )}
      <div className="update-actions">
        {job?.state === 'downloading' && <>
          <div className="between muted" style={{ fontSize: 13.5 }}><span>{t('Téléchargement…')}</span><span>{job.progress} %</span></div>
          <div className="bar-track"><i style={{ width: `${job.progress}%` }} /></div>
        </>}
        {job?.state === 'error' && <p className="note err">{job.error}</p>}
        {update?.available && <p className="note" style={{ marginTop: 10 }}>{t('Android te demandera de confirmer l’installation. Ta bibliothèque et tes playlists sont gardées.')}</p>}
        <div className="btn-row" style={{ marginTop: 12 }}>
          {update?.available && job?.state !== 'ready' && <button type="button" className="btn primary wide" disabled={job?.state === 'downloading'} onClick={start}><ArrowUpCircle size={18} />{t('Télécharger la mise à jour')}</button>}
          {job?.state === 'ready' && <button type="button" className="btn primary wide" onClick={install}>{t('Installer')}</button>}
          <button type="button" className="btn quiet wide" disabled={checking} onClick={check}>{checking ? <Loader2 size={18} className="spin" /> : <RotateCcw size={18} />}{t('Vérifier maintenant')}</button>
        </div>
      </div>
    </div>
  )
}
