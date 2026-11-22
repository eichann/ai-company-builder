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
  JOB_EVENT_PC_EXPIRES_DEFAULT_MINUTES, JOB_MINUTES_ROUTE, JOB_NAME_MAX, isRecordTrigger, knownJobDefinition, JOB_OUTBOUND_ROUTES, JOB_TASK_TITLE_MAX, JOB_TITLE_WORDS_MAX, parseJobDefinition,
  type JobDefinition, type JobDefinitionResult, type JobDoneMark, type JobGrant, type JobWeekday,
} from '../../../shared/core/jobs'
import { BUILTIN_CONNECTORS, type DeliveryPlaceKind } from '../../../shared/core/builtin-connectors'
import { canonicalJson } from '../../../shared/core/fixed-content'

/**
 * The definition shapes **this console** shows, edits and accepts (stage 4b-0.5, owner memo 「段4b 設計メモ」 §5-1): its form
 * round-trips each of them (`formFromDefinition` → `definitionFromForm`, `admin/tests/job-screen-schemas.test.ts`). It is
 * what every job request announces (`X-ACB-Job-Schemas`, `api.ts` `JOB_READS`) — never the shared parser's `JOB_SCHEMAS`:
 * a later build's core may read a shape before this form can show it, and then the server must not hand this console its
 * definition nor take an approval, acceptance or edit of it from here. Schema 3 (an event run by the responsible person's PC
 * AI) since stage 4b-3, with the form that makes and reads it back.
 */
export const ADMIN_JOB_SCHEMAS: readonly number[] = [1, 2, 3]

/** A definition this console's form reads: a shape the core knows and this console announces. */
function adminReadsDefinition(d: unknown): JobDefinition | null {
  const known = knownJobDefinition(d)
  return known !== null && ADMIN_JOB_SCHEMAS.includes(known.schema) ? known : null
}

export interface JobForm {
  name: string
  actingUser: string
  /** `task`: the server makes a やること (no AI). `pc`: a Skill runs on the responsible person's PC. */
  kind: 'task' | 'pc'
  /**
   * When it runs: at a time (`time`, schema 1), or when the one watched やること of the responsible person reaches a state
   * (`event`): with `task` the server's operation (stage 4a, schema 2), with `pc` the responsible person's PC AI (stage 4b-3,
   * schema 3).
   */
  when: 'time' | 'event'
  /** `event`: the state watched for (a state of a やること). */
  eventTo: string
  /**
   * `event`: the state it must come from ('' = any). The form offers no choice of it, but keeps what a version has:
   * an edit never widens a trigger it read (Codex review of #700).
   */
  eventFrom: string
  /** `event`: the やること watched first (its id; chosen from a list of the responsible person's open やること). */
  startRecord: string
  /** `event`: after it made a やること, watch that one next (a chain); else once only. */
  followMadeTask: boolean
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
  /** A time PC job's check (an event PC job is always checked on its watched やること: `source_record`). */
  checkKind: 'new_files' | 'new_meetings'
  /** `new_files`: the place looked at (also read). */
  checkPath: string
  /** `new_meetings`: words a meeting's title must hold (one of them), separated by 、 or spaces; empty = every meeting. */
  titleWords: string
  /**
   * An event PC job (schema 3): what on the watched やること says the work is done already, so the AI is not called
   * (`none`, or `file_linked`: a file is linked from it already).
   */
  doneMark: JobDoneMark
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
    name: '', actingUser, kind: 'task', when: 'time', eventTo: 'done', eventFrom: '', startRecord: '', followMadeTask: true, every: 'week', hour: '09', minute: '00', businessDaysOnly: true, weekday: 'mon', businessDaysBefore: 0,
    monthDay: 1, ifHoliday: 'before', taskTitle: '', dueBusinessDays: 1, missedPolicy: 'latest_only', expiresAfterMinutes: 720,
    limits: NEW_JOB_LIMITS,
    skillName: '', shelfItem: '', checkKind: 'new_files', checkPath: '', titleWords: '', doneMark: 'none', readPaths: '', readRecords: true, mailDrafts: false, writePlace: '', writeFolder: '',
    deliverTo: '',
  }
}

