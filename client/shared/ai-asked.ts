/**
 * The AI at the member's request (records.md "The AI at the member's request", owner decision 2026-11-26
 * 「AI に完了を頼めるようにする」): what the AI completed or ended in one turn becomes **one** card of the reply
 * — a compact list, each line with ［取り消す］. The card is the app's (main pushes it as the data part
 * `data-ai-asked` under one id per turn, so each new item replaces it), stored with the message as `aiAsked`;
 * ［取り消す］ is the member's own generic undo of that entry, with their session (`tasks:undo`), never the AI.
 * Pure: types, limits, the reader of a stored / streamed card, and the AI's words.
 */
import { AI_ASKED_PER_TURN } from '../../shared/core/record-types'
import { RECORD_ID_RE } from '../../shared/core/records'
import { pastTense } from './acb-tool-displays'

export const AI_ASKED_PART_TYPE = 'data-ai-asked'

export interface AiAskedItem {
  recordId: string
  /** The record's title when it was done (shown as the member's own record; ≤ 200). */
  title: string
  /** What was done, in words (「完了にしました」). */
  done: string
  /** The ledger entry's version: what ［取り消す］ undoes, and the version it expects. */
  version: number
}

export interface AiAskedCard {
  /** One per turn: every item of the turn lands on the same card. */
  id: string
  companyId: string
  conversationId: string | null
  items: AiAskedItem[]
  at: string
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A stored / streamed card, validated (undefined when malformed; a malformed item is left out). */
export function readAiAskedCard(data: unknown): AiAskedCard | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!str(d.id, 200) || !str(d.companyId, 200) || !str(d.at, 40) || !Array.isArray(d.items)) return undefined
  const items: AiAskedItem[] = []
  for (const raw of d.items.slice(0, AI_ASKED_PER_TURN)) {
    const i = raw as Record<string, unknown> | null
    if (!i || typeof i.recordId !== 'string' || !RECORD_ID_RE.test(i.recordId) || !str(i.title, 200) || !str(i.done, 60)) continue
    if (!Number.isInteger(i.version) || (i.version as number) < 1) continue
    items.push({ recordId: i.recordId, title: i.title, done: i.done, version: i.version as number })
  }
  if (items.length === 0) return undefined
  return { id: d.id, companyId: d.companyId, conversationId: typeof d.conversationId === 'string' && d.conversationId.length <= 200 ? d.conversationId : null, items, at: d.at }
}

/**
 * What was done, from the action's label: 「完了にする」 → 「完了にしました」, 「終わりにする」 → 「終わりにしました」; a label that
 * states a fact (「もう返した」) is quoted → 「「もう返した」にしました」. The card's lines and 経緯 say it the same way.
 */
export function aiAskedDoneWords(label: string): string {
  const s = label.trim()
  return /た$/.test(s) ? `「${s}」にしました` : pastTense(s)
}

/** 経緯's line of such an entry (owner decision 2026-11-26): 「AI が（本人の頼みで）完了にしました」. */
export const aiAskedHistoryText = (label: string) => `AI が（本人の頼みで）${aiAskedDoneWords(label)}`

/** The server's answers that mean the entry can no longer be undone as it stands: undone already, or changed since. */
export const AI_ASKED_UNDO_STALE_CODES: readonly string[] = ['VERSION_CONFLICT', 'CHANGED_SINCE', 'NOT_UNDOABLE', 'ENTRY_NOT_FOUND']

/** ［取り消す］ refused because of that: what to say, with the record's state now when the server answered it. */
export function aiAskedUndoStaleText(stateNow: string | null): string {
  return `取り消せませんでした。もう取り消したか、このあと別の変更がありました。${stateNow ? `（いまは「${stateNow}」です）` : ''}`
}

/** The card's heading: closes and corrections (task version 16: 件名・目的を直す) land on the same card. */
export const aiAskedHeading = (n: number) => `AI が頼まれてしたこと（${n}件）`

/**
 * What the AI is told about these tools in a turn the member started (appended to the record tools'
 * instructions). The refusal sentences themselves are the server's (`AI_ASKED_REFUSALS`).
 */
export const AI_ASKED_INSTRUCTIONS = '\n\n【メンバーに頼まれたときだけ使える操作】このやりとりはメンバー本人が始めたものなので、' +
  '担当がメンバー本人の「やること」の「完了にする」（task__complete）と、「返事のお願い」の「終わりにする」（reply_request__close）・' +
  '「もう返した」（reply_request__replied_elsewhere）を、メンバーがこの会話ではっきり頼んだときだけ使ってよい。' +
  '担当か頼んだ人がメンバー本人の「やること」の件名・目的を直す（task__retitle・task__set_purpose）のも同じで、頼まれたときだけ。' +
  'メンバーが頼んだ「やること」のアーカイブ（task__cancel。画面の言葉は「アーカイブ」）、メンバーに頼まれた「やること」を引き受ける（task__accept）、' +
  '担当がメンバーの「来た連絡」を「済んだ」にする（interaction__settle。ToolSearch の select: で読み込む）、メンバー本人の24時間以内の変更を取り消す（records_undo。先に records_history で version を確かめる）も、頼まれたときだけ。' +
  'メンバーが頼んだ「やること」の確かめる人・終わったら（task__set_reviewer・task__set_when_done）、メンバーが責任者のプロジェクトのなんのため・期限・責任者（project__set_purpose・project__set_due・project__set_owner。select: で読み込む）も、頼まれたときだけ。' +
  '件名・目的が古いと気づいたら、直してよいかを先に聞く。' +
  '頼まれていないのに自分の判断で使わない。どれを片づけるか迷うときは、先に一覧を見せて確かめる。' +
  `1回のやりとりで ${AI_ASKED_PER_TURN} 件まで（取り消しも数える）。断られたら、返ってきた error の文をそのまま伝える（完了にする・終わりにする・もう返した・アーカイブ・引き受ける・済んだ は本人の設定がオフだと断られ、オンにできることがその文に書いてある）。` +
  'したことは画面に取り消しボタン付きの一覧で出るので、返事ではその件数と「取り消すときはその一覧から」とだけ短く伝える。' +
  '\nOnly when the member explicitly asked in this conversation: complete their own やること / end their own 返事のお願い with those tools, ' +
  'or correct the title / purpose of a やること they are assigned to or asked for (task__retitle, task__set_purpose); ' +
  'archive a やること they asked for (task__cancel), accept one asked of them (task__accept), settle their 来た連絡 (interaction__settle), ' +
  'or take back one of their own changes of the last 24 hours (records_undo); set the checker / when-done of a やること they asked for, ' +
  'or the purpose / due / owner of a プロジェクト they own; never on your own judgement. ' +
  `At most ${AI_ASKED_PER_TURN} per turn. On a refusal, relay its error sentence exactly.`
