/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the callouts and status badges (design-system.md "Callouts and status badges
// (P2b, done)"): every `Callout` tone, every `StatusBadge` variant, the new-item dot and 閲覧のみ,
// each with a `data-` name the status-colours spec reads. `?theme=dark` for dark mode.
import { createRoot } from 'react-dom/client'
import { Circle } from '@phosphor-icons/react'
import '../src/index.css'
import { Callout, NewDot, StatusBadge, type CalloutTone, type StatusBadgeVariant } from '../src/shared/ui/primitives'
import { ReadOnlyBadge } from '../src/shared/ui/ReadOnlyBadge'

if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark')

const TONES: CalloutTone[] = ['info', 'warning', 'danger', 'success', 'offline', 'paused', 'failed', 'awaiting']
const VARIANTS: StatusBadgeVariant[] = ['neutral', 'info', 'success', 'warning', 'danger', 'paused', 'failed', 'awaiting', 'ai', 'selected', 'readonly']
const HAS_ICON: StatusBadgeVariant[] = ['paused', 'failed', 'awaiting', 'readonly', 'ai']
const WORDS: Partial<Record<StatusBadgeVariant, string>> = { paused: '止めています', failed: '止まりました', awaiting: '承認を待っています', readonly: '閲覧のみ' }

function Page() {
  return (
    <main className="min-h-screen space-y-4 bg-bg p-6 text-text">
      <section aria-label="囲み" className="space-y-2">
        {TONES.map(t => <Callout key={t} tone={t} role="status" title={`囲み ${t}`}>本文 {t}</Callout>)}
      </section>
      <section aria-label="札" className="flex flex-wrap gap-2">
        {/* Variants without an icon of their own get one here, so the spec can read every icon colour. */}
        {VARIANTS.map(v => <StatusBadge key={v} variant={v} {...(HAS_ICON.includes(v) ? {} : { icon: Circle })}>{WORDS[v] ?? v}</StatusBadge>)}
        <ReadOnlyBadge />
      </section>
      <section aria-label="新着" className="flex items-center gap-2"><span>新しい返事</span><NewDot /></section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
