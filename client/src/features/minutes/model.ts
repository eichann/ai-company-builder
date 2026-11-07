// Meetings for their attendees (minutes.md "Meetings for their attendees", design §4-5): what the
// task list's banner says for one meeting, in the member's words. Pure.
import type { AiTurnItemView } from '../../../shared/ai-turns'
import type { InviteSet, MeetingArrivalView, MeetingInviteChoicesResult } from '../../../shared/minutes-app'

type InviteChoices = Extract<MeetingInviteChoicesResult, { success: true }>

/** A group or a department on a members-only list, in the member's words. */
export function inviteSetLabel(set: InviteSet, name: string): string {
  return set.type === 'group' ? `「${name}」の人` : `${name}に所属する人`
}

/**
 * What ［招待する］ offers besides people: the groups and departments the server says the member may
 * add (none unless `maySets`), less those already on the list.
 */
export function offeredSets(choices: InviteChoices | null): Array<InviteSet & { label: string }> {
  if (!choices?.maySets) return []
  return [
    ...choices.groups.map(g => ({ type: 'group' as const, id: g.id, label: inviteSetLabel({ type: 'group', id: g.id }, g.name) })),
    ...choices.departments.map(d => ({ type: 'department' as const, id: d.id, label: inviteSetLabel({ type: 'department', id: d.id }, d.name) })),
  ].filter(s => !choices.listed.some(l => l.type === s.type && l.id === s.id))
}

/** What ［招待する］ added, in the member's words (already on it: nothing new to say). */
export function invitedText(
  added: readonly string[], addedSets: readonly InviteSet[], members: ReadonlyArray<{ id: string; name: string }>, choices: InviteChoices | null,
): string {
  const people = added.map(id => members.find(p => p.id === id)?.name ?? '').filter(Boolean).map(n => `${n}さん`)
  const sets = addedSets.map(s => {
    const name = (s.type === 'group' ? choices?.groups : choices?.departments)?.find(x => x.id === s.id)?.name ?? ''
    return name === '' ? '' : inviteSetLabel(s, name)
  }).filter(Boolean)
  const all = [...people, ...sets]
  return all.length > 0 ? `${all.join('、')}を招待しました。` : '選んだ人は、もうこの会議を見られます。'
}

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

/**
 * A row's 「定例ミーティング・今日 12:00」. No count here: the number of people ACB knows on a meeting
 * is not how many attended (the card says what it counts, `meetingSeenWords`).
 */
export function meetingRowWords(item: Pick<MeetingArrivalView, 'title' | 'meetingAt'>, now: number): string {
  return [item.title, meetingWhen(item.meetingAt, now)].filter(Boolean).join('・')
}

/** Rows shown above the list; the rest fold behind 「ほか N 件」, so a first discovery never takes over the pane. */
export const MEETING_ROWS_SHOWN = 2

export function foldMeetings<T>(rows: readonly T[]): { shown: readonly T[]; folded: readonly T[] } {
  return { shown: rows.slice(0, MEETING_ROWS_SHOWN), folded: rows.slice(MEETING_ROWS_SHOWN) }
}

/** The folded rows ［まとめて読まない］ acts on: the ones still offering ［読まない］ as arrived. */
export function skippableMeetings<T extends { banner: MeetingBanner }>(folded: readonly T[]): T[] {
  return folded.filter(r => r.banner.kind === 'arrived')
}

/** 「決めたこと2・やることの案3」; 「やることの案3」 while 決めたこと is turned off (「使う機能」). */
export function madeWords(made: MeetingArrivalView['made'], decisionsOn = true): string {
  const proposals = `やることの案${made?.proposals ?? 0}`
  return decisionsOn ? `決めたこと${made?.decisions ?? 0}・${proposals}` : proposals
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