const lines = (text: string) => [...new Set(text.split('\n').map(l => l.normalize('NFC').trim()).filter(Boolean))]
const words = (text: string) => [...new Set(text.normalize('NFC').split(/[、,\s]+/).map(w => w.trim()).filter(Boolean))]

/**
 * The definition of a version as this console may show and edit it, or null when it must not (jobs.md "Shapes this
 * build does not know"): the server said this console cannot read its shape (`needsUpdate`), or what came is not a
 * shape this console knows (a newer server that ignored the header). The screen then says `JOB_NEEDS_NEWER_SCREEN`.
 */
export function editableDefinition(v: { definition: JobDefinition | null; needsUpdate?: true } | null | undefined): JobDefinition | null {
  if (!v || v.needsUpdate) return null
  return adminReadsDefinition(v.definition)
}

/** The version must not be shown or edited here (see `editableDefinition`); a hidden one (`definition` null for a non-admin) is not that. */
export function needsNewerScreen(v: { definition: JobDefinition | null; needsUpdate?: true } | null | undefined): boolean {
  return !!v && (v.needsUpdate === true || (v.definition !== null && adminReadsDefinition(v.definition) === null))
}

/**
 * A version the server hides from this viewer (jobs.md "Names never leak", "Event-triggered jobs" `readsStart`): of a
 * shape this console reads, but answered without its definition and fingerprints — it names a やること (the start record) or
 * a place this viewer cannot read, owners and admins included for a start record. Shown as such: never its words, never an
 * empty form that would write over it, never approved or accepted from here (there is no fingerprint to send, and none is
 * guessed). Not `needsNewerScreen` (that is a shape this console cannot show).
 */
export function hiddenVersion(v: { definition: JobDefinition | null; needsUpdate?: true } | null | undefined): boolean {
  return !!v && v.needsUpdate !== true && v.definition === null
}

/** What the screens say for a hidden version (`hiddenVersion`): no name of what is hidden, nor that it is a やること or a place. */
export const JOB_VERSION_HIDDEN = 'この版には、あなたが見られないものが含まれているため、内容を表示・編集できません。'

/**
 * A form's 「いつ動くか」 / 「すること」 changed (stage 4b-3). A PC job gets at least 15 minutes per run; a **new** job becoming
 * an event run by the PC (it was not one) takes the owner's default wait of one day for the responsible person's app
 * (`JOB_EVENT_PC_EXPIRES_DEFAULT_MINUTES`, memo D6) — still a choice on the form. Editing a version (`newJob` false) never
 * changes its own wait (independent review of 4b-3: switching away and back reset it).
 */
export function switchJobForm(prev: JobForm, change: Partial<Pick<JobForm, 'when' | 'kind'>>, newJob: boolean): JobForm {
  const next = { ...prev, ...change }
  if (change.kind === 'pc' && prev.kind !== 'pc') next.limits = { ...prev.limits, minutes: Math.max(prev.limits.minutes, 15) }
  const eventPc = (f: JobForm) => f.when === 'event' && f.kind === 'pc'
  if (newJob && eventPc(next) && !eventPc(prev)) next.expiresAfterMinutes = JOB_EVENT_PC_EXPIRES_DEFAULT_MINUTES
  return next
}

