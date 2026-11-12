/**
 * A scheduled job's PC run (定期の仕事, placement `a`, B PR 5a-2, `.claude/rules/jobs.md` "The app's runner"):
 * a kind of 「AI の番」 made from the server's answers, like a business plugin's step (`plugin.ts`). The
 * server lists the member's occurrences to claim (`GET /me/job-turns`), the claim answers what it runs (the
 * check, the pinned procedure, the grant); this module is pure: the parser of those answers (through the
 * one definition parser, `parseJobDefinition`), the run's tool ceiling in the app's tool names, where it may
 * write, and the first message.
 *
 * The run's step is `job-procedure` (`JOB_PC_STEP`): the server scopes its token to the grant at every call.
 */
import {
  JOB_PC_STEP, OCCURRENCE_ID_RE, jobDeliveryHowTo, jobDeliveryTools, jobRunRouteAllowed, parseJobAcceptedPlace, parseJobDefinition,
  type JobCheck, type JobDeliveryPlace, type JobGrant, type JobProcedure,
} from '../../../shared/core/jobs'
import { OUTSIDE_TITLE_NOTE, outsideTitle } from '../../../shared/core/outside-text'
import type { AiTurnCandidate } from './types'
import { AUTOMATIC_NO_SHELL_RULE } from './plugin'

export { JOB_PC_STEP }
/** The run step a job's automatic send carries (`aiTurnStep`): the chat server asks main for its ceiling. */
export type JobRunStep = typeof JOB_PC_STEP

/** One occurrence the member may claim now, as the runner's queue and main's claim keep it. */
export interface QueuedJobTurn {
  occurrenceId: string
  jobId: string
  name: string
  dueAt: string
  expiresAt: string
  /** `due`, or `running` when its run may be claimed again (the queue's `state`: a re-listed one is another try). */
  state: 'due' | 'running'
  check: JobCheck
  checkSince: string
  /** Where the check stops (the occurrence's own time); absent from an older server. */
  checkUntil?: string
  /** A `new_files` check in the shared folder: the previous occurrence's commit, and this one's first claim's. */
  sinceCommit?: string | null
  checkedCommit?: string | null
  procedure: JobProcedure
  grant: JobGrant
  /** Only in a claim's answer for a `new_meetings` check: what it found (the only minutes the run may read). */
  meetings?: Array<{ id: string; title: string; at: string }>
  /** The deliverable place outside its responsible person chose (the grant's `deliverTo` with its id); absent: none. */
  deliverTo?: JobDeliveryPlace
  /** How often an owner / admin sent the occurrence back with 「もう一度」 (jobs.md, B PR 5b); absent: never. */
  retries?: number
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const iso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v))
const RECORD_ID = /^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}$/

/**
 * One turn of the server's answer, checked: the check, the procedure and the grant go through the server's
 * own definition parser (strict: anything this build does not know refuses the turn; a procedure's check is never
 * `none`). null: not a turn this app runs.
 */
export function parseJobTurn(v: unknown): QueuedJobTurn | null {
  if (typeof v !== 'object' || v === null) return null
  const t = v as Record<string, unknown>
  if (!str(t.occurrenceId, 40) || !OCCURRENCE_ID_RE.test(t.occurrenceId) || !str(t.jobId, 40) || !str(t.name, 200)) return null
  if (!iso(t.dueAt) || !iso(t.expiresAt) || !iso(t.checkSince) || (t.state !== 'due' && t.state !== 'running')) return null
  if (t.checkUntil !== undefined && !iso(t.checkUntil)) return null
  const commit = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v))
  if (!commit(t.sinceCommit) || !commit(t.checkedCommit)) return null
  const parsed = parseJobDefinition({
    schema: 1, name: '定期の仕事', actingUser: 'u', trigger: { every: 'day', at: '09:00', businessDaysOnly: false },
    check: t.check, run: { kind: 'procedure', procedure: t.procedure }, placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 60 }, grant: t.grant,
  })
  if (!parsed.ok || parsed.definition.run.kind !== 'procedure') return null
  const { check, grant } = parsed.definition
  // The chosen place: only of the grant's own connector and kind (the one parser); without a grant's place, none.
  let deliverTo: JobDeliveryPlace | undefined
  if (t.deliverTo !== undefined) {
    const place = grant.deliverTo ? parseJobAcceptedPlace(t.deliverTo, grant.deliverTo) : null
    if (!place) return null
    deliverTo = place
  }
  let meetings: QueuedJobTurn['meetings']
  if (t.meetings !== undefined) {
    if (!Array.isArray(t.meetings) || t.meetings.length > 50) return null
    meetings = []
    for (const m of t.meetings as unknown[]) {
      const x = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>
      if (!str(x.id, 80) || !RECORD_ID.test(x.id) || typeof x.title !== 'string' || x.title.length > 500 || !iso(x.at)) return null
      meetings.push({ id: x.id, title: x.title, at: x.at })
    }
  }
  return {
    occurrenceId: t.occurrenceId, jobId: t.jobId, name: t.name, dueAt: t.dueAt, expiresAt: t.expiresAt, state: t.state,
    check, checkSince: t.checkSince, ...(typeof t.checkUntil === 'string' ? { checkUntil: t.checkUntil } : {}),
    ...(typeof t.sinceCommit === 'string' ? { sinceCommit: t.sinceCommit } : {}), ...(typeof t.checkedCommit === 'string' ? { checkedCommit: t.checkedCommit } : {}), procedure: parsed.definition.run.procedure, grant, ...(meetings ? { meetings } : {}),
    ...(deliverTo ? { deliverTo } : {}),
    ...(typeof t.retries === 'number' && Number.isInteger(t.retries) && t.retries > 0 && t.retries < 1_000_000 ? { retries: t.retries } : {}),
  }
}

