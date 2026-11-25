/**
 * 「ブラウザ操作」's read-only inspection in the app (generalization PR 5b; agent-browser.md "The inspection in the chat"):
 * the consultation AI's tool name, the chat's reference to an inspection's card (a data part stored with the reply — the
 * card itself is held by main in memory only), the IPC answer, the check of a card the renderer is handed, and the fixed
 * words the AI gets back. Pure: main, preload, the renderer and tests import it.
 *
 * What the site showed (the read fields' values, the account) is on the member's card only. The AI gets fixed words and,
 * for each check, its label (the line's and the map's words) and its mark — ✓ / ✗ / 「読み取れませんでした」 — never a
 * value, a field heading of a ✗ or the account (owner decision, the PC-registration memo v2).
 */
import { BROWSER_CARD_MARK_WORDS, type BrowserCard, type BrowserCardMark, type BrowserCardRow, type BrowserCardValue } from '../../shared/core/browser-card'
import { BROWSER_REQUEST_SERVER, BROWSER_COMPANY_ID_RE } from './browser-plans'

/** The consultation AI's inspection tool (`mcp__acb_browser__browser_inspect`; electron/browser-request/inspect-tool.ts). */
export const BROWSER_INSPECT_TOOL = 'browser_inspect'
export const BROWSER_INSPECT_TOOL_ID = `mcp__${BROWSER_REQUEST_SERVER}__${BROWSER_INSPECT_TOOL}`
/** The consultation AI's write proposal (`mcp__acb_browser__browser_write`; generalization PR 5c, electron/browser-request/inspect-tool.ts). */
export const BROWSER_WRITE_TOOL = 'browser_write'
export const BROWSER_WRITE_TOOL_ID = `mcp__${BROWSER_REQUEST_SERVER}__${BROWSER_WRITE_TOOL}`

/** The chat's reference to an inspection's card (one per tool call; stored with the reply as `browserInspections`). */
export const BROWSER_INSPECTION_PART_TYPE = 'data-browser-inspection'

/** The server's inspection plan id (routes/browser-lines.ts): put in an address only in this shape. */
export const BROWSER_LINE_PLAN_ID_RE = /^bl_[0-9a-f]{32}$/
/** A write card's id (main's own, generalization PR 5c): the reference names it instead of a server plan. */
export const BROWSER_WRITE_CARD_REF_RE = /^wp_[0-9a-f]{32}$/

