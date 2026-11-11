/**
 * 「定期の仕事」's form (jobs.md "The screens"): what the page lets an owner / admin choose, turned into a
 * definition the shared parser (`parseJobDefinition`, the server's own) accepts — never a second copy of its
 * rules. Two kinds: the server's operation (a やること for the responsible person, placement `e`, no AI) and,
 * since B PR 5a-2, a PC job (placement `a`): a Skill as the procedure, a check before the AI (new files in a
 * place, or meetings the responsible person attended), and a grant built from a few plain choices. The server
 * fills the pinned Skill's fingerprint (and a shelf Skill's name) itself; the placeholders here only let the
 * parser check the rest.
 */
import {
  JOB_MINUTES_ROUTE, JOB_NAME_MAX, JOB_OUTBOUND_ROUTES, JOB_TASK_TITLE_MAX, JOB_TITLE_WORDS_MAX, parseJobDefinition,
  type JobDefinition, type JobDefinitionResult, type JobGrant, type JobWeekday,
} from '../../../shared/core/jobs'
import { BUILTIN_CONNECTORS, type DeliveryPlaceKind } from '../../../shared/core/builtin-connectors'

export interface JobForm {
  name: string
  actingUser: string
  /** `task`: the server makes a やること (no AI). `pc`: a Skill runs on the responsible person's PC. */
  kind: 'task' | 'pc'
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
  /** The server's operation: kept from the version being edited (not offered); a PC job: its minutes are chosen. */
  limits: JobGrant['limits']
  // A PC job:
  /** A company Skill's folder name (a company with the shared folder). */
  skillName: string
  /** A shelf Skill's item id (a company without it). */
  shelfItem: string
  checkKind: 'new_files' | 'new_meetings'
  /** `new_files`: the place looked at (also read). */
  checkPath: string
  /** `new_meetings`: words a meeting's title must hold (one of them), separated by 、 or spaces; empty = every meeting. */
  titleWords: string
  /** Other places the AI may read, one per line. */
  readPaths: string
  /** May look up the member's own records (やること, 案件…). */
  readRecords: boolean
  /** May make mail drafts (sending is always a person's). */
  mailDrafts: boolean
  /** Where it may save files: `<writePlace>/.personal/<writeFolder>/`; empty folder = it saves nothing. */
  writePlace: string
  writeFolder: string
  /**
   * A place outside where it also puts what it made (`<connector>:<kind>` of a declared place, e.g. a Google Drive
   * folder; jobs.md "A deliverable place outside"); '' = none. The exact place is the responsible person's choice when accepting.
   */
  deliverTo: string
}

/** The places outside a job may put its deliverables into (the connectors' declarations), as the form offers them. */
export const DELIVERY_PLACE_CHOICES: Array<{ value: string; label: string; lapseNote: string }> = Object.values(BUILTIN_CONNECTORS)
  .flatMap(c => (c.deliveryPlaces as readonly DeliveryPlaceKind[]).map(p => ({ value: `${c.id}:${p.kind}`, label: p.label, lapseNote: p.lapseNote })))

/** The server's operation runs once per slot and takes no AI time: the smallest limits. */
export const NEW_JOB_LIMITS: JobGrant['limits'] = { minutes: 5, runsPerDay: 1 }
/** A PC job's run: minutes per run the form offers. */
export const PC_JOB_MINUTES = [5, 10, 15, 30, 60]

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

/** The record reads a PC job's AI may use (the server's ceiling is `JOB_RUN_ROUTE_CEILING`). */
const RECORD_READ_ROUTES = ['GET /my-turn', 'POST /query', 'GET /item/:recordId', 'GET /item/:recordId/history']

export function emptyJobForm(actingUser: string): JobForm {
  return {
    name: '', actingUser, kind: 'task', every: 'week', hour: '09', minute: '00', businessDaysOnly: true, weekday: 'mon', businessDaysBefore: 0,
    monthDay: 1, ifHoliday: 'before', taskTitle: '', dueBusinessDays: 1, missedPolicy: 'latest_only', expiresAfterMinutes: 720,
    limits: NEW_JOB_LIMITS,
    skillName: '', shelfItem: '', checkKind: 'new_files', checkPath: '', titleWords: '', readPaths: '', readRecords: true, mailDrafts: false, writePlace: '', writeFolder: '',
    deliverTo: '',
  }
}

