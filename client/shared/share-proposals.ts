/**
 * 「部署に出す」 as the AI's proposal, the member's press (owner decision 2026-11-27, PR D; records.md "Owner-only records",
 * "The AI at the member's request"). Showing a record to a department widens who sees it and is never taken back, so the AI
 * never does it: its tool (`records_propose_share`) only checks the task is the member's own 「あなただけ」 one and draws this
 * card in the reply (data part `data-share-proposal`, stored with the message as `shareProposals`). ［部署に出す］ is the
 * member's own press through the app's existing `tasks:share` with their session — the server decides it as for the task
 * card's button (owner, folder, 見える範囲 of its 案件, the people it names). No AI route or record token reaches it.
 * Pure: main, the renderer and tests use it.
 */
import { fileLinkPath, RECORD_ID_RE } from '../../shared/core/records'

export const SHARE_PROPOSAL_PART_TYPE = 'data-share-proposal'

export interface ShareProposalCardRef {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  recordId: string
  /** The task's title when proposed (shown; ≤ 200). */
  title: string
  /** The department folder it would be shown to (a company path, as the card's 部署に出す sends it). */
  folder: string
  at: string
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A folder the proposal may name: a company path (no `..`, not absolute), never inside `.personal/`. */
export function shareFolderOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200) return null
  const p = fileLinkPath(v.trim().replace(/\/+$/, ''))
  return p && !p.split('/').some(s => s.toLowerCase() === '.personal') ? p : null
}

/** A stored / streamed reference, validated (undefined when malformed). */
export function readShareProposalCard(data: unknown): ShareProposalCardRef | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const folder = shareFolderOf(d.folder)
  if (!str(d.id, 200) || !str(d.companyId, 200) || typeof d.recordId !== 'string' || !d.recordId.startsWith('task-') || !RECORD_ID_RE.test(d.recordId)) return undefined
  if (!str(d.title, 200) || folder === null || !str(d.at, 40)) return undefined
  return {
    id: d.id, companyId: d.companyId, conversationId: typeof d.conversationId === 'string' && d.conversationId.length <= 200 ? d.conversationId : null,
    recordId: d.recordId, title: d.title, folder, at: d.at,
  }
}

/** The card's words (the app's, never the AI's text). */
export const SHARE_PROPOSAL_WORDS = {
  heading: '部署に出す案（AI から）',
  line: (title: string, folder: string) => `やること「${title}」を「${folder}」に出します。出すと、その部署を見られる人に見えるようになり、「あなただけ」には戻せません。`,
  press: '部署に出す',
  decline: 'やめる',
  done: (folder: string) => `「${folder}」に出しました。`,
  declined: '出さないことにしました（何も変えていません）。',
  already: 'このやることは、もう「あなただけ」ではありません（部署に出ているか、見られる人が変わっています）。',
  gone: 'このやることは見つかりません（消えたか、見られなくなっています）。',
} as const
