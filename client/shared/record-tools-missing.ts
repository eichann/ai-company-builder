/**
 * A turn whose company-record tools could not be prepared (records.md "When the record tools are
 * missing", gap report 2026-11-27 Bug A). Before, such a turn went on silently without them, and a
 * Claude conversation that had them on an earlier turn told the member 「この会話から記録の道具に
 * つながっていません」. Now the AI is told one plain sentence with the reason (it rides with the turn),
 * and the reply starts with one line saying the same (`RECORD_TOOLS_MISSING_PART_TYPE`, shown live,
 * not stored with the reply: the AI's own words about it are).
 * Pure: main, the renderer and tests use it.
 */

/** Why the tools are missing. `disabled` is no failure: the company does not use records (no line on screen). */
export type RecordToolsMissingReason = 'offline' | 'signed-out' | 'too-many' | 'old-server' | 'server-error' | 'try-again' | 'unknown' | 'disabled'

const REASONS: Record<RecordToolsMissingReason, { why: string; fix: string }> = {
  offline: { why: 'サーバーにつながりませんでした', fix: 'もう一度送ると直ることが多いです' },
  'signed-out': { why: 'ACB のログインが切れています', fix: 'ログインし直してから、もう一度送ってください' },
  'too-many': { why: '記録の道具を同時に使いすぎています', fix: '1分ほど待ってから、もう一度送ってください' },
  'old-server': { why: '会社のサーバーの版が古く、記録の道具に対応していません', fix: '管理者にサーバーの更新を頼んでください' },
  'server-error': { why: 'サーバーで問題が起きました', fix: 'もう一度送ると直ることが多いです。続くときは管理者に伝えてください' },
  'try-again': { why: '記録の道具の準備が途中で切れました', fix: 'もう一度送ってください' },
  unknown: { why: '用意の途中で問題が起きました', fix: 'もう一度送ると直ることが多いです' },
  disabled: { why: 'この会社では記録の機能を使っていません', fix: '管理者が管理画面の「詳しい設定 › 仕事の進め方」の「記録とやることの一覧を使う」でオンにできます' },
}

export function isRecordToolsMissingReason(value: unknown): value is RecordToolsMissingReason {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REASONS, value)
}

/**
 * What the AI is told on such a turn (it rides with the turn, never the conversation's standing
 * instructions: the next turn may have the tools again).
 */
export function recordToolsMissingInstructions(reason: RecordToolsMissingReason): string {
  const { why, fix } = REASONS[reason]
  if (reason === 'disabled') {
    return `\n\n【会社の記録】${why}。やること・案件・決めたことなどの記録の道具はありません。記録について頼まれたら、「つながっていません」とは言わず、この会社では記録の機能がオフであること（${fix}）を伝えてください。`
  }
  return `\n\n【会社の記録の道具】この回は、会社の記録（やること・案件・決めたことなど）の道具を用意できませんでした（理由：${why}）。前の回で使えた記録の道具が見当たらないのは、このためです。この回は記録を読むことも変えることもできません。記録について頼まれたら、「つながっていません」とだけ言わず、理由と直し方を一言で伝えてください（例：「${why}。${fix}。」）。`
}

/**
 * An action at the member's request after the turn's token was issued again (a turn past the token's life): the new
 * token never carries the member's-turn mark, so the tool says this instead of asking the server (records.md "When the
 * record tools are missing").
 */
export const ASKED_AFTER_RENEWAL = { error: 'この回は長くなったため、頼まれた操作はここではもうできません。もう一度送ってから頼んでください。', code: 'TURN_RENEWED' } as const

/** The chat part that says so at the start of the reply: `{ reason }` (live only; never stored). */
export const RECORD_TOOLS_MISSING_PART_TYPE = 'data-record-tools-missing'
export interface RecordToolsMissingPart { reason: RecordToolsMissingReason }

/** The part as it comes from the stream (anything else is dropped). */
export function readRecordToolsMissingPart(value: unknown): RecordToolsMissingPart | null {
  const reason = (value as { reason?: unknown } | null)?.reason
  return isRecordToolsMissingReason(reason) && reason !== 'disabled' ? { reason } : null
}

/** 「この回は、会社の記録（やること・案件など）の道具なしで答えています。理由：サーバーにつながりませんでした。…」 */
export function recordToolsMissingLine(part: RecordToolsMissingPart): string {
  const { why, fix } = REASONS[part.reason]
  return `この回は、会社の記録（やること・案件など）の道具なしで答えています。理由：${why}。${fix}。`
}