const lines = (text: string) => [...new Set(text.split('\n').map(l => l.normalize('NFC').trim()).filter(Boolean))]
const words = (text: string) => [...new Set(text.normalize('NFC').split(/[、,\s]+/).map(w => w.trim()).filter(Boolean))]

/** The form for a version. */
export function formFromDefinition(d: JobDefinition): JobForm {
  const [hour, minute] = d.trigger.at.split(':')
  const base = emptyJobForm(d.actingUser)
  const t = d.trigger
  const common: JobForm = {
    ...base,
    name: d.name, hour, minute, every: t.every,
    businessDaysOnly: t.every === 'day' ? t.businessDaysOnly : base.businessDaysOnly,
    weekday: t.every === 'week' ? t.weekday : base.weekday,
    businessDaysBefore: t.every === 'week' ? t.businessDaysBefore : base.businessDaysBefore,
    monthDay: t.every === 'month' ? t.day : base.monthDay,
    ifHoliday: t.every === 'month' ? t.ifHoliday : base.ifHoliday,
    missedPolicy: d.missed.policy, expiresAfterMinutes: d.missed.expiresAfterMinutes, limits: d.grant.limits,
  }
  if (d.run.kind === 'operation') return { ...common, kind: 'task', taskTitle: d.run.title, dueBusinessDays: d.run.dueBusinessDays }
  const p = d.run.procedure
  const checkPath = d.check.kind === 'new_files' ? d.check.path : ''
  return {
    ...common, kind: 'pc',
    skillName: p.source === 'company_skill' ? p.skill : '', shelfItem: p.source === 'shelf_skill' ? p.item : '',
    checkKind: d.check.kind === 'new_meetings' ? 'new_meetings' : 'new_files', checkPath,
    titleWords: d.check.kind === 'new_meetings' ? d.check.titleWords.join('、') : '',
    readPaths: d.grant.reads.paths.filter(x => x !== checkPath).join('\n'),
    readRecords: RECORD_READ_ROUTES.some(r => d.grant.routes.includes(r)),
    mailDrafts: d.grant.outbound === 'draft_only',
    writePlace: d.grant.writes.area === 'deliverable' ? d.grant.writes.place : '',
    writeFolder: d.grant.writes.area === 'deliverable' ? d.grant.writes.folder : '',
    deliverTo: d.grant.deliverTo ? `${d.grant.deliverTo.connector}:${d.grant.deliverTo.kind}` : '',
  }
}

/** A PC job's grant from the form's few choices (the parser checks it as for any definition). */
function pcGrant(f: JobForm): JobGrant {
  const reads = [...new Set([...(f.checkKind === 'new_files' ? lines(f.checkPath) : []), ...lines(f.readPaths)])]
  const writes: JobGrant['writes'] = f.writeFolder.trim() ? { area: 'deliverable', place: f.writePlace.normalize('NFC').trim(), folder: f.writeFolder.trim() } : { area: 'none' }
  const tools = ['records', ...(reads.length > 0 ? ['files_read'] : []), ...(writes.area === 'deliverable' ? ['files_write'] : []), ...(f.mailDrafts ? ['outbound_draft'] : [])]
  const routes = [
    ...(f.readRecords ? RECORD_READ_ROUTES : []),
    ...(f.checkKind === 'new_meetings' ? [JOB_MINUTES_ROUTE] : []),
    ...(f.mailDrafts ? JOB_OUTBOUND_ROUTES : []),
  ]
  const [connector, kind] = f.deliverTo.split(':')
  return {
    tools, creates: ['task'], routes, reads: { paths: reads, calls: [] }, writes, outbound: f.mailDrafts ? 'draft_only' : 'none', limits: f.limits,
    // The exact place is chosen by the responsible person when accepting (`ref` null here).
    ...(f.deliverTo ? { deliverTo: { connector, kind, ref: null } } : {}),
  }
}

