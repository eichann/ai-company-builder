// What a 「ブラウザ操作」 plan's card says (agent-browser.md "The card, the IPC and the request tool"; design
// 6b-2 §2-1, §4): read only from the server's fixed view of the plan — the facts the app's checker read
// from the site, the declaration's note — never from the chat's text. Pure: no React, no IPC.
// Never on the card: 「安全です」, a hash, a token, the secret, or a claim that the whole page was stopped.
import type { BrowserFact } from '../../../../shared/core/browser-plans'
import type { BrowserPlanView } from '../../../../shared/types/browser-plans'
import type { BrowserPlanCardData, BrowserPlanNotReady } from '../../../shared/browser-plans'
import { BROWSER_RUN_WORDS, type BrowserRunReason, type BrowserRunResult } from '../../../shared/browser-runner'
import type { BrowserWriteView } from '../../../shared/browser-line-writes'

/** A write card is read again this often while its run goes on (a `bf_` card moves on in main by itself). */
export const WRITE_CARD_LIVE_REFRESH_MS = 2_000
/**
 * …and while its answer buttons for a write in doubt are up, backing off (the polling-reduction plan): every 15 s for the
 * first 2 minutes, then every 60 s up to 10 minutes in all, then not at all — until the card is shown again (mounted
 * again) or its window comes to the front.
 */
export const WRITE_CARD_UNSETTLED_REFRESH = Object.freeze({ firstMs: 15_000, firstReads: 8, laterMs: 60_000, laterReads: 8 })

/**
 * How often a write card reads itself again, or null: while a `bf_` card's run goes on (every 2 s), and while the answer
 * buttons of a write in doubt are up — also once they can be pressed — so an answer given in the card's other window (the
 * main window and the consultation's own window) shows here too (agent-browser.md "A card in its consultation's own
 * window"), backing off by `reads` (how many times it was read for its answer buttons since it was last shown or brought to the front).
 */
export function writeCardRefreshMs(cardId: string, view: BrowserWriteView | null, pressing: boolean, reads = 0): number | null {
  if (cardId.startsWith('bf_') && !!view && view.phase !== 'finished' && view.phase !== 'failed') return WRITE_CARD_LIVE_REFRESH_MS
  if (!view?.result?.confirm || pressing) return null
  const r = WRITE_CARD_UNSETTLED_REFRESH
  return reads < r.firstReads ? r.firstMs : reads < r.firstReads + r.laterReads ? r.laterMs : null
}

export const PLAN_WORDS = {
  title: '承認のお願い（ブラウザ操作）',
  factsHeading: 'サイトから読み取った情報',
  explanationHeading: 'AI の説明（サイトから読んだ情報ではありません）',
  scheduled: 'この段の時刻をこれから迎える人に、その時刻に届きます。すでに過ぎた人には届きません。',
  audienceUnknown: '読み取れませんでした',
  noResend: 'もう一度は送りません。もう一度やるときは、相談で頼み直してください。',
  stoppedHere: 'このパソコンの記録では、送る前に止めています（参考です。確かめた結果は、ご自身で押してください）。',
  run: '任せる',
  cancel: 'やめる',
  openSite: '開いてログイン',
  done: '済んでいた',
  notDone: 'されていなかった',
} as const

/** One template as the card shows it. */
export interface ShownTemplate { id: string; name: string; body: string }

export interface PlanCardContent {
  account: string | null
  reminder: string | null
  step: string | null
  /** The templates on the step now (from the `state` fact, named by the `templates` fact). */
  onStep: ShownTemplate[]
  /** The one to add. */
  toAdd: ShownTemplate | null
  /** The step's timing exactly as the page shows it (never parsed). */
  timing: string | null
  /** Unknown, a known 0 and a known N stay three different answers (decision 1). */
  audience: { known: true; count: number } | { known: false }
  sharedWith: { count: number; items: string[] } | null
  /** The earliest read time among the facts (ISO). */
  readAt: string | null
}

