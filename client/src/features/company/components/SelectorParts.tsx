// Pieces every screen of the company selector shares.
import type { ReactNode } from 'react'
import { ArrowRight, type Icon } from '@phosphor-icons/react'

export const BACK_BUTTON = 'flex-1 flex items-center justify-center gap-2 bg-bg hover:bg-surface-sunken text-text rounded-control px-4 py-3 transition-colors'
export const PRIMARY_BUTTON = 'flex-1 flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover disabled:opacity-disabled disabled:cursor-not-allowed text-on-primary rounded-control px-4 py-3 transition-colors'

export function ScreenHeading({ icon: IconComponent, title, children }: { icon: Icon; title: ReactNode; children: ReactNode }) {
  return (
    <div className="text-center">
      <IconComponent size={64} className="mx-auto mb-4 text-primary" weight="duotone" />
      <h1 className="text-2xl font-bold text-text mb-2">{title}</h1>
      <p className="text-text-muted">{children}</p>
    </div>
  )
}

export function ErrorNotice({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <div className="p-3 rounded-control bg-danger-bg border border-danger-border text-danger-text text-sm">
      {error}
    </div>
  )
}

/** A row-sized choice: icon, title and explanation, an arrow on the right. */
export function ChoiceButton({ icon, title, detail, onClick, disabled, dashed, arrow = true }: {
  icon: ReactNode
  title: ReactNode
  detail: ReactNode
  onClick: () => void
  disabled?: boolean
  dashed?: boolean
  arrow?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center${arrow ? ' justify-between' : ''} p-4 rounded-control border ${dashed ? 'border-dashed ' : ''}border-[color:var(--color-border)] hover:border-selected-border transition-colors text-left`}
    >
      <div className={`flex items-center ${arrow ? 'gap-3' : 'gap-4'}`}>
        <div className="w-10 h-10 rounded-control bg-selected-bg flex items-center justify-center">{icon}</div>
        <div>
          <div className="font-medium text-text">{title}</div>
          <div className="text-sm text-text-muted">{detail}</div>
        </div>
      </div>
      {arrow && <ArrowRight size={20} className="text-text-muted" />}
    </button>
  )
}