/** A procedure's choices as the form shows them (a PC job of either trigger). */
function pcFieldsOf(d: JobDefinition, checkPath: string): Partial<JobForm> {
  if (d.run.kind !== 'procedure') return {}
  const p = d.run.procedure
  return {
    kind: 'pc',
    skillName: p.source === 'company_skill' ? p.skill : '', shelfItem: p.source === 'shelf_skill' ? p.item : '',
    readPaths: d.grant.reads.paths.filter(x => x !== checkPath).join('\n'),
    readRecords: RECORD_READ_ROUTES.some(r => d.grant.routes.includes(r)),
    mailDrafts: d.grant.outbound === 'draft_only',
    writePlace: d.grant.writes.area === 'deliverable' ? d.grant.writes.place : '',
    writeFolder: d.grant.writes.area === 'deliverable' ? d.grant.writes.folder : '',
    deliverTo: d.grant.deliverTo ? `${d.grant.deliverTo.connector}:${d.grant.deliverTo.kind}` : '',
  }
}

/** The form for a version. */
export function formFromDefinition(d: JobDefinition): JobForm {
  const base = emptyJobForm(d.actingUser)
  if (isRecordTrigger(d.trigger)) {
    // An event job: the server's operation (stage 4a) or the responsible person's PC AI (stage 4b-3, schema 3).
    return {
      ...base, name: d.name, when: 'event', eventTo: d.trigger.to, eventFrom: d.trigger.from ?? '', startRecord: d.trigger.startRecord, followMadeTask: d.trigger.followMadeTask,
      missedPolicy: d.missed.policy, expiresAfterMinutes: d.missed.expiresAfterMinutes, limits: d.grant.limits,
      ...(d.run.kind === 'operation' ? { kind: 'task' as const, taskTitle: d.run.title, dueBusinessDays: d.run.dueBusinessDays } : pcFieldsOf(d, '')),
      ...(d.check.kind === 'source_record' ? { doneMark: d.check.doneMark } : {}),
    }
  }
  const [hour, minute] = d.trigger.at.split(':')
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
  const checkPath = d.check.kind === 'new_files' ? d.check.path : ''
  return {
    ...common, ...pcFieldsOf(d, checkPath),
    checkKind: d.check.kind === 'new_meetings' ? 'new_meetings' : 'new_files', checkPath,
    titleWords: d.check.kind === 'new_meetings' ? d.check.titleWords.join('、') : '',
  }
}

/**
 * A PC job's grant from the form's few choices (the parser checks it as for any definition). `creates: ['task']` always —
 * the one やること of a run, which an event run must make (`grant.creates.EVENT_NEEDS_TASK`), so the form satisfies it by
 * construction — with `records`, which creating needs. A time job's check adds its place (`new_files`) or the minutes
 * route (`new_meetings`); an event job (`event`) is checked on its watched やること, so a check left on the form from a
 * time job grants nothing.
 */
function pcGrant(f: JobForm, event: boolean): JobGrant {
  const checkPaths = !event && f.checkKind === 'new_files' ? lines(f.checkPath) : []
  const reads = [...new Set([...checkPaths, ...lines(f.readPaths)])]
  const writes: JobGrant['writes'] = f.writeFolder.trim() ? { area: 'deliverable', place: f.writePlace.normalize('NFC').trim(), folder: f.writeFolder.trim() } : { area: 'none' }
  const tools = ['records', ...(reads.length > 0 ? ['files_read'] : []), ...(writes.area === 'deliverable' ? ['files_write'] : []), ...(f.mailDrafts ? ['outbound_draft'] : [])]
  const routes = [
    ...(f.readRecords ? RECORD_READ_ROUTES : []),
    ...(!event && f.checkKind === 'new_meetings' ? [JOB_MINUTES_ROUTE] : []),
    ...(f.mailDrafts ? JOB_OUTBOUND_ROUTES : []),
  ]
  const [connector, kind] = f.deliverTo.split(':')
  return {
    tools, creates: ['task'], routes, reads: { paths: reads, calls: [] }, writes, outbound: f.mailDrafts ? 'draft_only' : 'none', limits: f.limits,
    // The exact place is chosen by the responsible person when accepting (`ref` null here).
    ...(f.deliverTo ? { deliverTo: { connector, kind, ref: null } } : {}),
  }
}