const known = (f: BrowserFact | undefined): Record<string, unknown> | null =>
  f && f.status === 'known' && f.value && typeof f.value === 'object' ? f.value as Record<string, unknown> : null
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export function planContent(plan: BrowserPlanView): PlanCardContent {
  const f = plan.facts
  const templates = known(f.templates) ?? {}
  const shown = (id: string): ShownTemplate => {
    const t = templates[id] as { name?: unknown; body?: unknown } | undefined
    return { id, name: text(t?.name) ?? '（名前を読み取れませんでした）', body: typeof t?.body === 'string' ? t.body : '' }
  }
  const state = known(f.state)
  const onStep = Array.isArray(state?.templates) ? (state.templates as unknown[]).filter((x): x is string => typeof x === 'string').map(shown) : []
  const addId = plan.change.template
  const audience = known(f.audience)
  const shared = known(f.shared_with)
  const names = known(f.names)
  const reads = Object.values(f).map(x => x.readAt).filter(x => typeof x === 'string').sort()
  return {
    account: text(known(f.account)?.id),
    reminder: text(names?.reminder),
    step: text(names?.step),
    onStep,
    toAdd: typeof addId === 'string' ? shown(addId) : null,
    timing: text(known(f.schedule)?.timing),
    audience: audience && typeof audience.count === 'number' ? { known: true, count: audience.count } : { known: false },
    sharedWith: shared && typeof shared.count === 'number' && Array.isArray(shared.items)
      ? { count: shared.count, items: (shared.items as unknown[]).filter((x): x is string => typeof x === 'string') } : null,
    readAt: reads[0] ?? null,
  }
}

export type PlanTone = 'awaiting' | 'working' | 'ok' | 'stopped' | 'unknown'

export interface PlanStatus {
  tone: PlanTone
  line: string
  /** What to check in the site, for a result nobody knows. */
  check?: string
  /** ［任せる］［やめる］ belong on the card (whether ［任せる］ is enabled is `ready`). */
  awaiting: boolean
  /** ［やめる］ alone (approved but never started here). */
  cancelOnly: boolean
  /** ［済んでいた］［されていなかった］ can be pressed now. */
  canConfirm: boolean
  /** When they can be pressed, while not yet. */
  confirmFrom?: string
  noResend: boolean
}

const hhmm = (iso: string | null | undefined, zone?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) })
}

const CLOSED_WORDS: Record<string, string> = {
  cancelled: 'やめました。サイトには何も送っていません。',
  expired: '期限が過ぎたので、送りませんでした。',
  left: '会社を抜けたため、この計画は閉じました。',
}

/** The card's state line, from the server's state (and this PC's run, while it runs). */
export function planStatus(card: Pick<BrowserPlanCardData, 'plan' | 'runningHere'>, now: number, zone?: string): PlanStatus {
  const { plan } = card
  const base = { awaiting: false, cancelOnly: false, canConfirm: false, noResend: false }
  if (plan.state === 'draft') return { ...base, tone: 'awaiting', line: `承認を待っています（期限 ${hhmm(plan.expiresAt, zone)}）`, awaiting: true }
  if (plan.state === 'closed') return { ...base, tone: 'stopped', line: CLOSED_WORDS[plan.closeReason ?? ''] ?? '閉じました。サイトには何も送っていません。' }
  if (plan.state === 'approved' && !plan.execution) {
    return card.runningHere ? { ...base, tone: 'working', line: '確かめています…' }
      : { ...base, tone: 'stopped', line: '承認しましたが、始まりませんでした。サイトには何も送っていません。', cancelOnly: true, noResend: true }
  }
  const exec = plan.execution
  if (!exec) return { ...base, tone: 'working', line: '確かめています…' }
  switch (exec.state) {
    case 'claimed': return { ...base, tone: 'working', line: '確かめています…' }
    case 'permitted': return card.runningHere ? { ...base, tone: 'working', line: '送っています…' }
      : { ...base, tone: 'unknown', line: '送られた可能性があります。少し待ってから、結果を確かめてください。', noResend: true }
    case 'succeeded': return { ...base, tone: 'ok', line: BROWSER_RUN_WORDS.succeeded }
    case 'failed': return { ...base, tone: 'stopped', line: BROWSER_RUN_WORDS.failed, noResend: true }
    case 'void': return { ...base, tone: 'stopped', line: '送りませんでした。サイトには何も送っていません。', noResend: true }
    case 'confirmed_done': return { ...base, tone: 'ok', line: '確かめました：済んでいました。' }
    case 'confirmed_not_done': return { ...base, tone: 'stopped', line: '確かめました：されていませんでした。', noResend: true }
    case 'unknown': {
      const c = planContent(plan)
      const where = [c.reminder && `「${c.reminder}」`, c.step && `「${c.step}」の段`].filter(Boolean).join('の')
      const check = `${plan.connector.label}で${where || '段'}を開いて、テンプレート${c.toAdd ? `「${c.toAdd.name}」` : ''}が足されているか確かめてください。`
      const from = exec.confirmableAt ? Date.parse(exec.confirmableAt) : NaN
      const canConfirm = Number.isFinite(from) && now >= from
      return {
        ...base, tone: 'unknown', line: '届いたか分かりません。', check, noResend: true, canConfirm,
        ...(canConfirm || !exec.confirmableAt ? {} : { confirmFrom: `${hhmm(exec.confirmableAt, zone)}から、確かめた結果を押せます。` }),
      }
    }
  }
}

