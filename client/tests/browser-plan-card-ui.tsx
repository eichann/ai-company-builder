/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for 「ブラウザ操作」's approval card (client/src/features/browser-plans): a reply holding a
// `data-browser-plan` reference; the card reads the plan through the fake preload API.
// `?state=draft` (default) | `unknown` (confirmable) | `unknown-early` | `succeeded` | `failed` | `cancelled`;
// `?ready=ok` (default) | `no-window` | `not-logged-in` | `off`; `?audience=<n>` (default: unread);
// `?shared=1` the shared-reminder note; `?hint=1` this PC stopped before sending; `?theme=dark`.
// What ［任せる］ / ［やめる］ / a confirm sent is shown in `#sent` for the spec.
// `?manual=1`: the user manual's story (client/tests/manual/scenes.ts, chapter 32): a made-up 配信ツール at
// haishin.example.net and 検証A社's seminar reminder (no real site or service is named). Fictional data only.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { BROWSER_PLAN_PART_TYPE, type BrowserPlanCardData, type BrowserPlanCardRef, type BrowserPlanNotReady } from '../shared/browser-plans'
import type { BrowserFact } from '../../shared/core/browser-plans'
import type { BrowserExecutionView, BrowserPlanView } from '../../shared/types/browser-plans'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const PLAN = `bp_${'5e'.repeat(16)}`
const HASH = `sha256:${'7a'.repeat(32)}`
const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const fact = (value: unknown): BrowserFact => ({ status: 'known', value, readAt: iso(now - 60_000), source: '/line/episode/show/7001001' })
const audience = params.get('audience')
const MANUAL = params.get('manual') === '1'

const facts: Record<string, BrowserFact> = MANUAL ? {
  account: fact({ id: '検証A社 公式' }),
  step_parent: fact({ reminder: '8001001' }),
  names: fact({ reminder: '12月 説明会のリマインダ', step: '前日' }),
  state: fact({ templates: ['8003001'] }),
  templates: fact({
    8003001: { name: '前日のご案内', kind: 'text', body: '明日は説明会です。\n開始の10分前までにお入りください。' },
    8003002: { name: '持ち物のご案内', kind: 'text', body: '当日は筆記用具をお持ちください。' },
  }),
  schedule: fact({ timing: '1日前 19:00' }),
  shared_with: fact({ count: 2, items: ['12/3回', '12/10回'] }),
  audience: audience === null ? { status: 'unknown', readAt: iso(now - 60_000), source: '/line/episode/show/7001001' } : fact({ count: Number(audience) }),
} : {
  account: fact({ id: '5550001' }),
  step_parent: fact({ reminder: '7001001' }),
  names: fact({ reminder: '見本セミナーのリマインダ', step: '前日' }),
  state: fact({ templates: ['7003001'] }),
  templates: fact({
    7003001: { name: '前日のご案内', kind: 'text', body: '明日はいよいよ見本セミナーです。\n開始の10分前にお集まりください。' },
    7003002: { name: '持ち物のお知らせ', kind: 'text', body: '当日は筆記用具をお持ちください。' },
  }),
  schedule: fact({ timing: '1日前 19:00' }),
  shared_with: fact({ count: 3, items: ['11/26回', '12/3回', '12/10回'] }),
  audience: audience === null ? { status: 'unknown', readAt: iso(now - 60_000), source: '/line/episode/show/7001001' } : fact({ count: Number(audience) }),
}

const exec = (state: BrowserExecutionView['state'], confirmableAt: number | null = null): BrowserExecutionView => ({
  id: `bx_${'3c'.repeat(16)}`, state, claimedAt: iso(now - 120_000), permittedAt: iso(now - 110_000), settledAt: null,
  confirmableAt: confirmableAt === null ? null : iso(confirmableAt), voidReason: null, confirmedBy: null,
})