/** The pinned Skill as the form names it: a placeholder fingerprint (the server reads the pinned one, and a shelf Skill's name). */
function procedureOf(f: JobForm, shelfSkillName?: string) {
  return f.shelfItem
    ? { source: 'shelf_skill', item: f.shelfItem, skill: shelfSkillName ?? 'skill', fingerprint: '0'.repeat(64) }
    : { source: 'company_skill', skill: f.skillName.trim(), fingerprint: '0'.repeat(40) }
}

/**
 * The definition the form says, checked by the shared parser (the server checks it again). A PC job's Skill
 * goes with a placeholder fingerprint: the server reads the pinned one (and a shelf Skill's name) itself.
 */
export function definitionFromForm(f: JobForm, shelfSkillName?: string): JobDefinitionResult {
  if (f.when === 'event') {
    if (!f.startRecord) return { ok: false, problems: ['trigger.startRecord.REQUIRED'] }
    const event = {
      name: f.name.normalize('NFC').trim(), actingUser: f.actingUser,
      trigger: {
        kind: 'record', type: 'task', event: 'state', to: f.eventTo, ...(f.eventFrom ? { from: f.eventFrom } : {}),
        assignee: 'responsible', startRecord: f.startRecord, followMadeTask: f.followMadeTask,
      },
      missed: { policy: f.missedPolicy, expiresAfterMinutes: f.expiresAfterMinutes },
    }
    if (f.kind === 'pc') {
      // Stage 4b-3: the responsible person's PC AI runs the Skill when the watched one reaches the state (schema 3); the
      // server checks the watched やること first and at every call (`source_record`, with the done mark chosen).
      return parseJobDefinition({
        ...event, schema: 3,
        check: { kind: 'source_record', doneMark: f.doneMark },
        run: { kind: 'procedure', procedure: procedureOf(f, shelfSkillName) },
        placement: 'a',
        grant: pcGrant(f, true),
      })
    }
    // Stage 4a: the server makes a やること when the watched one reaches the state (schema 2; no AI).
    return parseJobDefinition({
      ...event, schema: 2,
      check: { kind: 'none' },
      run: { kind: 'operation', operation: 'create_task', title: f.taskTitle.normalize('NFC').trim(), dueBusinessDays: f.dueBusinessDays },
      placement: 'e',
      grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: f.limits },
    })
  }
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
  return parseJobDefinition({
    ...common,
    check: f.checkKind === 'new_files' ? { kind: 'new_files', path: f.checkPath.normalize('NFC').trim() } : { kind: 'new_meetings', titleWords: words(f.titleWords) },
    run: { kind: 'procedure', procedure: procedureOf(f, shelfSkillName) },
    placement: 'a',
    grant: pcGrant(f, false),
  })
}

/** Why a version is not given the edit form (`jobEditForm`): it holds what the form's fields cannot say. */
export const JOB_FORM_CANNOT_EDIT = 'この版は、管理画面の入力欄では直せない内容（できることの細かい決まりなど）を含むため、ここでは直せません。'

/**
 * The edit form of a version, or null when the form would change it (independent review of 4b-3): the form offers a few
 * plain choices, so a schema-3 grant made otherwise (e.g. one record route instead of the four 「やることや記録を読む」 gives)
 * would come back **wider** from `definitionFromForm` — what the responsible person accepted widened silently. Schema 3
 * is given the form only when it round-trips exactly (the pinned Skill's fingerprint and a shelf Skill's name are the
 * server's, so they are left out of the comparison). Schemas 1 and 2 keep their behaviour.
 */