/** The answer of `GET /me/job-turns`, each turn checked (the rest left out); null when the answer is not one. */
export function parseJobTurns(data: unknown): QueuedJobTurn[] | null {
  const turns = typeof data === 'object' && data !== null ? (data as { turns?: unknown }).turns : undefined
  if (!Array.isArray(turns)) return null
  return turns.slice(0, 200).map(parseJobTurn).filter((t): t is QueuedJobTurn => t !== null)
}

/** The runner's queue entry: never handed to the person for being due soon (its due is the slot, not a deadline). */
export function jobTurnCandidate(turn: QueuedJobTurn): AiTurnCandidate {
  return {
    id: turn.occurrenceId, title: turn.name, version: 1, dueAt: turn.dueAt, state: turn.state, job: true, notUrgent: true,
    // 「もう一度」: each press is tried afresh on this PC (today's attempts count per occurrence and press).
    ...(turn.retries ? { attemptKey: `${turn.occurrenceId}#${turn.retries}` } : {}),
  }
}

/** The hidden consultation's title: 「<仕事の名前>（M/D）」. */
export function jobConsultationTitle(name: string, now = new Date()): string {
  return `${name}（${now.getMonth() + 1}/${now.getDate()}）`
}

/**
 * The record tools a job's run may get, each with the one AI route it calls: given only when the grant's
 * tool group allows it and the server would let its route through (`jobRunRouteAllowed`, the ceiling the
 * server applies at every call). `job_report` (how the run hands back its やること's title) calls nothing.
 */
const JOB_RECORD_TOOLS: ReadonlyArray<{ name: string; group: 'records' | 'outbound_draft'; route: string }> = [
  { name: 'records_types', group: 'records', route: 'GET /types' },
  { name: 'records_my_turn', group: 'records', route: 'GET /my-turn' },
  { name: 'records_query', group: 'records', route: 'POST /query' },
  { name: 'records_get', group: 'records', route: 'GET /item/:recordId' },
  { name: 'records_history', group: 'records', route: 'GET /item/:recordId/history' },
  { name: 'minutes_read', group: 'records', route: 'GET /minutes/:recordId/text' },
  { name: 'mail_recipients', group: 'outbound_draft', route: 'POST /outbound-recipients' },
  { name: 'mail_draft_create', group: 'outbound_draft', route: 'POST /outbound' },
  { name: 'mail_draft_update', group: 'outbound_draft', route: 'PUT /outbound/:messageId' },
  { name: 'mail_draft_show', group: 'outbound_draft', route: 'GET /outbound/:messageId' },
]
export const JOB_REPORT_TOOL = 'job_report'

const BUILTIN: Record<string, readonly string[]> = {
  files_read: ['Read', 'Glob', 'Grep'],
  files_write: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit'],
}

/** The run's ceiling (the chat server's least-privilege filter, `AiTurnToolCeiling`): never more than the grant. */
export interface JobToolAccess {
  allowsRecordTool(name: string): boolean
  builtinTools: string[]
}

