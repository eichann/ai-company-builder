import { useEffect, useState } from 'react'
import { Gauge } from '@phosphor-icons/react'
import { meterView, type MeterLevel, type MeterWindowView, type RateLimitProvider } from '../../../../shared/rate-limits'
import { useRateLimits } from '../agentStatusStore'
import { agentShortLabel } from '../../../../shared/agents/registry'

// The chat header's plan usage meter (shared/rate-limits.ts has the mapping).
// Full: every window as label + bar + %; compact: the fullest window only.
// Details (reset times, warnings) in a popover on hover / keyboard focus.

const BAR: Record<MeterLevel, string> = {
  unknown: 'bg-gray-300 dark:bg-zinc-600',
  ok: 'bg-accent',
  warn: 'bg-amber-500 dark:bg-amber-400',
  critical: 'bg-red-500 dark:bg-red-400',
}
const TEXT: Record<MeterLevel, string> = {
  unknown: 'text-gray-400 dark:text-zinc-500',
  ok: 'text-gray-600 dark:text-zinc-300',
  warn: 'text-amber-600 dark:text-amber-400',
  critical: 'text-red-600 dark:text-red-400',
}
const FRAME: Record<MeterLevel, string> = {
  unknown: 'border-gray-200 dark:border-zinc-700',
  ok: 'border-gray-200 dark:border-zinc-700',
  warn: 'border-amber-400/60 bg-amber-500/5',
  critical: 'border-red-400/60 bg-red-500/10',
}

function Bar({ window, className }: { window: MeterWindowView; className: string }) {
  return (
    <span className={`relative inline-block h-1.5 rounded-full bg-gray-200 dark:bg-zinc-700 overflow-hidden ${className}`}>
      <span className={`absolute inset-y-0 left-0 rounded-full ${BAR[window.level]}`} style={{ width: `${window.percent ?? 0}%` }} />
    </span>
  )
}

function percentText(percent: number | null) {
  return percent === null ? '—' : `${Math.round(percent)}%`
}

/** Re-render once a minute so countdowns and expired windows stay current. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function RateLimitMeter({ provider, compact = false }: { provider: RateLimitProvider; compact?: boolean }) {
  const snapshot = useRateLimits(provider)
  const now = useMinuteClock()
  const view = meterView(snapshot, provider, now)
  const name = agentShortLabel(provider)
  const fullest = view.windows.reduce<MeterWindowView | undefined>((top, w) => !top || (w.percent ?? -1) > (top.percent ?? -1) ? w : top, undefined)
  const shown = compact ? (fullest ? [fullest] : []) : view.windows
  const summary = view.windows.length > 0
    ? `利用上限: ${view.windows.map(w => `${w.label} ${percentText(w.percent)}`).join('、')}`
    : '利用上限: 情報なし'

  return (
    <div className="relative group flex-shrink-0">
      <button
        type="button"
        aria-label={summary}
        className={`h-6 inline-flex items-center gap-2 px-2 rounded-md border text-[10px] tabular-nums transition-colors hover:border-accent/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${FRAME[view.level]}`}
      >
        {shown.length === 0 ? (
          <span className={`inline-flex items-center gap-1 ${TEXT.unknown}`}>
            <Gauge size={12} />
            <span>—</span>
          </span>
        ) : shown.map(w => (
          <span key={w.id} className="inline-flex items-center gap-1">
            {!compact && <span className="text-gray-400 dark:text-zinc-500">{w.label}</span>}
            <Bar window={w} className={compact ? 'w-6' : 'w-8'} />
            <span className={`font-medium ${TEXT[w.level]}`}>{percentText(w.percent)}</span>
          </span>
        ))}
      </button>

      <div
        role="tooltip"
        className="invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition-opacity absolute left-0 top-full mt-1.5 z-50 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg p-3 text-xs text-gray-700 dark:text-zinc-200"
      >
        <div className="font-medium mb-2">{name}の利用上限</div>
        {view.windows.length > 0 && (
          <ul className="space-y-2.5">
            {view.windows.map(w => (
              <li key={w.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span>{w.label}の枠</span>
                  <span className={`font-medium tabular-nums ${TEXT[w.level]}`}>{w.percent === null ? '使用率不明' : `${percentText(w.percent)} 使用`}</span>
                </div>
                <Bar window={w} className="w-full mt-1" />
                {w.resetText && <div className="mt-1 text-[11px] text-gray-500 dark:text-zinc-400">{w.resetText}</div>}
              </li>
            ))}
          </ul>
        )}
        {view.note && <p className={`${view.windows.length > 0 ? 'mt-2.5' : ''} text-[11px] leading-relaxed ${view.level === 'warn' || view.level === 'critical' ? TEXT[view.level] : 'text-gray-500 dark:text-zinc-400'}`}>{view.note}</p>}
        {snapshot && (
          <p className="mt-2.5 text-[10px] text-gray-400 dark:text-zinc-500">
            {new Date(snapshot.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 時点（AIの応答ごとに更新）
          </p>
        )}
      </div>
    </div>
  )
}