export function jobEditForm(d: JobDefinition): JobForm | null {
  const form = formFromDefinition(d)
  if (d.schema !== 3) return form
  const shelfName = d.run.kind === 'procedure' && d.run.procedure.source === 'shelf_skill' ? d.run.procedure.skill : undefined
  const back = definitionFromForm(form, shelfName)
  const pinless = (x: JobDefinition) => canonicalJson(x.run.kind === 'procedure' ? { ...x, run: { ...x.run, procedure: { ...x.run.procedure, fingerprint: '' } } } : x)
  return back.ok && pinless(back.definition) === pinless(d) ? form : null
}

/** What to tell the person about the parser's problem codes (never the value). */
export function jobProblemText(problems: string[]): string {
  // A server that does not know this kind of job yet (the rollback floor answering schema 3).
  if (problems.includes('schema.UNKNOWN')) return 'この種類の定期の仕事は、いまのサーバーではまだ作れません（サーバーの更新が必要です）。'
  if (problems.includes('name.BAD')) return `名前を入れてください（${JOB_NAME_MAX}文字まで、改行なし）。`
  if (problems.includes('run.title.BAD')) return `作るやることの名前を入れてください（${JOB_TASK_TITLE_MAX}文字まで、改行なし）。`
  if (problems.includes('actingUser.BAD') || problems.includes('actingUser.NOT_MEMBER')) return '責任者を選んでください（この会社のメンバー）。'
  if (problems.includes('trigger.startRecord.REQUIRED') || problems.includes('trigger.startRecord.BAD')) return '見張るやることを1つ選んでください（責任者が担当の、まだ終わっていないやること）。'
  if (problems.includes('trigger.startRecord.NOT_FOUND')) return '選んだやることが見つかりません。あなたと責任者の両方が見られる、責任者が担当のやることを選んでください。'
  if (problems.includes('trigger.to.AI_TURN')) return 'その状態は「AI の番」で使われているため、きっかけにできません。ほかの状態を選んでください。'
  if (problems.includes('trigger.EVENT_SERVER_ONLY') || problems.includes('run.EVENT_PC_ONLY') || problems.includes('check.EVENT_NEEDS_SOURCE_RECORD') || problems.includes('check.SOURCE_RECORD_EVENTS_ONLY')) {
    return '出来事で動く仕事の「すること」と「確かめること」の組み合わせが正しくありません。「すること」を選び直してください。'
  }
  if (problems.includes('check.doneMark.BAD')) return '「済みの印」を選び直してください。'
  if (problems.includes('grant.creates.EVENT_NEEDS_TASK')) return '出来事で AI が動く仕事は、終わったときに責任者のやることを1つ作ります。作れるものに「やること」が要ります。'
  if (problems.some(p => p.startsWith('trigger.'))) return 'きっかけを選び直してください。'
  if (problems.some(p => p.startsWith('run.procedure'))) return '手順にする Skill を選んでください（Skill のフォルダ名は半角の英小文字・数字・- _）。'
  if (problems.includes('check.path.BAD') || problems.includes('check.path.NOT_IN_READS')) return '新しいファイルを確かめる場所を、会社のフォルダの中の場所で入れてください（例：営業部/面談）。'
  if (problems.includes('check.titleWords.BAD')) return `会議の名前に含む言葉は${JOB_TITLE_WORDS_MAX}つまで、1つ40文字までにしてください。`
  if (problems.includes('grant.reads.paths.BAD')) return '読んでよい場所は、会社のフォルダの中の場所を1行に1つ入れてください。'
  if (problems.some(p => p.startsWith('grant.writes'))) return '置き場所は、会社のフォルダの中の場所と、半角の英小文字・数字・- _ のフォルダ名で入れてください。'
  if (problems.includes('grant.deliverTo.NEEDS_DELIVERABLE')) return 'できたものを外に置くには、先に「作ったファイルの置き場所」を入れてください（AI はそこで作ってから置きます）。'
  if (problems.some(p => p.startsWith('grant.deliverTo'))) return 'できたものを置く先を選び直してください。'
  return '内容に正しくないところがあります。選び直してください。'
}
