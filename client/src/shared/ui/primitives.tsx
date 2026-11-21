// Small building blocks for the settings pages, in the visual language of the
// admin console (neutral zinc greys, the primary blue for the main action, status
// colours only for state, light and dark). Tailwind + Phosphor, like the rest of the
// renderer.
import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { Check, CheckCircle, Hourglass, Info, Lock, Minus, Pause, PauseCircle, Sparkle, WarningCircle, WarningOctagon, WifiSlash, type Icon } from '@phosphor-icons/react'
import { PRIMARY_ACTION } from './buttonStyles'

export function SectionHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-zinc-900 dark:shadow-none ${className}`}>
      {children}
    </div>
  )
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{children}</h3>
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON: Record<ButtonVariant, string> = {
  primary: PRIMARY_ACTION,
  secondary: 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-white/[0.06]',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100',
  danger: 'bg-danger text-on-danger hover:bg-danger-hover active:bg-danger-active',
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }>(function Button({ variant = 'secondary', size = 'md', className = '', ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring focus-visible:ring-offset-focus focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-disabled ${size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3.5 text-[13px]'} ${BUTTON[variant]} ${className}`}
    />
  )
})

// Callouts (design-system.md "Callouts and status badges (P2b, done)"): one box per meaning, drawn
// only from its token set (text, bg, border, icon) — no free opacities, no palette colours. The
// three stopped states are separate (owner decision 2026-11-21): `paused` stopped by a person
// (grey, 「止めています」 + who / when), `failed` stopped by a failure (red, 「止まりました」 + reason
// and fix), `awaiting` awaiting approval (amber). Amber is warning and awaiting only; `offline` is
// information (grey) with its own icon.
export type CalloutTone = 'info' | 'warning' | 'danger' | 'success' | 'offline' | 'paused' | 'failed' | 'awaiting'

const CALLOUT: Record<CalloutTone, { box: string; icon: ReactNode }> = {
  info: { box: 'border-info-border bg-info-bg text-info-text', icon: <Info size={16} className="text-info-icon" /> },
  warning: { box: 'border-warning-border bg-warning-bg text-warning-text', icon: <WarningCircle size={16} weight="fill" className="text-warning-icon" /> },
  danger: { box: 'border-danger-border bg-danger-bg text-danger-text', icon: <WarningCircle size={16} weight="fill" className="text-danger-icon" /> },
  success: { box: 'border-success-border bg-success-bg text-success-text', icon: <CheckCircle size={16} weight="fill" className="text-success-icon" /> },
  offline: { box: 'border-info-border bg-info-bg text-info-text', icon: <WifiSlash size={16} className="text-info-icon" /> },
  paused: { box: 'border-paused-border bg-paused-bg text-paused-text', icon: <PauseCircle size={16} weight="fill" className="text-paused-icon" /> },
  failed: { box: 'border-failed-border bg-failed-bg text-failed-text', icon: <WarningOctagon size={16} weight="fill" className="text-failed-icon" /> },
  awaiting: { box: 'border-awaiting-border bg-awaiting-bg text-awaiting-text', icon: <Hourglass size={16} weight="fill" className="text-awaiting-icon" /> },
}

