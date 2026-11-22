/**
 * 「ブラウザ操作」's plans in the app (agent-browser.md "The card, the IPC and the request tool"; design
 * 6b-2 §2, §3): the IPC payloads of `browserPlans:*`, the chat's reference to a plan's card (a data part
 * stored with the reply — the card always reads the server), the checks main applies to what the
 * renderer hands it, and the fixed words the consultation AI gets back from `browser_request`.
 * Pure: main, preload, the renderer and tests import it.
 */
import type { BrowserOpenPlans, BrowserPlanView } from '../../shared/types/browser-plans'
import type { BrowserRunResult } from './browser-runner'

/** The consultation AI's request tool (`mcp__acb_browser__browser_request`; electron/browser-request/tools.ts). */
export const BROWSER_REQUEST_SERVER = 'acb_browser'
export const BROWSER_REQUEST_TOOL = 'browser_request'
export const BROWSER_REQUEST_TOOL_ID = `mcp__${BROWSER_REQUEST_SERVER}__${BROWSER_REQUEST_TOOL}`

/** The chat's reference to a plan's card (one per tool call; stored with the reply as `browserPlans`). */
export const BROWSER_PLAN_PART_TYPE = 'data-browser-plan'

export interface BrowserPlanCardRef {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  planId: string
  at: string
}

/** The ids main puts into a server address: exactly the server's own shapes (nothing to encode). */
export const BROWSER_PLAN_ID_RE = /^bp_[0-9a-f]{32}$/
export const BROWSER_EXECUTION_ID_RE = /^bx_[0-9a-f]{32}$/
export const BROWSER_COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A stored or streamed reference, or undefined when it is not one (never trusted beyond its shape). */
export function readBrowserPlanCardRef(data: unknown): BrowserPlanCardRef | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!str(d.id, 200) || !str(d.companyId, 100) || !BROWSER_COMPANY_ID_RE.test(d.companyId) || !str(d.planId, 40) || !BROWSER_PLAN_ID_RE.test(d.planId) || !str(d.at, 40)) return undefined
  return {
    id: d.id, companyId: d.companyId, planId: d.planId, at: d.at,
    conversationId: typeof d.conversationId === 'string' && d.conversationId.length <= 200 ? d.conversationId : null,
  }
}

/**
 * Why ［任せる］ cannot be pressed on this PC now (6b-2 decision 4: only where the site's window is open
 * and logged in as the plan's account), or why the card has nothing to press.
 */
export type BrowserPlanNotReady =
  /** The AI's browser operation is switched off in this build (6b). */
  | 'off'
  /** The site's window is not open on this PC (or the company's setting does not list the site). */
  | 'no-window'
  /** The window is open but the page does not show the plan's account (logged out, another account). */
  | 'not-logged-in'
  /** Another run uses the window. */
  | 'busy'
  /** The company's AI is stopped. */
  | 'stopped'
  /** The plan is no longer waiting for approval. */
  | 'state'

export interface BrowserPlanCardData {
  /** The server's fixed view of the plan (never the chat's text). */
  plan: BrowserPlanView
  ready: { ok: true } | { ok: false; reason: BrowserPlanNotReady }
  /** This PC's record says it stopped before sending: a hint on an unknown result, never a confirm (decision 10). */
  stoppedHere: boolean
  /** This PC is running it right now (the card's 「送っています…」). */
  runningHere: boolean
  /** The site's operated host as this build's declaration names it (「開いてログイン」), or null. */
  siteHost: string | null
}

export type BrowserPlansFailure = { ok: false; offline: boolean; message: string }
export type BrowserPlanGetResult = { ok: true; card: BrowserPlanCardData } | BrowserPlansFailure
export type BrowserPlanListResult = { ok: true; plans: BrowserOpenPlans } | BrowserPlansFailure
/** ［任せる］: the runner's outcome (approve + claim + the run, one press on this PC). */
export type BrowserPlanRunAnswer = { ok: true; result: BrowserRunResult } | BrowserPlansFailure
/** ［やめる］ and ［済んでいた］［されていなかった］. */
export type BrowserPlanActAnswer = { ok: true } | BrowserPlansFailure
export type BrowserConfirmResult = 'done' | 'not_done'

export const BROWSER_PLAN_IPC_WORDS = {
  badInput: '入力が正しくありません。',
  notMainWindow: 'このカードは、アプリのメインの窓の相談で開いてください（別の窓では開けません）。',
  offline: 'サーバーにつながりませんでした。少し待ってからもう一度開いてください。',
  serverError: 'サーバーでエラーが起きました。少し待ってからもう一度試してください。',
  notFound: 'この計画は見つかりませんでした。',
  tooEarly: 'まだ確かめられません。少し待ってから、もう一度押してください。',
  settled: 'この計画は、もう片付いています。カードを開き直してください。',
} as const

/**
 * What the consultation AI gets back from `browser_request` (6b-2 decision 7): the plan's number and
 * fixed words only — never a fact, a hash, the page's text or the result of a run.
 */
export const BROWSER_REQUEST_WORDS = {
  registered: (planId: string) =>
    `承認のカードを相談に出しました（計画 ${planId}）。中身はカードに書いてあります。ユーザーがカードで確かめて［任せる］を押すまで、何も送られません。` +
    'あなたは承認・実行・結果の確認はできません。カードを見て決めてくださいとだけ伝えて、返事を終えてください。',
  off: 'ブラウザ操作は、このアプリではまだ使えません。ユーザーにそう伝えてください。',
  notAllowed: 'この操作は、会社の設定でいまは使えません（サイトが許可されていない、AI が止められている、または種類が違います）。ユーザーにそう伝えてください。',
  noWindow: 'このパソコンで Lステップなどのサイトの窓が開いていません。設定の「ブラウザ操作」で窓を開いてログインしてから、もう一度頼むようユーザーに伝えてください。',
  noOperator: 'サイトの中を探す役の AI（このパソコンの Claude Code）が使えません。Claude Code が入っていてログインしているか確かめるよう伝えてください。',
  notFound: 'サイトの中で、頼まれたものを特定できませんでした（サイトには何も送っていません）。ユーザーに、リマインダ・段・テンプレートの名前をもう少し詳しく聞いてから、もう一度呼んでください。',
  facts: 'サイトから計画に要る情報を読み取れなかったため、計画を作りませんでした（サイトには何も送っていません）。ユーザーにそう伝えてください。',
  refused: 'サーバーが計画を受け付けませんでした（この操作がまだ許可されていない、など）。サイトには何も送っていません。ユーザーにそう伝えてください。',
  failed: '計画を作れませんでした（時間切れ・中止・通信の失敗など）。サイトには何も送っていません。少し待ってからもう一度頼むようユーザーに伝えてください。',
  badInput: '頼み方の形が正しくありません。operation と、分かっている名前を target_hints / change_hints に入れて、もう一度呼んでください。',
} as const
