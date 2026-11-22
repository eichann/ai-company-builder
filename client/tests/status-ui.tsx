/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the callouts and status badges (design-system.md "Callouts and status badges
// (P2b, done)"): every `Callout` tone, every `StatusBadge` variant, the new-item dot and 閲覧のみ,
// each with a `data-` name the status-colours spec reads. `?theme=dark` for dark mode. Below them,
// real parts in a stopped state the member has to act on (「止まっている」の色: amber): a task row the
// AI cannot start (`not-allowed`) beside one whose AI failed (red), and the title bar while
// automatic sync waits for the member.
import { createRoot } from 'react-dom/client'
import { Circle } from '@phosphor-icons/react'
import '../src/i18n'
import '../src/index.css'
import { TitleBar } from '../src/app/TitleBar'
import { TaskRow } from '../src/features/tasks/components/TaskRow'
import { companyNow } from '../src/features/tasks/model'
import type { TaskListItem } from '../shared/tasks'
import { Callout, NewDot, StatusBadge, type CalloutTone, type StatusBadgeVariant } from '../src/shared/ui/primitives'
import { ReadOnlyBadge } from '../src/shared/ui/ReadOnlyBadge'

if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark')

const TONES: CalloutTone[] = ['info', 'warning', 'danger', 'success', 'offline', 'paused', 'failed', 'awaiting']
const VARIANTS: StatusBadgeVariant[] = ['neutral', 'info', 'success', 'warning', 'danger', 'paused', 'failed', 'awaiting', 'ai', 'selected', 'readonly']
const HAS_ICON: StatusBadgeVariant[] = ['paused', 'failed', 'awaiting', 'readonly', 'ai']
const WORDS: Partial<Record<StatusBadgeVariant, string>> = { paused: '止めています', failed: '止まりました', awaiting: '承認を待っています', readonly: '閲覧のみ' }

const now = companyNow(Date.now())
const row = (id: string, title: string): TaskListItem => ({
  id, title, type: 'task', typeLabel: 'タスク', version: 1, tags: [], waitingFor: null, personal: false, own: false, actingFor: null,
  bundle: null, finishedAt: null, stateLabel: null, state: 'todo', due: null, turn: 'ai',
})
const noop = () => {}

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
      <section aria-label="AI の番" className="w-80">
        <TaskRow item={row('task-notallow', '見積を送る')} now={now} active={false} busy={false} onOpen={noop} onFinish={null} onAccept={null} onRetry={null} onHand={null} onDrop={null}
          ai={{ recordId: 'task-notallow', state: 'not-allowed', reason: '会社の設定で、AI の番は自動では進めません。', canRetry: false, canHand: true }} />
        <TaskRow item={row('task-failed01', '議事録を読む')} now={now} active={false} busy={false} onOpen={noop} onFinish={null} onAccept={null} onRetry={null} onHand={null} onDrop={null}
          ai={{ recordId: 'task-failed01', state: 'failed', reason: 'つながりませんでした', canRetry: true, canHand: true }} />
      </section>
      <section aria-label="タイトルバー">
        <TitleBar companyName="プレビュー会社" isLoadingPreview={false} isSyncing={false} syncWaitsForYou
          syncTitle={'サーバーと同期\n自動同期は止まっています（このボタンで同期すると再開します）'}
          onPreview={noop} onSync={noop} onShowBackups={noop} onShowSettings={noop} onLogout={noop} />
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
