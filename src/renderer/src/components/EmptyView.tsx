import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { useAppStore } from '../store'

/** 空态(设计稿 view-empty) */
export default function EmptyView(): ReactNode {
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const t = useAppStore((state) => state.t)
  return (
    <section data-od-id="view-empty" data-testid="view-empty">
      <div className="empty">
        <span className="glyph">
          <Icon name="hub" size={76} />
        </span>
        <h2>{t('empty.title')}</h2>
        <p>{t('empty.body')}</p>
        <button
          className="btn btn-primary"
          style={{ marginTop: 4 }}
          onClick={() => setWizardOpen(true)}
          data-testid="empty-new-btn"
        >
          {t('empty.newFirst')}
        </button>
        <p className="meta">{t('empty.shortcut')}</p>
      </div>
    </section>
  )
}