/** Why ［任せる］ cannot be pressed on this PC, in plain words (design 6b-2 §2-1). */
export function notReadyText(reason: BrowserPlanNotReady, siteLabel: string): string | null {
  switch (reason) {
    case 'off': return 'この機能は、このアプリではまだ使えません。'
    case 'no-window': return `このパソコンでは${siteLabel}の窓が開いていません。開いてログインしてから任せてください。`
    case 'not-logged-in': return `${siteLabel}の窓で、計画と同じアカウントにログインしていることを確かめられませんでした。ログインし直してから開き直してください。`
    case 'busy': return 'この窓では、いまほかの操作をしています。終わってから任せてください。'
    case 'stopped': return 'AI が止められているため、いまは任せられません。'
    case 'state': return null
  }
}

const RUN_REASON_WORDS: Partial<Record<BrowserRunReason, string>> = {
  'facts-changed': '承認のあとでサイトの中身が変わったので、送りませんでした。',
  'before-changed': '承認のあとでサイトの中身が変わったので、送りませんでした。',
  'account-mismatch': '開いているアカウントが計画と違うので、送りませんでした。',
  'account-unknown': 'ログインしているアカウントを確かめられなかったので、送りませんでした。',
  'no-window': 'サイトの窓が開いていないので、送りませんでした。',
  'window-closed': 'サイトの窓が閉じられたので、送りませんでした。',
  'foreign-frames': 'サイトの窓に、ログインの確かめ（ロボットではないかの確認など）が残っていたので、送りませんでした。ログインを済ませた画面にしてから、相談で頼み直してください。',
  stopped: 'AI が止められているので、送りませんでした。',
  policy: '会社の設定が変わったので、送りませんでした。',
  expired: '期限が過ぎたので、送りませんでした。',
  'context-changed': 'ログインや設定が変わったので、送りませんでした。',
  'read-failed': 'サイトを読み直せなかったので、送りませんでした。',
  'checker-problem': 'サイトを読み直せなかったので、送りませんでした。',
  'already-ran': 'このパソコンでは、この計画をもう始めています。もう一度は送りません。',
  'already-running': 'いま実行しています。',
  off: 'この機能は、このアプリではまだ使えません。サイトには何も送っていません。',
}

/** What the press led to, in plain words, until the card reads the server again. */
export function runResultText(result: BrowserRunResult): string {
  if (result.outcome === 'succeeded') return BROWSER_RUN_WORDS.succeeded
  if (result.outcome === 'failed') return BROWSER_RUN_WORDS.failed
  if (result.outcome === 'unknown') return '届いたか分かりません。カードの案内に沿って、サイトで確かめてください。もう一度は送りません。'
  if (result.outcome === 'refused' && result.reason === 'approve-refused' && result.code === 'CONTENT_CHANGED') return 'カードの中身が変わりました。開き直して確かめてください。サイトには何も送っていません。'
  return RUN_REASON_WORDS[result.reason] ?? BROWSER_RUN_WORDS[result.outcome]
}