/**
 * The definition the form says, checked by the shared parser (the server checks it again). A PC job's Skill
 * goes with a placeholder fingerprint: the server reads the pinned one (and a shelf Skill's name) itself.
 */
export function definitionFromForm(f: JobForm, shelfSkillName?: string): JobDefinitionResult {
  const at = `${f.hour}:${f.minute}`
  const trigger = f.every === 'day'
    ? { every: 'day', at, businessDaysOnly: f.businessDaysOnly }
    : f.every === 'week'
      ? { every: 'week', weekday: f.weekday, at, businessDaysBefore: f.businessDaysBefore }
      : { every: 'month', day: f.monthDay, at, ifHoliday: f.ifHoliday }
  const common = {
    schema: 1, name: f.name.normalize('NFC').trim(), actingUser: f.actingUser, trigger,
    missed: { policy: f.missedPolicy, expiresAfterMinutes: f.expiresAfterMinutes },
  }
  if (f.kind === 'task') {
    return parseJobDefinition({
      ...common,
      check: { kind: 'none' },
      run: { kind: 'operation', operation: 'create_task', title: f.taskTitle.normalize('NFC').trim(), dueBusinessDays: f.dueBusinessDays },
      placement: 'e',
      grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: f.limits },
    })
  }
  const procedure = f.shelfItem
    ? { source: 'shelf_skill', item: f.shelfItem, skill: shelfSkillName ?? 'skill', fingerprint: '0'.repeat(64) }
    : { source: 'company_skill', skill: f.skillName.trim(), fingerprint: '0'.repeat(40) }
  return parseJobDefinition({
    ...common,
    check: f.checkKind === 'new_files' ? { kind: 'new_files', path: f.checkPath.normalize('NFC').trim() } : { kind: 'new_meetings', titleWords: words(f.titleWords) },
    run: { kind: 'procedure', procedure },
    placement: 'a',
    grant: pcGrant(f),
  })
}

/** What to tell the person about the parser's problem codes (never the value). */
export function jobProblemText(problems: string[]): string {
  if (problems.includes('name.BAD')) return `名前を入れてください（${JOB_NAME_MAX}文字まで、改行なし）。`
  if (problems.includes('run.title.BAD')) return `作るやることの名前を入れてください（${JOB_TASK_TITLE_MAX}文字まで、改行なし）。`
  if (problems.includes('actingUser.BAD') || problems.includes('actingUser.NOT_MEMBER')) return '責任者を選んでください（この会社のメンバー）。'
  if (problems.some(p => p.startsWith('run.procedure'))) return '手順にする Skill を選んでください（Skill のフォルダ名は半角の英小文字・数字・- _）。'
  if (problems.includes('check.path.BAD') || problems.includes('check.path.NOT_IN_READS')) return '新しいファイルを確かめる場所を、会社のフォルダの中の場所で入れてください（例：営業部/面談）。'
  if (problems.includes('check.titleWords.BAD')) return `会議の名前に含む言葉は${JOB_TITLE_WORDS_MAX}つまで、1つ40文字までにしてください。`
  if (problems.includes('grant.reads.paths.BAD')) return '読んでよい場所は、会社のフォルダの中の場所を1行に1つ入れてください。'
  if (problems.some(p => p.startsWith('grant.writes'))) return '置き場所は、会社のフォルダの中の場所と、半角の英小文字・数字・- _ のフォルダ名で入れてください。'
  if (problems.includes('grant.deliverTo.NEEDS_DELIVERABLE')) return 'できたものを外に置くには、先に「作ったファイルの置き場所」を入れてください（AI はそこで作ってから置きます）。'
  if (problems.some(p => p.startsWith('grant.deliverTo'))) return 'できたものを置く先を選び直してください。'
  return '内容に正しくないところがあります。選び直してください。'
}
