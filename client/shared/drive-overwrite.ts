import type { DriveOverwriteConfirmation } from '../../shared/types/google-drive'

/**
 * The chat's card that asks before the AI's text replaces a Google document someone else edited
 * (`.claude/rules/google-drive.md` "Continuing a document people edited", owner decision 2026-11-14): when
 * `drive_put` answers `DRIVE_OVERWRITE_NEEDS_CONFIRMATION`, main adds this card to the reply; it is stored with the
 * message (`driveOverwrites`). The card is drawn by the app — never by the AI's text — and its two buttons are the
 * person's own, through IPC with the member's session (`google:decideDriveOverwrite`): 「上書きする」 writes exactly the
 * content that waits on the server, 「やめる」 closes it. Names come from Google (the member's own Drive).
 */
export const DRIVE_OVERWRITE_PART_TYPE = 'data-drive-overwrite'

export interface DriveOverwriteCard {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  /** The server's confirmation (`drive-confirm-…`). */
  confirmationId: string
  fileName: string
  editors: string[]
  commented: boolean
  expiresAt: string
  at: string
}

const CONFIRMATION_ID_RE = /^drive-confirm-[A-Za-z0-9_-]{1,80}$/
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A stored / streamed card, validated (undefined when malformed). */
export function readDriveOverwriteCard(data: unknown): DriveOverwriteCard | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!str(d.id, 200) || !str(d.companyId, 200) || !str(d.confirmationId, 100) || !CONFIRMATION_ID_RE.test(d.confirmationId)
    || !str(d.fileName, 300) || !str(d.expiresAt, 40) || !str(d.at, 40)) return undefined
  const editors = Array.isArray(d.editors) ? d.editors.filter((n): n is string => str(n, 60)).slice(0, 5) : []
  return {
    id: d.id, companyId: d.companyId, confirmationId: d.confirmationId, fileName: d.fileName, editors, commented: d.commented === true,
    expiresAt: d.expiresAt, at: d.at,
  }
}

/** The card for a put's `confirmation` (null when the server's answer is not one). */
export function driveOverwriteCardFor(confirmation: unknown, ctx: { id: string; companyId: string; at: string }): DriveOverwriteCard | null {
  if (!confirmation || typeof confirmation !== 'object') return null
  const c = confirmation as Partial<DriveOverwriteConfirmation>
  return readDriveOverwriteCard({ ...ctx, confirmationId: c.id, fileName: c.fileName, editors: c.editors, commented: c.commented, expiresAt: c.expiresAt }) ?? null
}

/** 「田中さん・鈴木さんの直し・コメント」 — whose changes are in (「ほかの人」 when Google named nobody). */
export function driveOverwriteWho(card: Pick<DriveOverwriteCard, 'editors'>): string {
  return card.editors.length > 0 ? card.editors.map(n => `${n}さん`).join('・') : 'ほかの人'
}

export const DRIVE_OVERWRITE_WORDS = {
  title: (card: Pick<DriveOverwriteCard, 'editors'>) => `${driveOverwriteWho(card)}の直し・コメントが入っています`,
  body: '取り込んだうえで上書きします。元の版は Google Drive の変更履歴から戻せます。',
  comments: '上書きすると、コメントが元の場所から外れることがあります。',
  confirm: '上書きする',
  decline: 'やめる',
  writing: '上書きしています…',
  written: '上書きしました。',
  notLinked: 'この相談のやることにはつなげませんでした。カードの「Google Drive のファイルをつなぐ」からつないでください。',
  declined: 'やめました。上書きしていません。',
  unknown: '上書きできたか分かりません（Google の答えが届きませんでした）。Google Drive で確かめてください（送り直しはしません）。',
  offline: 'サーバーに接続できないため、いまは上書きできません（オフラインの可能性があります）。',
} as const