export interface BrowserInspectionRef {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  /** An inspection's server plan (`bl_…`), or a write card's id (`wp_…`, main's: PR 5c). */
  planId: string
  at: string
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A stored or streamed reference, or undefined when it is not one (never trusted beyond its shape). */
export function readBrowserInspectionRef(data: unknown): BrowserInspectionRef | undefined {
  if (!isMap(data)) return undefined
  const d = data
  if (!str(d.id, 200) || !str(d.companyId, 100) || !BROWSER_COMPANY_ID_RE.test(d.companyId) || !str(d.planId, 40) || !(BROWSER_LINE_PLAN_ID_RE.test(d.planId) || BROWSER_WRITE_CARD_REF_RE.test(d.planId)) || !str(d.at, 40)) return undefined
  return {
    id: d.id, companyId: d.companyId, planId: d.planId, at: d.at,
    conversationId: typeof d.conversationId === 'string' && d.conversationId.length <= 200 ? d.conversationId : null,
  }
}

/** One inspection's card as main holds it (memory only, this signed-in member's). */
export interface BrowserInspectionView {
  card: BrowserCard
  /** When main read the site (ISO). */
  readAt: string
  /** The site's name as its reviewed declaration says it (「Lステップ」). */
  siteLabel: string
}

export type BrowserInspectionGetResult = { ok: true; view: BrowserInspectionView } | { ok: false; message: string }

/** What the card says when main has no card for it (after the app restarted, another account, another window). */
export const BROWSER_INSPECTION_CARD_WORDS = {
  gone: 'この点検の結果は、このアプリを開き直したので消えました（サイトから読んだ値は、パソコンに残しません）。もう一度見るときは、相談で点検を頼んでください。',
  notMainWindow: 'この点検のカードは、アプリのメインの窓の相談で開いてください（別の窓では開けません）。',
  badInput: '入力が正しくありません。',
  loading: '読み込んでいます…',
  readAt: '読み取った時刻',
  siteValues: 'サイトから読み取った情報（AI には見せていません）',
  checks: '確かめ',
  notes: 'サイトの注意',
  unreadable: BROWSER_CARD_MARK_WORDS.unreadable,
} as const

const MARKS: readonly BrowserCardMark[] = ['ok', 'ng', 'unreadable', 'later']
const STATES = ['all_ok', 'ng', 'not_read']
const isStr = (v: unknown, max = 10_000): v is string => typeof v === 'string' && v.length <= max

function readValue(v: unknown): BrowserCardValue | null {
  if (!isMap(v)) return null
  if (v.status === 'unreadable') return { status: 'unreadable' }
  return v.status === 'read' && isStr(v.text, 20_000) ? { status: 'read', text: v.text } : null
}

function readRow(r: unknown): BrowserCardRow | null {
  if (!isMap(r) || !isStr(r.label, 200)) return null
  if ('value' in r) {
    const value = readValue(r.value)
    return value ? { label: r.label, value } : null
  }
  const before = readValue(r.before)
  const after = readValue(r.after)
  return before && after ? { label: r.label, before, after } : null
}

/**
 * A card as the renderer is handed it (`browserLines:card`): every field the card shows checked for its shape and copied
 * alone; null when any is off. A mark is one of the four words; nothing else of the answer is shown.
 */
export function readBrowserCard(v: unknown): BrowserCard | null {
  if (!isMap(v) || !isStr(v.title, 200) || !STATES.includes(v.state as string) || !isStr(v.headline, 500)) return null
  if (!Array.isArray(v.sections) || !Array.isArray(v.checks) || !Array.isArray(v.notes) || v.sections.length > 50 || v.checks.length > 50 || v.notes.length > 50) return null
  const sections: BrowserCard['sections'][number][] = []
  for (const s of v.sections) {
    if (!isMap(s) || !isStr(s.heading, 200) || !Array.isArray(s.rows) || s.rows.length > 100) return null
    const rows: BrowserCardRow[] = []
    for (const r of s.rows) {
      const row = readRow(r)
      if (!row) return null
      rows.push(row)
    }
    sections.push({ heading: s.heading, rows })
  }
  const checks: BrowserCard['checks'][number][] = []
  for (const c of v.checks) {
    if (!isMap(c) || !isStr(c.label, 500) || !MARKS.includes(c.mark as BrowserCardMark) || !Array.isArray(c.fields) || !c.fields.every(f => isStr(f, 200))) return null
    checks.push({ label: c.label, mark: c.mark as BrowserCardMark, fields: [...c.fields as string[]] })
  }
  if (!v.notes.every(n => isStr(n, 500))) return null
  let account: BrowserCard['account']
  if (v.account !== undefined) {
    const value = isMap(v.account) && isStr(v.account.label, 200) ? readValue(v.account.value) : null
    if (!value || !isMap(v.account)) return null
    account = { label: v.account.label as string, value }
  }
  return {
    title: v.title, state: v.state as BrowserCard['state'], headline: v.headline, ...(account ? { account } : {}),
    sections, checks, notes: [...v.notes as string[]],
  }
}

/** A view as the renderer is handed it, or null. */
export function readBrowserInspectionView(v: unknown): BrowserInspectionView | null {
  if (!isMap(v) || !isStr(v.readAt, 40) || !isStr(v.siteLabel, 200)) return null
  const card = readBrowserCard(v.card)
  return card ? { card, readAt: v.readAt, siteLabel: v.siteLabel } : null
}

/**
 * What the consultation AI gets back from `browser_inspect`: fixed words, and for a judged inspection each check's label
 * and mark only. Never a value the site showed (the card's rows, the account), never the headings of a ✗'s fields.
 */
export const BROWSER_INSPECT_WORDS = {
  off: 'ブラウザ操作は、このアプリではまだ使えません。ユーザーにそう伝えてください。',
  badInput: '頼み方の形が正しくありません。site と line（点検の種類）と values（点検するものの番号）を入れて、もう一度呼んでください。',
  unknownLine: 'その点検の種類は、このアプリにはありません（使える点検は、このツールの説明にあるものだけです）。',
  notApproved: 'この点検は、いまは使えません（まだ許可されていない、または取り下げられています）。ユーザーにそう伝えてください。',
  notAllowed: 'この点検は、会社の設定でいまは使えません（サイトが許可されていないなど）。ユーザーにそう伝えてください。',
  notGranted: 'ユーザーには、この点検を使う許可がまだありません。管理者に頼むようユーザーに伝えてください。',
  stopped: 'AI の動きが止められているため、点検しませんでした。ユーザーにそう伝えてください。',
  values: '点検するものの番号が正しくありません。ユーザーに、サイトの画面で番号を確かめてもらってから、もう一度呼んでください。',
  noWindow: 'このパソコンでサイトの窓が開いていません。設定の「ブラウザ操作」で窓を開いてログインしてから、もう一度頼むようユーザーに伝えてください。',
  busy: 'このサイトの窓は、いま別の点検で使っています。少し待ってから、もう一度呼んでください。',
  interrupted: '点検を途中で止めました（相談が閉じられた・止められた・ログインや設定が変わった・時間切れなど）。サイトは読んだだけで、何も変えていません。ユーザーにそう伝えてください。',
  offline: 'サーバーにつながらなかったため、点検しませんでした。少し待ってから、もう一度頼むようユーザーに伝えてください。',
  failed: '点検できませんでした。サイトは何も変えていません。少し待ってから、もう一度頼むようユーザーに伝えてください。',
  done: (title: string) =>
    `「${title}」をしました（サイトは読んだだけで、何も変えていません）。結果のカードを相談に出しました。` +
    'サイトから読んだ値はカードにだけ出ていて、あなたには見えません。値を推測して書かないでください。',
  footer: 'ユーザーに、カードを見るよう伝えてください。✗ と「読み取れませんでした」の行は、サイトで確かめてもらってください。',
} as const

/** The AI's words for a judged inspection: the card's title, its overall state and each check's label and mark. */
export function inspectionWordsForAi(card: BrowserCard): string {
  const overall = card.state === 'all_ok' ? '全体: すべて ✓ でした。'
    : card.state === 'ng' ? '全体: ✗ の確かめがあります。' : '全体: 読み取れなかったものがあります（✓ にはしていません）。'
  const lines = card.checks.map(c => `- ${c.label}: ${BROWSER_CARD_MARK_WORDS[c.mark]}`)
  return [BROWSER_INSPECT_WORDS.done(card.title), overall, ...lines, BROWSER_INSPECT_WORDS.footer].join('\n')
}