export function Callout({ tone = 'info', title, children, action, role, className = '' }: { tone?: CalloutTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; role?: 'alert' | 'status'; className?: string }) {
  const s = CALLOUT[tone]
  return (
    <div role={role ?? (tone === 'danger' || tone === 'failed' ? 'alert' : undefined)} data-callout={tone} className={`flex items-start gap-2.5 rounded-control border p-callout text-body ${s.box} ${className}`}>
      <span className="mt-0.5 shrink-0" aria-hidden>{s.icon}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-strong">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// Status badges: a small mark that cannot be pressed (a chip that can be pressed is a button).
// Corner `small` (4px); the set's bg / border / text and its icon colour.
export type StatusBadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'paused' | 'failed' | 'awaiting' | 'ai' | 'selected' | 'readonly'

const BADGE: Record<StatusBadgeVariant, { box: string; icon: string }> = {
  neutral: { box: 'border-transparent bg-surface-sunken text-text-muted', icon: 'text-text-muted' },
  info: { box: 'border-info-border bg-info-bg text-info-text', icon: 'text-info-icon' },
  success: { box: 'border-success-border bg-success-bg text-success-text', icon: 'text-success-icon' },
  warning: { box: 'border-warning-border bg-warning-bg text-warning-text', icon: 'text-warning-icon' },
  danger: { box: 'border-danger-border bg-danger-bg text-danger-text', icon: 'text-danger-icon' },
  paused: { box: 'border-paused-border bg-paused-bg text-paused-text', icon: 'text-paused-icon' },
  failed: { box: 'border-failed-border bg-failed-bg text-failed-text', icon: 'text-failed-icon' },
  awaiting: { box: 'border-awaiting-border bg-awaiting-bg text-awaiting-text', icon: 'text-awaiting-icon' },
  ai: { box: 'border-ai-border bg-ai-bg text-ai-text', icon: 'text-ai-icon' },
  selected: { box: 'border-selected-border bg-selected-bg text-selected-text', icon: 'text-selected-icon' },
  readonly: { box: 'border-readonly-border bg-readonly-bg text-readonly-text', icon: 'text-readonly-icon' },
}

/** Default icons: the three stopped states differ in more than colour; 閲覧のみ keeps its padlock. */
const BADGE_ICON: Partial<Record<StatusBadgeVariant, Icon>> = {
  paused: Pause, failed: WarningOctagon, awaiting: Hourglass, readonly: Lock, ai: Sparkle,
}

export function StatusBadge({ variant = 'neutral', icon, children, title, compact = false, className = '' }: {
  variant?: StatusBadgeVariant
  /** Another icon, or null for none. */
  icon?: Icon | null
  children: ReactNode
  title?: string
  /** Inside a dense row (the file tree): no fixed height, narrower padding. */
  compact?: boolean
  className?: string
}) {
  const s = BADGE[variant]
  const Glyph = icon === undefined ? BADGE_ICON[variant] : icon
  return (
    <span data-badge={variant} title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-small border text-caption ${compact ? 'px-1' : 'h-[var(--size-badge)] px-badge-x'} ${s.box} ${className}`}>
      {Glyph && <Glyph size={compact ? 9 : 11} weight="bold" aria-hidden className={s.icon} />}
      {children}
    </span>
  )
}

/** The one new-item mark (owner decision 2026-11-21): a primary dot; its word is the image's name for screen readers. */
export function NewDot({ label = '新着', className = '', testId }: { label?: string; className?: string; testId?: string }) {
  return (
    <span data-new-dot data-testid={testId} role="img" aria-label={label} title={label} className={`inline-block size-[var(--size-dot)] shrink-0 rounded-full bg-unread ${className}`} />
  )
}

/** An on / off switch (the settings' toggles). */
export function Switch({ on, onToggle, label, describedBy }: { on: boolean; onToggle: () => void; label: string; describedBy?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={onToggle}
      className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900 ${on ? 'bg-indigo-600 dark:bg-indigo-500' : 'bg-zinc-300 dark:bg-white/20'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

/** Tri-state checkbox ('mixed' = something inside is left out). */
export function TriCheckbox({ state, disabled, onToggle, label, describedBy }: {
  state: 'checked' | 'unchecked' | 'mixed'
  disabled?: boolean
  onToggle: () => void
  label: string
  describedBy?: string
}) {
  const on = state !== 'unchecked'
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'checked'}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      tabIndex={-1}
      data-checkbox
      onClick={e => { e.stopPropagation(); onToggle() }}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
        on && !disabled
          ? 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500'
          : disabled
            ? 'border-zinc-200 bg-zinc-100 dark:border-white/10 dark:bg-white/[0.04]'
            : 'border-zinc-300 bg-white hover:border-zinc-400 dark:border-white/20 dark:bg-transparent dark:hover:border-white/40'
      }`}
    >
      {state === 'checked' && !disabled && <Check size={11} weight="bold" />}
      {state === 'mixed' && !disabled && <Minus size={11} weight="bold" />}
    </button>
  )
}

/** A thin bar: `value` of `max`, with an optional `pending` delta drawn lighter. */
export function UsageBar({ value, max, pendingFrom }: { value: number | null; max: number | null; pendingFrom?: number | null }) {
  const pct = (n: number | null | undefined) => (n === null || n === undefined || !max ? 0 : Math.min(100, Math.max(0, (n / max) * 100)))
  const now = pct(pendingFrom ?? value)
  const next = pct(value)
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-white/[0.06]" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-full bg-indigo-500 transition-[width] duration-300 dark:bg-indigo-400" style={{ width: `${Math.min(now, next)}%` }} />
      {pendingFrom !== undefined && pendingFrom !== null && next !== now && (
        <div
          className={`absolute inset-y-0 transition-[width,left] duration-300 ${next > now ? 'bg-indigo-300 dark:bg-indigo-400/50' : 'bg-zinc-300 dark:bg-white/20'}`}
          style={{ left: `${Math.min(now, next)}%`, width: `${Math.abs(next - now)}%` }}
        />
      )}
    </div>
  )
}

export function IndeterminateBar() {
  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-white/[0.06]" aria-hidden>
      <div className="absolute inset-y-0 w-1/3 animate-[acb-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-indigo-500 dark:bg-indigo-400" />
    </div>
  )
}