/** What the card says for the server's refusals of a press (built from the code: the server's own text never reaches the screen). */
export const DRIVE_OVERWRITE_REFUSALS: Record<string, string> = {
  DRIVE_READ_AGAIN: '確かめている間に、Google Drive でさらに直されたかコメントが付きました。上書きしていません。AI にもう一度読み直してもらってください。',
  DRIVE_CONFIRMATION_EXPIRED: '確かめるまでに時間がたったため、上書きしていません。続けるときは、AI にもう一度頼んでください。',
  DRIVE_CONFIRMATION_DECLINED: 'この上書きは、やめにしてあります。続けるときは、AI にもう一度頼んでください。',
  DRIVE_CONFIRMATION_DONE: 'この上書きは、もう済んでいます。',
  DRIVE_CONFIRMATION_BUSY: 'いま上書きしているところです。少し待ってから画面を確かめてください。',
  DRIVE_CONFIRMATION_NOT_FOUND: 'この確かめは見つかりません。',
  DRIVE_FILE_SHARED_OUTSIDE: 'このファイルは社外の人も見られるようになったため、上書きしていません。',
  DRIVE_FILE_SHARING_UNKNOWN: 'このファイルを誰が見られるか確かめられないため、上書きしていません。',
  DRIVE_FOLDER_SHARED_OUTSIDE: 'このフォルダは社外の人も見られるようになったため、上書きしていません。',
  DRIVE_FOLDER_SHARING_UNKNOWN: 'このフォルダを誰が見られるか確かめられないため、上書きしていません。',
  DRIVE_FOLDER_NOT_PICKED: '置き場所のフォルダが使えなくなっています。AI にもう一度頼んでください。',
  DRIVE_FILE_REFUSED: 'このファイルは上書きできません（消されたか、移されたか、直す権限がありません）。',
  DRIVE_FILE_FIXED: 'このファイルは決めたことや添付の根拠として記録されているため、上書きしません。',
  DRIVE_FILE_NOT_VERIFIABLE: 'Google Drive で直されていないか確かめられないため、上書きしていません。少し待ってからもう一度お試しください。',
  GOOGLE_UNAVAILABLE: 'Google Drive とやりとりできませんでした。少し待ってからもう一度お試しください。',
  GOOGLE_CONSENT_NEEDED: 'Google Drive を使う許可が切れています。「設定」→「Google」から許可し直してください。',
  GOOGLE_STOPPED: 'この会社では、いま Google につなげません。',
}

/** The answer of `google:decideDriveOverwrite` (made with the member's session in main). */
export type DriveOverwriteDecisionResult =
  | { success: true; state: 'written'; link: string | null; commentsMayMove: boolean; notLinked?: boolean }
  | { success: true; state: 'unknown' }
  | { success: true; state: 'declined' }
  | { success: false; offline: boolean; code: string | null; error: string }

/** What the card shows after a press: written / declined (the buttons go), or a refusal (they stay; the person may try again). */
export type DriveOverwriteOutcome = { kind: 'written' | 'unknown' | 'declined' | 'error'; text: string }

export function driveOverwriteOutcome(result: DriveOverwriteDecisionResult | null | undefined): DriveOverwriteOutcome {
  if (!result) return { kind: 'error', text: DRIVE_OVERWRITE_WORDS.offline }
  if (!result.success) return { kind: 'error', text: result.offline ? DRIVE_OVERWRITE_WORDS.offline : result.error }
  if (result.state === 'declined') return { kind: 'declined', text: DRIVE_OVERWRITE_WORDS.declined }
  if (result.state === 'unknown') return { kind: 'unknown', text: DRIVE_OVERWRITE_WORDS.unknown }
  const text = DRIVE_OVERWRITE_WORDS.written + (result.commentsMayMove ? DRIVE_OVERWRITE_WORDS.comments : '') + (result.notLinked ? DRIVE_OVERWRITE_WORDS.notLinked : '')
  return { kind: 'written', text }
}
