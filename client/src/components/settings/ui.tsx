// Small building blocks for the settings pages, in the visual language of the
// admin console (neutral zinc greys, one indigo accent, status colours only
// for state, light and dark). Tailwind + Phosphor, like the rest of the
// renderer.
import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { Check, Minus, Info, WarningCircle, WifiSlash } from '@phosphor-icons/react'

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
  primary: 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
  secondary: 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-white/[0.06]',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100',
  danger: 'bg-amber-600 text-white hover:bg-amber-500 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400',
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }>(function Button({ variant = 'secondary', size = 'md', className = '', ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-50 dark:focus-visible:ring-offset-zinc-900 ${size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3.5 text-[13px]'} ${BUTTON[variant]} ${className}`}
    />
  )
})

type CalloutTone = 'info' | 'warning' | 'error' | 'offline'

const CALLOUT: Record<CalloutTone, { box: string; icon: ReactNode }> = {
  info: { box: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-zinc-300', icon: <Info size={16} className="text-zinc-400" /> },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-200', icon: <WarningCircle size={16} weight="fill" className="text-amber-500" /> },
  error: { box: 'border-red-200 bg-red-50 text-red-800 dark:border-red-400/20 dark:bg-red-400/[0.07] dark:text-red-200', icon: <WarningCircle size={16} weight="fill" className="text-red-500" /> },
  offline: { box: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-zinc-300', icon: <WifiSlash size={16} className="text-zinc-500" /> },
}

export function Callout({ tone = 'info', title, children, action, role }: { tone?: CalloutTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; role?: 'alert' | 'status' }) {
  const s = CALLOUT[tone]
  return (
    <div role={role ?? (tone === 'error' ? 'alert' : undefined)} className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed ${s.box}`}>
      <span className="mt-0.5 shrink-0">{s.icon}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
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