export function jobToolAccess(grant: JobGrant, check: JobCheck, deliverTo?: JobDeliveryPlace): JobToolAccess {
  const minutes = check.kind === 'new_meetings'
  const allowed = new Set(JOB_RECORD_TOOLS
    .filter(t => grant.tools.includes(t.group) && jobRunRouteAllowed(grant, t.route, () => minutes))
    .map(t => t.name))
  allowed.add(JOB_REPORT_TOOL)
  // The deliverable place's own tools (its connector declares them), only once its responsible person chose it.
  if (deliverTo) for (const name of jobDeliveryTools(grant)) allowed.add(name)
  return {
    allowsRecordTool: name => allowed.has(name),
    builtinTools: [...new Set(grant.tools.flatMap(t => BUILTIN[t] ?? []))],
  }
}

/**
 * Where the run may write (the write guard's `writeArea`): only `<place>/.personal/<folder>/`, or nowhere; and
 * where its file tools may read (`reads`, the guard's `readArea`): the grant's read paths only.
 */
export type JobWriteArea = ({ place: string; folder: string } | { nowhere: true }) & { reads: string[] }

export function jobWriteArea(grant: JobGrant): JobWriteArea {
  const reads = [...grant.reads.paths]
  return grant.writes.area === 'deliverable' ? { place: grant.writes.place, folder: grant.writes.folder, reads } : { nowhere: true, reads }
}

/** What the check found, as the first message names it. */
export type JobFound = { kind: 'files'; files: string[] } | { kind: 'meetings'; meetings: Array<{ id: string; title: string; at: string }> }

/**
 * The run's first message: the job, what the check found (meetings' titles quoted as outside text), the
 * pinned procedure as the instructions, the places it may read and write, and how it hands back its one
 * やること (`job_report`) — the server makes it; the run never creates one itself.
 */
export function jobFirstMessage(input: { name: string; found: JobFound; procedure: string; grant: JobGrant; deadline: string; deliverTo?: JobDeliveryPlace }): string {
  const howTo = input.deliverTo ? jobDeliveryHowTo(input.deliverTo) : null
  const { found, grant } = input
  const foundLines = found.kind === 'files'
    ? ['前の回のあとに新しく入ったファイル：', ...found.files.slice(0, 50).map(f => `- ${f}`), ...(found.files.length > 50 ? [`（ほか ${found.files.length - 50} 件）`] : [])]
    : [
      '前の回のあとにあった、あなたが出た会議（minutes_read で読めるのはこの会議の議事録だけです）：',
      ...found.meetings.map(m => `- ${m.id}：${outsideTitle(m.title)}（${m.at}）`),
      OUTSIDE_TITLE_NOTE,
    ]
  return [
    '（アプリが定期の仕事として自動で始めた相談です。私はいま画面を見ていません。）',
    '',
    `定期の仕事「${input.name}」を、次の手順書どおりに進めてください。`,
    '',
    ...foundLines,
    '',
    '手順書（会社の Skill）:',
    '-----',
    input.procedure.trim(),
    '-----',
    '',
    '自動で進めるときの決まり：',
    '- 使えるのはこの仕事に許された道具だけです。使えない道具や足りない情報があっても止まらず、最後のやることの説明にまとめてください。',
    ...(grant.reads.paths.length > 0 ? [`- 読んでよい場所は ${grant.reads.paths.map(p => `「${p}」`).join('・')} の中だけです。`] : []),
    grant.writes.area === 'deliverable'
      ? `- ファイルを保存できるのは「${grant.writes.place}/.personal/${grant.writes.folder}/」の中だけです（あなただけのフォルダで、共有されません）。`
      : '- この仕事ではファイルを保存できません。',
    ...(howTo ? [`- ${howTo}`] : []),
    '- 送る・承認するは人がします。メールは下書きまでにしてください。',
    '- やることや記録は自分で作らないでください。',
    AUTOMATIC_NO_SHELL_RULE,
    `- ${input.deadline} までに終えてください。それを過ぎると止まります。`,
    '',
    `終わったら、必ず ${JOB_REPORT_TOOL} を1回呼んで、私へのやることの名前（title、80文字まで）と、作ったもの・確かめてほしいことの短い説明（summary、300文字まで）を渡してください。やることはそのときに作られます。${JOB_REPORT_TOOL} が断ったときは、やることは作られていません。作ったとは言わず、そのとおり伝えてください。`,
  ].join('\n')
}
