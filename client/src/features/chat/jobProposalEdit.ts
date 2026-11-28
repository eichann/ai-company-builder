// 「定期の仕事の案」 changed in place (UX 段3 #13, owner decisions 2026-11-28 「12・13番」; jobs.md "Member proposals" "The
// card changed in place"): the lists the card offers — the same kinds of values the AI chooses from (`JobCandidateInput`),
// never free text — and what a change says once the server has checked it. Pure: the card sends the whole input, the server
// rebuilds and checks it (the place, the Skill, the name).
import { isJobCandidatePlace, type JobCandidateInput } from '../../../../shared/core/job-proposals'
import { JOB_WEEKDAYS, type JobTimeTrigger, type JobWeekday } from '../../../../shared/core/jobs'
import { JOB_WEEKDAY_WORDS, jobMinutesText } from '../../../../shared/core/job-words'
import { isValidSkillName } from '../../../../shared/core/names'

export interface EditChoice { value: string; label: string }

export const EVERY_CHOICES: readonly EditChoice[] = [{ value: 'day', label: '毎日' }, { value: 'week', label: '毎週' }, { value: 'month', label: '毎月' }]
export const WEEKDAY_CHOICES: readonly EditChoice[] = JOB_WEEKDAYS.map(w => ({ value: w, label: JOB_WEEKDAY_WORDS[w] }))
export const MONTH_DAY_CHOICES: readonly EditChoice[] = [...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` })), { value: 'last', label: '末日' }]
export const DAY_KIND_CHOICES: readonly EditChoice[] = [{ value: 'all', label: '毎日' }, { value: 'business', label: '営業日だけ' }]
export const CHECK_KIND_CHOICES: readonly EditChoice[] = [{ value: 'new_files', label: '新しいファイルがあるとき' }, { value: 'new_meetings', label: 'あなたが出た会議があるとき' }]
export const MAIL_CHOICES: readonly EditChoice[] = [{ value: 'yes', label: '下書きまで作る（送るのは人）' }, { value: 'no', label: '作らない' }]
export const RECORDS_CHOICES: readonly EditChoice[] = [{ value: 'yes', label: '読む' }, { value: 'no', label: '読まない' }]
export const MISSED_CHOICES: readonly EditChoice[] = [{ value: 'latest_only', label: '一番新しい回だけ動く' }, { value: 'skip', label: '見送る' }]
/** The deliverable's choice that writes nothing. */
export const NO_DELIVERABLE = ''

const MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120]

/** A time on 30 minutes (the trigger takes 5); a time already chosen off that step stays among them. */
export function atChoices(current: string): EditChoice[] {
  const all = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`)
  if (!all.includes(current)) all.push(current)
  return all.sort().map(v => ({ value: v, label: v }))
}

export function minutesChoices(current: number): EditChoice[] {
  const all = MINUTES.includes(current) ? MINUTES : [...MINUTES, current].sort((a, b) => a - b)
  return all.map(m => ({ value: String(m), label: jobMinutesText(m) }))
}

/** Another 「毎日／毎週／毎月」: the time kept, the rest the plainest of that kind. */
export function triggerWithEvery(t: JobTimeTrigger, every: string): JobTimeTrigger {
  if (every === t.every) return t
  if (every === 'day') return { every: 'day', at: t.at, businessDaysOnly: false }
  if (every === 'week') return { every: 'week', weekday: 'mon', at: t.at, businessDaysBefore: 0 }
  return { every: 'month', day: 1, at: t.at, ifHoliday: 'as_is' }
}

/**
 * The places the card offers: the folders this computer knows (the company folder's, three levels deep, and the
 * departments) and the ones the candidate already names — each a place a candidate may name at all (no hidden or reserved
 * segment), once, in order. Whether the member reads / writes it is the server's to say.
 */
export function placeChoices(known: readonly string[], current: readonly string[]): string[] {
  return [...new Set([...known, ...current])].filter(isJobCandidatePlace).sort((a, b) => a.localeCompare(b, 'ja'))
}

interface FolderNode { name: string; isDirectory: boolean; path: string; children?: FolderNode[] }

/** The folders of a `readDirectoryTree` answer as company paths (`営業部/週報`), hidden ones and their insides left out. */
export function foldersOf(nodes: readonly FolderNode[], prefix = '', depth = 0): string[] {
  if (depth >= 3) return []
  return nodes.filter(n => n.isDirectory && !n.name.startsWith('.')).flatMap(n => {
    const place = prefix ? `${prefix}/${n.name}` : n.name
    return isJobCandidatePlace(place) ? [place, ...foldersOf(n.children ?? [], place, depth + 1)] : []
  })
}

