/**
 * 「定期の仕事」's form (jobs.md "The screens", PR 4): what the page lets an owner / admin choose, turned
 * into a definition the shared parser (`parseJobDefinition`, the server's own) accepts — never a second
 * copy of its rules. The form makes the server's operation only (a やること for the responsible person,
 * placement `e`, no AI): a PC job (a Skill as the procedure) waits for PR 5's claim and is shown, not edited.
 */
import { JOB_NAME_MAX, JOB_TASK_TITLE_MAX, parseJobDefinition, type JobDefinition, type JobDefinitionResult, type JobGrant, type JobWeekday } from '../../../shared/core/jobs'

export interface JobForm {
  name: string
  actingUser: string
  every: 'day' | 'week' | 'month'
  hour: string
  minute: string
  businessDaysOnly: boolean
  weekday: JobWeekday
  businessDaysBefore: number
  monthDay: number | 'last'
  ifHoliday: 'as_is' | 'before' | 'after'
  taskTitle: string
  /** null: no due. */
  dueBusinessDays: number | null
  missedPolicy: 'latest_only' | 'skip'
  expiresAfterMinutes: number
  /** Kept from the version being edited (the form does not offer it); a new job's are `NEW_JOB_LIMITS`. */
  limits: JobGrant['limits']
}

/** The server's operation runs once per slot and takes no AI time: the smallest limits. */
export const NEW_JOB_LIMITS: JobGrant['limits'] = { minutes: 5, runsPerDay: 1 }

export const JOB_HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))
/** The server clock runs every 5 minutes: a time is on a 5-minute step. */
export const JOB_MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))

/** How long a missed occurrence may still run (5 minutes – 7 days). */
export const JOB_EXPIRY_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 30, label: '30分' },
  { minutes: 60, label: '1時間' },
  { minutes: 180, label: '3時間' },
  { minutes: 360, label: '6時間' },
  { minutes: 720, label: '12時間' },
  { minutes: 1440, label: '1日' },
  { minutes: 4320, label: '3日' },
  { minutes: 10080, label: '7日' },
]

export function emptyJobForm(actingUser: string): JobForm {
  return {
    name: '', actingUser, every: 'week', hour: '09', minute: '00', businessDaysOnly: true, weekday: 'mon', businessDaysBefore: 0,
    monthDay: 1, ifHoliday: 'before', taskTitle: '', dueBusinessDays: 1, missedPolicy: 'latest_only', expiresAfterMinutes: 720,
    limits: NEW_JOB_LIMITS,
  }
}

/** The form for a version, or null when this form cannot edit it (a PC job). */
export function formFromDefinition(d: JobDefinition): JobForm | null {
  if (d.run.kind !== 'operation' || d.placement !== 'e') return null
  const [hour, minute] = d.trigger.at.split(':')
  const base = emptyJobForm(d.actingUser)
  const t = d.trigger
  return {
    ...base,
    name: d.name, hour, minute, every: t.every,
    businessDaysOnly: t.every === 'day' ? t.businessDaysOnly : base.businessDaysOnly,
    weekday: t.every === 'week' ? t.weekday : base.weekday,
    businessDaysBefore: t.every === 'week' ? t.businessDaysBefore : base.businessDaysBefore,
    monthDay: t.every === 'month' ? t.day : base.monthDay,
    ifHoliday: t.every === 'month' ? t.ifHoliday : base.ifHoliday,
    taskTitle: d.run.title, dueBusinessDays: d.run.dueBusinessDays,
    missedPolicy: d.missed.policy, expiresAfterMinutes: d.missed.expiresAfterMinutes, limits: d.grant.limits,
  }
}

/** The definition the form says, checked by the shared parser (the server checks it again). */
export function definitionFromForm(f: JobForm): JobDefinitionResult {
  const at = `${f.hour}:${f.minute}`
  const trigger = f.every === 'day'
    ? { every: 'day', at, businessDaysOnly: f.businessDaysOnly }
    : f.every === 'week'
      ? { every: 'week', weekday: f.weekday, at, businessDaysBefore: f.businessDaysBefore }
      : { every: 'month', day: f.monthDay, at, ifHoliday: f.ifHoliday }
  return parseJobDefinition({
    schema: 1,
    name: f.name.normalize('NFC').trim(),
    actingUser: f.actingUser,
    trigger,
    check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: f.taskTitle.normalize('NFC').trim(), dueBusinessDays: f.dueBusinessDays },
    placement: 'e',
    missed: { policy: f.missedPolicy, expiresAfterMinutes: f.expiresAfterMinutes },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: f.limits },
  })
}

/** What to tell the person about the parser's problem codes (never the value). */
export function jobProblemText(problems: string[]): string {
  if (problems.includes('name.BAD')) return `名前を入れてください（${JOB_NAME_MAX}文字まで、改行なし）。`
  if (problems.includes('run.title.BAD')) return `作るやることの名前を入れてください（${JOB_TASK_TITLE_MAX}文字まで、改行なし）。`
  if (problems.includes('actingUser.BAD') || problems.includes('actingUser.NOT_MEMBER')) return '責任者を選んでください（この会社のメンバー）。'
  return '内容に正しくないところがあります。選び直してください。'
}