const base: BrowserPlanView = {
  id: PLAN, state: 'draft', closeReason: null, connector: MANUAL ? { id: 'haishin', version: '0.1.0', label: '配信ツール' } : { id: 'lstep', version: '0.6.0', label: 'Lステップ' }, operation: 'reminder_step_add_template',
  label: 'リマインダの段にテンプレートを足す',
  sharedNote: params.get('shared') === '1' ? '全部の回で共有のリマインダです。ほかの回でも、この段をまだ迎えていない人に届きます（もう過ぎた人には届きません）。' : null,
  delivers: 'scheduled', account: '5550001', target: { reminder: '7001001', step: '7002001' }, change: { template: MANUAL ? '8003002' : '7003002' }, facts,
  explanation: MANUAL ? '「前日」の段に、持ち物のご案内を足す案です。来週の説明会に申し込んだ人に届きます。' : '「前日」の段に、持ち物のお知らせを足す案です。', createdAt: iso(now - 300_000), expiresAt: iso(now + 3_300_000), approvedAt: null,
  contentHash: HASH, execution: null,
}

const byState: Record<string, Partial<BrowserPlanView>> = {
  draft: {},
  unknown: { state: 'claimed', approvedAt: iso(now - 130_000), execution: exec('unknown', now - 60_000) },
  'unknown-early': { state: 'claimed', approvedAt: iso(now - 130_000), execution: exec('unknown', now + 20 * 60_000) },
  succeeded: { state: 'done', approvedAt: iso(now - 130_000), execution: exec('succeeded') },
  failed: { state: 'done', approvedAt: iso(now - 130_000), execution: exec('failed') },
  cancelled: { state: 'closed', closeReason: 'cancelled' },
}
const readyParam = params.get('ready') ?? 'ok'
const ready: BrowserPlanCardData['ready'] = readyParam === 'ok' ? { ok: true } : { ok: false, reason: readyParam as BrowserPlanNotReady }

// The server's copy, changed by the presses (read again by the card after each one).
let view: BrowserPlanView = { ...base, ...(byState[params.get('state') ?? 'draft'] ?? {}) }

function Preview() {
  const [sent, setSent] = useState('')
  const card = (v: BrowserPlanView): BrowserPlanCardData => ({ plan: v, ready, stoppedHere: params.get('hint') === '1', runningHere: false, siteHost: MANUAL ? 'haishin.example.net' : 'manager.linestep.net' })
  installElectronAPI({
    getBrowserPlan: async () => ({ ok: true, card: card(view) }),
    runBrowserPlan: async (companyId, planId, contentHash) => {
      setSent(JSON.stringify({ companyId, planId, contentHash }))
      view = { ...view, state: 'done', approvedAt: iso(Date.now()), execution: exec('succeeded') }
      return { ok: true, result: { outcome: 'succeeded' } }
    },
    cancelBrowserPlan: async (companyId, planId) => {
      setSent(JSON.stringify({ cancel: planId, companyId }))
      view = { ...view, state: 'closed', closeReason: 'cancelled' }
      return { ok: true }
    },
    confirmBrowserExecution: async (_companyId, executionId, result) => {
      setSent(JSON.stringify({ executionId, result }))
      view = { ...view, state: 'done', execution: exec(result === 'done' ? 'confirmed_done' : 'confirmed_not_done') }
      return { ok: true }
    },
    openBrowserSite: async (_companyId, host) => { setSent(JSON.stringify({ open: host })); return { ok: true } },
  })
  const ref: BrowserPlanCardRef = { id: PLAN, companyId: 'co-preview', conversationId: 'conv-1', planId: PLAN, at: iso(now) }
  const parts = [{ type: 'text', text: MANUAL ? '配信ツールの計画を作りました。中身を確かめてください。' : '承認のカードを出しました。中身を確かめてください。' }, { type: BROWSER_PLAN_PART_TYPE, id: `browser-plan-${PLAN}`, data: ref }] as UIMessage['parts']
  return (
    <main className="min-h-screen bg-bg p-8 text-text">
      <p className="mb-4 text-small text-text-muted">表示確認用の人工データ。本番の相談やサイトには接続しません。</p>
      <section className="mx-auto max-w-xl"><AssistantMessageParts parts={parts} isStreaming={false} markdown /></section>
      <pre id="sent">{sent}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