/** Company Skills by their folder names (the AI names one the same way), the current one kept. */
export function skillChoices(entries: ReadonlyArray<{ name: string; isDirectory: boolean }>, current: string): string[] {
  return [...new Set([current, ...entries.filter(e => e.isDirectory && isValidSkillName(e.name)).map(e => e.name)])].sort()
}

/** One order of every field, so two inputs compare whatever order their keys came in. */
export function inputKey(i: JobCandidateInput): string {
  const t = i.trigger
  const trigger = t.every === 'day' ? [t.every, t.at, t.businessDaysOnly] : t.every === 'week' ? [t.every, t.weekday, t.at, t.businessDaysBefore] : [t.every, t.day, t.at, t.ifHoliday]
  return JSON.stringify([i.skill, trigger, i.check.kind, i.check.kind === 'new_files' ? i.check.path : null, i.reads, i.deliverable,
    i.readRecords, i.mailDrafts, i.minutes, i.missed.policy, i.missed.expiresAfterMinutes])
}
export const sameInput = (a: JobCandidateInput, b: JobCandidateInput) => inputKey(a) === inputKey(b)

const whenWord = (t: JobTimeTrigger) => t.every === 'day' ? '毎日' : t.every === 'week' ? '毎週' : '毎月'
const yesNo = (v: boolean) => v ? '読む' : '読まない'
const dayWord = (d: number | 'last') => d === 'last' ? '末日' : `${d}日`
const place = (p: string | null) => p === null ? '置かない' : `「${p}」`

/** What one change was (「曜日：月曜 → 火曜」), from the input shown before and the one sent; the first difference, by the card's order. */
export function changeText(before: JobCandidateInput, after: JobCandidateInput): string {
  const a = before.trigger, b = after.trigger
  if (a.every !== b.every) return `いつ：${whenWord(a)} → ${whenWord(b)}`
  if (a.every === 'week' && b.every === 'week' && a.weekday !== b.weekday) return `曜日：${JOB_WEEKDAY_WORDS[a.weekday]} → ${JOB_WEEKDAY_WORDS[b.weekday as JobWeekday]}`
  if (a.every === 'month' && b.every === 'month' && a.day !== b.day) return `日：${dayWord(a.day)} → ${dayWord(b.day)}`
  if (a.every === 'day' && b.every === 'day' && a.businessDaysOnly !== b.businessDaysOnly) return `日：${a.businessDaysOnly ? '営業日だけ' : '毎日'} → ${b.businessDaysOnly ? '営業日だけ' : '毎日'}`
  if (a.at !== b.at) return `時刻：${a.at} → ${b.at}`
  if (before.check.kind !== after.check.kind) return `何があったら動くか：${after.check.kind === 'new_files' ? '新しいファイル' : 'あなたが出た会議'}`
  if (before.check.kind === 'new_files' && after.check.kind === 'new_files' && before.check.path !== after.check.path) return `確かめる場所：「${before.check.path}」 → 「${after.check.path}」`
  if (before.skill !== after.skill) return `Skill：「${before.skill}」 → 「${after.skill}」`
  const added = after.reads.filter(r => !before.reads.includes(r))
  const removed = before.reads.filter(r => !after.reads.includes(r))
  if (added.length > 0) return `読む場所：「${added[0]}」を足しました`
  if (removed.length > 0) return `読む場所：「${removed[0]}」を外しました`
  if (before.deliverable !== after.deliverable) return `置く場所：${place(before.deliverable)} → ${place(after.deliverable)}`
  if (before.readRecords !== after.readRecords) return `やることや記録：${yesNo(before.readRecords)} → ${yesNo(after.readRecords)}`
  if (before.mailDrafts !== after.mailDrafts) return `メール：${after.mailDrafts ? '下書きまで作る' : '作らない'}`
  if (before.minutes !== after.minutes) return `1回の時間：${jobMinutesText(before.minutes)} → ${jobMinutesText(after.minutes)}`
  if (before.missed.policy !== after.missed.policy) return `動けなかった回：${after.missed.policy === 'skip' ? '見送る' : '一番新しい回だけ動く'}`
  return '内容'
}
