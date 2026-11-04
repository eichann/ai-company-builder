// Meetings for their attendees (minutes.md "Meetings for their attendees", design §4-5): what the
// task list's banner says for one meeting, in the member's words. Pure.
import type { AiTurnItemView } from '../../../shared/ai-turns'
import type { MeetingArrivalView } from '../../../shared/minutes-app'

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** 「今日 12:00」「昨日 15:00」「11/2 15:00」 in the member's clock ('' when unknown). */
export function meetingWhen(iso: string | null, now: number): string {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const time = `${d.getHours()}:${pad(d.getMinutes())}`
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(d) === dayKey(today)) return `今日 ${time}`
  if (dayKey(d) === dayKey(yesterday)) return `昨日 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/** 「今日 12:00・4人」: when, and how many of the company may see it. */
export function meetingPeopleWords(item: Pick<MeetingArrivalView, 'meetingAt' | 'attendeeCount'>, now: number): string {
  const when = meetingWhen(item.meetingAt, now)
  const people = item.attendeeCount > 0 ? `${item.attendeeCount}人` : ''
  return [when, people].filter(Boolean).join('・')
}

/** 「決めたこと2・やることの案3」 */
export function madeWords(made: MeetingArrivalView['made']): string {
  return `決めたこと${made?.decisions ?? 0}・やることの案${made?.proposals ?? 0}`
}

export type MeetingBanner =
  /** 「議事録が届きました」 with ［AI に読ませる］［読まない］ (`failedBefore`: the AI could not read it last time). */
  | { kind: 'arrived'; failedBefore: boolean }
  /**
   * 「AI が読んでいます…」. `auto`: the member's own 「次から自動で読む」 series asked it; `reader`: another
   * attendee's AI reads it (their name); `canSkip`: still waiting for this member's AI (［読まない］ =
   * 今回だけ); `problem`: this PC's AI cannot start it, in words (with 「もう一度」 when it may).
   */
  | { kind: 'reading'; auto: boolean; reader: string | null; canSkip: boolean; problem: { reason: string; canRetry: boolean } | null }
  /** 「読み終わりました」 with ［見る］ and ×. */
  | { kind: 'read' }
  /** 「〇〇さんが読まないにしました」 (another attendee chose it). */
  | { kind: 'skipped'; by: string }

/**
 * The banner of one meeting of the last days, or null. `closed`: the member closed its 「読み終わりました」
 * (this PC); `hidden`: they just chose ［読まない］ (gone at once, while 元に戻す is offered);
 * `ai`: where the automatic runner has it on this PC.
 */
export function meetingBanner(item: MeetingArrivalView, ctx: { closed: boolean; hidden: boolean; ai?: AiTurnItemView }): MeetingBanner | null {
  if (ctx.hidden) return null
  switch (item.status) {
    case 'arrived':
    case 'failed':
      return { kind: 'arrived', failedBefore: item.status === 'failed' }
    case 'asked':
    case 'reading': {
      const stuck = item.byYou && ctx.ai && (ctx.ai.state === 'not-allowed' || ctx.ai.state === 'failed' || (ctx.ai.state === 'handed' && ctx.ai.reason !== ''))
      return {
        kind: 'reading',
        auto: item.byYou && item.autoSeries,
        reader: item.byYou ? null : (item.by?.displayName || null),
        canSkip: item.byYou && item.status === 'asked',
        problem: stuck && ctx.ai ? { reason: ctx.ai.reason, canRetry: ctx.ai.canRetry } : null,
      }
    }
    case 'read':
      return ctx.closed ? null : { kind: 'read' }
    case 'skipped':
      return item.byYou ? null : { kind: 'skipped', by: item.by?.displayName || '参加者' }
  }
}
