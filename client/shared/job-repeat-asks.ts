/**
 * 「毎週同じ時間にやりましょうか？」 (jobs.md "Member proposals" "Asking after repeats (PR D)", owner memo 2026-11-22 例2 /
 * Q3): after a member has had the same work done on 3 different days, their AI asks once whether to make it a time job.
 *
 * - **The same work** = the same company Skill the AI loaded (Claude Code's `Skill` tool, `skillLoadedBy`) in a consultation
 *   the member is in where the job proposal tools are offered. No free text is compared.
 * - **Counted** in distinct days (this PC's local date): several uses on one day count once.
 * - **Asked once**: a turn whose prompt carries the question for a Skill, and in which the AI loads that Skill, marks it
 *   asked for good (whether or not the AI asked, whatever the member answered).
 * - **Kept only on this PC**, per member and company: Skill folder names and dates, never a conversation, text or path.
 *
 * Pure: the store and the turn's wiring are `electron/features/jobs/repeat-asks.ts`.
 */
import { isSkillUseName } from '../../shared/core/skill-uses'

/** Distinct days of use before the AI asks (owner decision Q3: 3). */
export const JOB_REPEAT_ASK_DAYS = 3
/** At most this many Skills are named in one turn's question. */
export const JOB_REPEAT_ASK_PER_TURN = 3
/** Skills counted per member and company (the least recently used goes first beyond it). */
export const JOB_REPEAT_SKILLS_MAX = 100
/** Asked marks kept per member and company (never dropped below this; beyond it the oldest go). */
export const JOB_REPEAT_ASKED_MAX = 500

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** One Skill's count: the distinct days (newest last, at most `JOB_REPEAT_ASK_DAYS`), or asked for good. */
export type RepeatSkill = { days: string[] } | { asked: string }

export interface RepeatMember {
  /** 「AI から定期の仕事を提案してもらう」 turned off: nothing is counted or asked. */
  off?: true
  skills: Record<string, RepeatSkill>
}

export interface RepeatFile {
  version: 1
  /** Keyed by `repeatMemberKey`. */
  members: Record<string, RepeatMember>
}

/** 「AI から定期の仕事を提案してもらう」 as main answers it (IPC `jobRepeatAsks:get` / `set`); false = not known / not saved. */
export type JobRepeatAskSetting = { success: true; on: boolean } | { success: false }

export const emptyRepeatFile = (): RepeatFile => ({ version: 1, members: {} })

export function repeatMemberKey(userId: string, companyId: string): string {
  return `${encodeURIComponent(userId)}/${encodeURIComponent(companyId)}`
}

/** This PC's local date, `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

/**
 * The stored file, read strictly: anything not of the shape (an unknown key, a name that is no Skill folder name, a
 * date of another form) is left out, so the file can only ever carry Skill names and dates. null = not this file at all.
 */
export function readRepeatFile(raw: unknown): RepeatFile | null {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return null
  const members = (raw as { members?: unknown }).members
  if (!members || typeof members !== 'object' || Array.isArray(members)) return null
  const out = emptyRepeatFile()
  for (const [key, value] of Object.entries(members as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || !/^[^/]+\/[^/]+$/.test(key)) continue
    const member: RepeatMember = { skills: {} }
    if ((value as { off?: unknown }).off === true) member.off = true
    const skills = (value as { skills?: unknown }).skills
    if (skills && typeof skills === 'object' && !Array.isArray(skills)) {
      for (const [name, s] of Object.entries(skills as Record<string, unknown>)) {
        if (!isSkillUseName(name) || !s || typeof s !== 'object') continue
        const asked = (s as { asked?: unknown }).asked
        const days = (s as { days?: unknown }).days
        if (typeof asked === 'string' && DAY_RE.test(asked)) member.skills[name] = { asked }
        else if (Array.isArray(days)) {
          const kept = [...new Set(days.filter((d): d is string => typeof d === 'string' && DAY_RE.test(d)))].sort().slice(-JOB_REPEAT_ASK_DAYS)
          if (kept.length > 0) member.skills[name] = { days: kept }
        }
      }
    }
    out.members[key] = member
  }
  return out
}

/**
 * A Skill's entry, only when it is the member's own: a Skill folder name may be an `Object.prototype` name (`constructor`),
 * which a plain lookup would answer with what the object inherits.
 */
function ownSkill(member: RepeatMember, skill: string): RepeatSkill | undefined {
  return Object.prototype.hasOwnProperty.call(member.skills, skill) ? member.skills[skill] : undefined
}

const lastDay = (s: RepeatSkill) => ('asked' in s ? s.asked : s.days[s.days.length - 1] ?? '')

