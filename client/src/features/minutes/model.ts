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
   * 「AI が読んでいます…」. `auto`: why the member's own AI was asked without a press — their
   * 「次から自動で読む」 series, or their 「届いた議事録を AI が自動で読む」 setting; `reader`: another
   * attendee's AI reads it (their name), `waiting` while it has not started (their PC may be closed:
   * 「〇〇さんの AI が読む予定」, owner decision D1-3); `canSkip`: still waiting for this member's AI
   * (［読まない］ = 今回だけ); `problem`: this PC's AI cannot start it, in words (with 「もう一度」 when it may);
   * `organiser`: that reader is the meeting's organiser (「（主催）」); `canRead`: only the clock asked it for
   * another attendee and it has not started, so this member's own ［AI に読ませる］ takes it (server 2026-11-25).
   */
  | { kind: 'reading'; auto: 'series' | 'setting' | null; reader: string | null; organiser: boolean; waiting: boolean; canSkip: boolean; canRead: boolean; problem: { reason: string; canRetry: boolean } | null }
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
        auto: !item.byYou ? null : item.autoSeries ? 'series' : item.askedAutomatically ? 'setting' : null,
        reader: item.byYou ? null : (item.by?.displayName || null),
        organiser: !item.byYou && item.byOrganiser === true,
        waiting: item.status === 'asked',
        canSkip: item.byYou && item.status === 'asked',
        // Another person's own press is never taken (409), and an older server says nothing of who asked.
        canRead: !item.byYou && item.status === 'asked' && item.askedAutomatically === true,
        problem: stuck && ctx.ai ? { reason: ctx.ai.reason, canRetry: ctx.ai.canRetry } : null,
      }
    }
    case 'read':
      return ctx.closed ? null : { kind: 'read' }
    case 'skipped':
      return item.byYou ? null : { kind: 'skipped', by: item.by?.displayName || '参加者' }
  }
}

/** The line of a meeting the AI reads (or will), in the member's words. */
export function readingWords(banner: Extract<MeetingBanner, { kind: 'reading' }>): string {
  if (banner.auto === 'series') return '自動で読む定例です。AI が読んでいます…'
  if (banner.auto === 'setting') return '自動で読む設定のため、AI が読んでいます…'
  // Not a promise of one person: after a while another attendee's AI with the setting on may take it.
  if (banner.reader) {
    const who = `${banner.reader}さん${banner.organiser ? '（主催）' : ''}`
    return banner.waiting ? `${who}の AI が読む予定です。しばらく読まれないときは、出ている人の AI が代わりに読みます` : `${who}の AI が読んでいます…`
  }
  return 'AI が読んでいます…'
}

/**
 * The card's 「この定例は：」 choice, in the member's words (`auto` / `off` / null = 設定に従う). Shown
 * only when the server says it (`seriesChoice`); an older server keeps its two buttons.
 */
export const SERIES_CHOICES: ReadonlyArray<{ choice: 'auto' | 'off' | null; label: string }> = [
  { choice: 'auto', label: '自動で読む' },
  { choice: 'off', label: '読まない' },
  { choice: null, label: '設定に従う' },
]
