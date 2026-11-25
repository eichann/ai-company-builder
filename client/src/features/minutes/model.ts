// Meetings for their attendees (minutes.md "Meetings for their attendees", design §4-5): what the
// inbox's row says for one meeting (the banner on やること before 2026-11-26), in the member's words. Pure.
import type { AiTurnItemView } from '../../../shared/ai-turns'
import type { InviteSet, MeetingArrivalView, MeetingInviteChoicesResult } from '../../../shared/minutes-app'
import type { MeetingNews } from '../../../shared/notifications-app'

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

/** The server looks 3 days back for meetings (minutes.md): one still waiting says so from its second day on. */
export const MEETING_EXPIRES_SOON_MS = 2 * 24 * 60 * 60 * 1000
export const MEETING_EXPIRES_SOON_WORDS = 'あと1日で読めなくなります'

/**
 * One meeting of the last days as the inbox's row (owner decision 2026-11-26: the banner on やること is gone, its rows
 * live in the inbox), or null when it has none (hidden after the member's own ［読まない］). `closed`: its
 * 「読み終わりました」 was looked at on this PC — a `read` row then stays findable as seen, never new again.
 */
export function meetingNewsOf(item: MeetingArrivalView, banner: MeetingBanner | null, ctx: { now: number; closed: boolean; decisionsOn?: boolean }): MeetingNews | null {
  if (!banner) return null
  const at = item.meetingAt ? Date.parse(item.meetingAt) : NaN
  const base = { id: item.recordId, title: item.title, meetingAt: item.meetingAt, seen: false }
  // Only what still waits to be read can run out; a finished reading stays in the meeting's card.
  const soon = (waits: boolean) => waits && !Number.isNaN(at) && ctx.now - at >= MEETING_EXPIRES_SOON_MS
  switch (banner.kind) {
    case 'arrived':
      // The badge says it arrived; the line says what the press does (or why it is offered again).
      return { ...base, stage: 'arrived', line: banner.failedBefore ? '前回は AI が読めませんでした。もう一度読ませられます' : `AI に読ませると、${ctx.decisionsOn === false ? '' : '決めたことと'}やることの案を作ります`, expiresSoon: soon(true) }
    case 'reading':
      return { ...base, stage: 'reading', line: banner.problem ? banner.problem.reason : readingWords(banner), expiresSoon: soon(banner.waiting) }
    case 'read':
      return { ...base, stage: 'read', line: `読み終わりました：${madeWords(item.made, ctx.decisionsOn)}`, expiresSoon: false, seen: ctx.closed }
    case 'skipped':
      return { ...base, stage: 'skipped', line: `${banner.by}さんが読まないにしました`, expiresSoon: false }
  }
}

/**
 * One row per meeting: the arrivals' rows first; a meeting also in the task list's turns (a department without the list)
 * keeps the arrival's look unless the list says this PC's AI stopped on it, and gains the list's buttons it lacks.
 */
export function mergeMeetingRows<R extends MeetingNews & { actions: Array<{ label: string }> }>(arrivals: readonly R[], turns: readonly R[]): R[] {
  const out = new Map<string, R>(arrivals.map(r => [r.id, r]))
  for (const t of turns) {
    const a = out.get(t.id)
    if (!a) { out.set(t.id, t); continue }
    const base = t.stage === 'stopped' ? { ...t, meetingAt: a.meetingAt } : a
    // One way to set it aside: the arrival's ［読まない］ (with its 元に戻す) wins over the list's ［今は読まない］.
    const skips = a.actions.some(x => x.label === '読まない')
    const extra = t.actions.filter(x => !a.actions.some(y => y.label === x.label) && !(skips && x.label === '今は読まない'))
    out.set(t.id, { ...base, actions: [...a.actions, ...extra] })
  }
  return [...out.values()]
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
