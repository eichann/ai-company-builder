// Pieces every screen of the company selector shares.
import type { ReactNode } from 'react'
import { ArrowRight, type Icon } from '@phosphor-icons/react'

export const BACK_BUTTON = 'flex-1 flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors'
export const PRIMARY_BUTTON = 'flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors'

export function ScreenHeading({ icon: IconComponent, title, children }: { icon: Icon; title: ReactNode; children: ReactNode }) {
  return (
    <div className="text-center">
      <IconComponent size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
      <h1 className="text-2xl font-bold text-text-primary mb-2">{title}</h1>
      <p className="text-text-secondary">{children}</p>
    </div>
  )
}

export function ErrorNotice({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
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
      className={`w-full flex items-center${arrow ? ' justify-between' : ''} p-4 rounded-lg border ${dashed ? 'border-dashed ' : ''}border-border hover:border-accent/50 transition-colors text-left`}
    >
      <div className={`flex items-center ${arrow ? 'gap-3' : 'gap-4'}`}>
        <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">{icon}</div>
        <div>
          <div className="font-medium text-text-primary">{title}</div>
          <div className="text-sm text-text-secondary">{detail}</div>
        </div>
      </div>
      {arrow && <ArrowRight size={20} className="text-text-secondary" />}
    </button>
  )
}
