import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { applyTheme } from './theme'

// The start screen in your theme: the last one chosen, kept on the phone.
try { const saved = JSON.parse(localStorage.getItem('echo-theme') || 'null'); if (saved) applyTheme(saved) } catch {}

createRoot(document.getElementById('root')).render(<App />)