/** Keeps a member's entries within the limits (the least recently used counted Skill, then the oldest asked mark go first). */
function bounded(member: RepeatMember): RepeatMember {
  const entries = Object.entries(member.skills)
  const counted = entries.filter(([, s]) => !('asked' in s)).sort((a, b) => lastDay(b[1]).localeCompare(lastDay(a[1]))).slice(0, JOB_REPEAT_SKILLS_MAX)
  const asked = entries.filter(([, s]) => 'asked' in s).sort((a, b) => lastDay(b[1]).localeCompare(lastDay(a[1]))).slice(0, JOB_REPEAT_ASKED_MAX)
  return { ...(member.off ? { off: true as const } : {}), skills: Object.fromEntries([...asked, ...counted]) }
}

/** A use of `skill` on `day`: one more distinct day (the same day again changes nothing); an asked Skill stays asked. */
export function noteRepeatUse(member: RepeatMember, skill: string, day: string): RepeatMember {
  if (member.off || !isSkillUseName(skill) || !DAY_RE.test(day)) return member
  const s = ownSkill(member, skill)
  if (s && 'asked' in s) return member
  const days = s ? s.days : []
  if (days.includes(day)) return member
  return bounded({ ...member, skills: { ...member.skills, [skill]: { days: [...days, day].sort().slice(-JOB_REPEAT_ASK_DAYS) } } })
}

/** Asked for good (the question went with a turn that loaded the Skill). */
export function markRepeatAsked(member: RepeatMember, skill: string, day: string): RepeatMember {
  if (!isSkillUseName(skill) || !DAY_RE.test(day)) return member
  return bounded({ ...member, skills: { ...member.skills, [skill]: { asked: day } } })
}

/**
 * The Skills a turn on `day` may ask about: not asked yet, used on enough **other** days that loading it in this turn
 * makes `JOB_REPEAT_ASK_DAYS` distinct days, and `usable` here (a company Skill this consultation reaches) — checked
 * **before** the cap, so Skills removed or out of reach never take the places. Most recently used first, at most
 * `JOB_REPEAT_ASK_PER_TURN`. None while off.
 */
export function repeatAskable(member: RepeatMember | undefined, day: string, usable: (skill: string) => boolean = () => true): string[] {
  if (!member || member.off) return []
  return Object.entries(member.skills)
    .filter(([name, s]) => !('asked' in s) && s.days.filter(d => d !== day).length >= JOB_REPEAT_ASK_DAYS - 1 && usable(name))
    .sort((a, b) => lastDay(b[1]).localeCompare(lastDay(a[1])))
    .slice(0, JOB_REPEAT_ASK_PER_TURN)
    .map(([name]) => name)
}

/** The question the member reads (the owner's wording, memo 例2; owner decision pending on changes). */
export const JOB_REPEAT_ASK_QUESTION = 'この仕事は、これまでにも何度か同じように頼まれています。毎週（または毎日・毎月）同じ時間に、定期の仕事としてやりましょうか？'

/** The turn's instruction for the Skills `repeatAskable` named (empty for none). Names are Skill folder names only. */
export function repeatAskInstructions(skills: readonly string[]): string {
  const named = skills.filter(isSkillUseName)
  if (named.length === 0) return ''
  const list = named.map(s => `「${s}」`).join('・')
  return '\n\n【定期の仕事にするか、1回だけ聞く】' +
    `この返事の中で、メンバーに頼まれた仕事のために Skill ツールで ${list} のどれかを使い、その仕事を終えたときだけ、` +
    '返事の最後に1回だけ、使った Skill について' +
    `「${JOB_REPEAT_ASK_QUESTION}」と短く聞いてください。` +
    'この指示のために Skill を使わないでください。この返事でそれらの Skill を使わなかったときは、このことに一切ふれないでください。' +
    '聞くのはこの返事だけで、二度と同じことは聞きません。' +
    'メンバーが「はい」と言ったら、いつ・何があったら動くかを確かめてから job_proposal_places と job_proposal_create で定期の仕事の案を作ってください（出すのはメンバーがカードで押したときだけ）。' +
    '「いいえ」や、ほかの話を続けたときは、それ以上すすめないでください。' +
    '\n[Ask once] Only if, for the work the member asked for, you load one of these Skills with the Skill tool in this reply and finish that work: ' +
    'at the end of the reply, ask once, briefly, ' +
    'whether to make it a regular time job. Never load a Skill for this instruction. Otherwise do not mention it. Never ask again. On "yes", confirm when and what makes it run, then make a candidate ' +
    'with job_proposal_places / job_proposal_create; on "no" drop it.'
}
