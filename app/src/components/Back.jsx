import React from 'react'
import { ChevronLeft } from 'lucide-react'
import { useApp } from '../store'
import { t } from '../i18n'

/** Back to the previous screen (the phone's back button does the same). */
export default function Back({ children = null }) {
  const back = useApp(s => s.back)
  return (
    <div className="back-row">
      <button type="button" className="icon-btn" style={{ color: 'var(--text)' }} onClick={back} aria-label={t('Retour')}><ChevronLeft size={28} /></button>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  )
}
