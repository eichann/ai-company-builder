/**
 * Scheduled jobs (定期の仕事, B 「実行を記録から分ける」 PR 3a, `.claude/rules/jobs.md`): the definition a
 * job's version holds, one strict parser for it, and the ids of jobs and their occurrences.
 *
 * A definition is data an owner / admin picks from lists — never a cron string, an expression or a
 * condition language. It says when (`trigger`, in the company's time), what is checked first without
 * the AI (`check`), what runs (`run`: a core operation on the server, or a company Skill pinned at a
 * fingerprint on the responsible person's PC), where (`placement`: `e` the server's own operation, `a`
 * the responsible person's PC), what happens to a missed occurrence (`missed`), and the grant — what
 * a run may touch, in the words business plugins' steps already use (`PLUGIN_STEP_TOOLS`,
 * `AI_ROUTES`), never new ones. Everything else is refused: an unknown key or value at any level is
 * an error, so a definition stored today means exactly one thing to every later build.
 *
 * `schema` versions the shape: a stored version keeps the schema it was written with, and a later
 * build adds `schema: 2` beside it instead of re-reading old rows differently.
 *
 * Pure (server/tests/unit/core-purity.test.ts). The server hashes `jobDefinitionCanonical` /
 * `jobConsentCanonical` (sha256) — this module never hashes.
 */
import { AI_ROUTES } from './ai-turn-routes'
import { canonicalJson } from './fixed-content'
import { isValidSkillName } from './names'
import { PLUGIN_STEP_TOOLS } from './plugin-flow-declaration'
import { RECORD_ID_RE } from './records'

/** The definition shapes this build reads. */
export const JOB_SCHEMAS = [1] as const
export type JobSchema = typeof JOB_SCHEMAS[number]

/** A job's state: a draft until first approved; paused / retired keep it from running. */
export type JobState = 'draft' | 'active' | 'paused' | 'retired'

export const JOB_NAME_MAX = 60
export const JOB_TASK_TITLE_MAX = 80

/**
 * A job's id: `job.` + 32 lowercase hex. An occurrence's: `occ.` + 32 lowercase hex. An occurrence id
 * is what a run's subject id holds (`ai_runs.record_id`, the column every kind shares), so it must
 * never equal a record id: `RECORD_ID_RE` has no `.`, so no string matching these does
 * (`isOccurrenceId` checks it again, and the occurrence table's CHECK keeps the shape).
 */
export const JOB_ID_RE = /^job\.[0-9a-f]{32}$/
export const OCCURRENCE_ID_RE = /^occ\.[0-9a-f]{32}$/

export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_RE.test(value)
}

/** An occurrence id — and, by construction, never a record id. */
export function isOccurrenceId(value: unknown): value is string {
  return typeof value === 'string' && OCCURRENCE_ID_RE.test(value) && !RECORD_ID_RE.test(value)
}

const HEX32_RE = /^[0-9a-f]{32}$/
/** `hex`: 32 lowercase hex characters (the caller's randomness: this module has none). */
export function newJobId(hex: string): string {
  if (!HEX32_RE.test(hex)) throw new Error('newJobId: needs 32 lowercase hex characters')
  return `job.${hex}`
}
export function newOccurrenceId(hex: string): string {
  if (!HEX32_RE.test(hex)) throw new Error('newOccurrenceId: needs 32 lowercase hex characters')
  return `occ.${hex}`
}

export const JOB_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type JobWeekday = typeof JOB_WEEKDAYS[number]

/**
 * When, in the company's time (its zone is the company's, today Asia/Tokyo for every company; the
 * occurrence keeps the zone it was computed in). `at` is `HH:MM` on a 5-minute step (the server
 * clock runs every 5 minutes).
 * - `day`: every day at `at`; `businessDaysOnly` skips weekends, public holidays and the company's days off.
 * - `week`: `weekday` at `at`, moved `businessDaysBefore` business days earlier (「火曜の1営業日前」 = tue, 1).
 * - `month`: day `day` (1–28, or `last`) at `at`; a day that is not a business day stays, or moves to the
 *   business day before / after (`ifHoliday`).
 */
export type JobTrigger =
  | { every: 'day'; at: string; businessDaysOnly: boolean }
  | { every: 'week'; weekday: JobWeekday; at: string; businessDaysBefore: number }
  | { every: 'month'; day: number | 'last'; at: string; ifHoliday: 'as_is' | 'before' | 'after' }

/**
 * What is checked first, without the AI (owner decision D6: the clock alone never runs the AI).
 * `none`: nothing (only for a server operation). `new_files`: something new under `path` since the
 * job's previous occurrence (checked on the PC; `path` must be one of the grant's `reads.paths`).
 */
export type JobCheck = { kind: 'none' } | { kind: 'new_files'; path: string }

/**
 * What runs. `operation` (placement `e`, on the server, no AI): today only `create_task` — a やること for
 * the responsible person titled `title`, due `dueBusinessDays` business days after the occurrence
 * (null: none). `procedure` (placement `a`, the responsible person's PC): a company Skill pinned at the
 * fingerprint the server read when this version was made (`PluginStepProcedurePin`'s company form).
 */
export type JobRun =
  | { kind: 'operation'; operation: 'create_task'; title: string; dueBusinessDays: number | null }
  | { kind: 'procedure'; procedure: { source: 'company_skill'; skill: string; fingerprint: string } }

/** `e`: the server's own core operation. `a`: the responsible person's PC. (`b`, `c` later.) */
export const JOB_PLACEMENTS = ['e', 'a'] as const
export type JobPlacement = typeof JOB_PLACEMENTS[number]

/** A missed occurrence: only the latest one runs (`latest_only`), or none (`skip`); either expires. */
export interface JobMissed { policy: 'latest_only' | 'skip'; expiresAfterMinutes: number }

/**
 * The tools a job's grant may name: business plugins' step tools without those that reach outside on
 * their own (`web_research`) or need a plugin's context (`plugin_operations`): neither is allowed to
 * an unattended run in schema 1.
 */
export const JOB_GRANT_TOOLS: readonly string[] = PLUGIN_STEP_TOOLS.filter(t => t !== 'web_research' && t !== 'plugin_operations')
/** Record types a job's run may create (schema 1: a やること only). */
export const JOB_CREATABLE_TYPES: readonly string[] = ['task']

/**
 * The grant (実行契約, design memo §4-1): the most a run of this version may do, on top of the
 * responsible person's own rights. `routes` are names from `AI_ROUTES` (no conditions in schema 1);
 * `reads.calls` (connector reads) stays empty; `writes`: nothing, or only the deliverable folder
 * `<place>/.personal/<folder>/` on the PC; `outbound`: `none`, or drafts only (sending is always a
 * person's); `limits`: minutes per run and runs per day.
 */
export interface JobGrant {
  tools: string[]
  creates: string[]
  routes: string[]
  reads: { paths: string[]; calls: never[] }
  writes: { area: 'none' } | { area: 'deliverable'; place: string; folder: string }
  outbound: 'none' | 'draft_only'
  limits: { minutes: number; runsPerDay: number }
}

export interface JobDefinition {
  schema: JobSchema
  name: string
  /** The responsible person (責任者): the job runs as this member (owner decision D3). */
  actingUser: string
  trigger: JobTrigger
  check: JobCheck
  run: JobRun
  placement: JobPlacement
  missed: JobMissed
  grant: JobGrant
}

/** A refusal's codes only — never the values (a path could name a private folder). */
export type JobDefinitionResult = { ok: true; definition: JobDefinition } | { ok: false; problems: string[] }

const AT_RE = /^(?:[01][0-9]|2[0-3]):[0-5][05]$/
const USER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const FINGERPRINT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const DELIVERABLE_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_PATHS = 20
const MAX_ROUTES = 30
const PATH_MAX = 1024

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * A company path as a grant names it: NFC, `/`-separated, no empty / `.` / `..` segment, no leading or
 * trailing `/`, no control characters, no `.personal` / `.backups` / `.workspace` segment (never shared).
 * The company root is not a path here (a grant names places, never "everything").
 */
export function jobPathProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > PATH_MAX) return 'PATH'
  if (value !== value.normalize('NFC')) return 'PATH'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return 'PATH'
  const segs = value.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) return 'PATH'
  if (segs.some(s => ['.personal', '.backups', '.workspace'].includes(s.toLowerCase()))) return 'PATH'
  return null
}

function keysExactly(o: Obj, required: readonly string[], where: string, problems: string[]): boolean {
  const extra = Object.keys(o).filter(k => !required.includes(k))
  const missing = required.filter(k => !Object.prototype.hasOwnProperty.call(o, k))
  if (extra.length > 0) problems.push(`${where}.UNKNOWN_KEY`)
  for (const k of missing) problems.push(`${where}.${k}.MISSING`)
  return extra.length === 0 && missing.length === 0
}

function uniqueStrings(v: unknown, allowed: (s: string) => boolean, max: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  if (!v.every(s => typeof s === 'string' && allowed(s))) return null
  if (new Set(v).size !== v.length) return null
  return [...(v as string[])]
}

function parseTrigger(v: unknown, problems: string[]): JobTrigger | null {
  if (!isObj(v)) { problems.push('trigger.BAD'); return null }
  if (v.every === 'day') {
    if (!keysExactly(v, ['every', 'at', 'businessDaysOnly'], 'trigger', problems)) return null
    if (typeof v.at !== 'string' || !AT_RE.test(v.at)) problems.push('trigger.at.BAD')
    if (typeof v.businessDaysOnly !== 'boolean') problems.push('trigger.businessDaysOnly.BAD')
    return problems.length ? null : { every: 'day', at: v.at as string, businessDaysOnly: v.businessDaysOnly as boolean }
  }
  if (v.every === 'week') {
    if (!keysExactly(v, ['every', 'weekday', 'at', 'businessDaysBefore'], 'trigger', problems)) return null
    if (!(JOB_WEEKDAYS as readonly unknown[]).includes(v.weekday)) problems.push('trigger.weekday.BAD')
    if (typeof v.at !== 'string' || !AT_RE.test(v.at)) problems.push('trigger.at.BAD')
    if (!isInt(v.businessDaysBefore, 0, 5)) problems.push('trigger.businessDaysBefore.BAD')
    return problems.length ? null : { every: 'week', weekday: v.weekday as JobWeekday, at: v.at as string, businessDaysBefore: v.businessDaysBefore as number }
  }
  if (v.every === 'month') {
    if (!keysExactly(v, ['every', 'day', 'at', 'ifHoliday'], 'trigger', problems)) return null
    if (!(v.day === 'last' || isInt(v.day, 1, 28))) problems.push('trigger.day.BAD')
    if (typeof v.at !== 'string' || !AT_RE.test(v.at)) problems.push('trigger.at.BAD')
    if (!['as_is', 'before', 'after'].includes(v.ifHoliday as string)) problems.push('trigger.ifHoliday.BAD')
    return problems.length ? null : { every: 'month', day: v.day as number | 'last', at: v.at as string, ifHoliday: v.ifHoliday as 'as_is' | 'before' | 'after' }
  }
  problems.push('trigger.every.BAD')
  return null
}

function parseCheck(v: unknown, problems: string[]): JobCheck | null {
  if (!isObj(v)) { problems.push('check.BAD'); return null }
  if (v.kind === 'none') return keysExactly(v, ['kind'], 'check', problems) ? { kind: 'none' } : null
  if (v.kind === 'new_files') {
    if (!keysExactly(v, ['kind', 'path'], 'check', problems)) return null
    if (jobPathProblem(v.path)) { problems.push('check.path.BAD'); return null }
    return { kind: 'new_files', path: v.path as string }
  }
  problems.push('check.kind.BAD')
  return null
}

function parseRun(v: unknown, problems: string[]): JobRun | null {
  if (!isObj(v)) { problems.push('run.BAD'); return null }
  if (v.kind === 'operation') {
    if (!keysExactly(v, ['kind', 'operation', 'title', 'dueBusinessDays'], 'run', problems)) return null
    const start = problems.length
    if (v.operation !== 'create_task') problems.push('run.operation.BAD')
    const title = typeof v.title === 'string' ? v.title.normalize('NFC').trim() : ''
    // eslint-disable-next-line no-control-regex
    if (title.length === 0 || title.length > JOB_TASK_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title) || title !== v.title) problems.push('run.title.BAD')
    if (!(v.dueBusinessDays === null || isInt(v.dueBusinessDays, 0, 20))) problems.push('run.dueBusinessDays.BAD')
    return problems.length > start ? null : { kind: 'operation', operation: 'create_task', title, dueBusinessDays: v.dueBusinessDays as number | null }
  }
  if (v.kind === 'procedure') {
    if (!keysExactly(v, ['kind', 'procedure'], 'run', problems)) return null
    const p = v.procedure
    if (!isObj(p) || !keysExactly(p, ['source', 'skill', 'fingerprint'], 'run.procedure', problems)) { if (!isObj(p)) problems.push('run.procedure.BAD'); return null }
    const start = problems.length
    if (p.source !== 'company_skill') problems.push('run.procedure.source.BAD')
    if (typeof p.skill !== 'string' || !isValidSkillName(p.skill) || p.skill.length > 64) problems.push('run.procedure.skill.BAD')
    if (typeof p.fingerprint !== 'string' || !FINGERPRINT_RE.test(p.fingerprint)) problems.push('run.procedure.fingerprint.BAD')
    return problems.length > start ? null : { kind: 'procedure', procedure: { source: 'company_skill', skill: p.skill as string, fingerprint: p.fingerprint as string } }
  }
  problems.push('run.kind.BAD')
  return null
}

function parseMissed(v: unknown, problems: string[]): JobMissed | null {
  if (!isObj(v) || !keysExactly(v, ['policy', 'expiresAfterMinutes'], 'missed', problems)) { if (!isObj(v)) problems.push('missed.BAD'); return null }
  const start = problems.length
  if (v.policy !== 'latest_only' && v.policy !== 'skip') problems.push('missed.policy.BAD')
  // At least one clock tick, at most a week.
  if (!isInt(v.expiresAfterMinutes, 5, 7 * 24 * 60)) problems.push('missed.expiresAfterMinutes.BAD')
  return problems.length > start ? null : { policy: v.policy as JobMissed['policy'], expiresAfterMinutes: v.expiresAfterMinutes as number }
}

function parseGrant(v: unknown, problems: string[]): JobGrant | null {
  if (!isObj(v) || !keysExactly(v, ['tools', 'creates', 'routes', 'reads', 'writes', 'outbound', 'limits'], 'grant', problems)) {
    if (!isObj(v)) problems.push('grant.BAD')
    return null
  }
  const start = problems.length
  const tools = uniqueStrings(v.tools, s => JOB_GRANT_TOOLS.includes(s), JOB_GRANT_TOOLS.length)
  if (!tools) problems.push('grant.tools.BAD')
  const creates = uniqueStrings(v.creates, s => JOB_CREATABLE_TYPES.includes(s), JOB_CREATABLE_TYPES.length)
  if (!creates) problems.push('grant.creates.BAD')
  const routes = uniqueStrings(v.routes, s => (AI_ROUTES as readonly string[]).includes(s), MAX_ROUTES)
  if (!routes) problems.push('grant.routes.BAD')
  let reads: JobGrant['reads'] | null = null
  if (isObj(v.reads) && keysExactly(v.reads, ['paths', 'calls'], 'grant.reads', problems)) {
    const paths = uniqueStrings(v.reads.paths, s => jobPathProblem(s) === null, MAX_PATHS)
    if (!paths) problems.push('grant.reads.paths.BAD')
    // Connector reads: refused to a run today (plugins' `callStepRefusal`), so none may be granted (memo D5 / §4-1).
    if (!Array.isArray(v.reads.calls) || v.reads.calls.length !== 0) problems.push('grant.reads.calls.BAD')
    if (paths && Array.isArray(v.reads.calls) && v.reads.calls.length === 0) reads = { paths, calls: [] }
  } else if (!isObj(v.reads)) problems.push('grant.reads.BAD')
  let writes: JobGrant['writes'] | null = null
  const w = v.writes
  if (isObj(w) && w.area === 'none') {
    if (keysExactly(w, ['area'], 'grant.writes', problems)) writes = { area: 'none' }
  } else if (isObj(w) && w.area === 'deliverable') {
    if (keysExactly(w, ['area', 'place', 'folder'], 'grant.writes', problems)) {
      if (jobPathProblem(w.place)) problems.push('grant.writes.place.BAD')
      if (typeof w.folder !== 'string' || !DELIVERABLE_FOLDER_RE.test(w.folder)) problems.push('grant.writes.folder.BAD')
      if (!jobPathProblem(w.place) && typeof w.folder === 'string' && DELIVERABLE_FOLDER_RE.test(w.folder)) writes = { area: 'deliverable', place: w.place as string, folder: w.folder }
    }
  } else problems.push('grant.writes.BAD')
  if (v.outbound !== 'none' && v.outbound !== 'draft_only') problems.push('grant.outbound.BAD')
  let limits: JobGrant['limits'] | null = null
  if (isObj(v.limits) && keysExactly(v.limits, ['minutes', 'runsPerDay'], 'grant.limits', problems)) {
    if (!isInt(v.limits.minutes, 1, 120)) problems.push('grant.limits.minutes.BAD')
    if (!isInt(v.limits.runsPerDay, 1, 24)) problems.push('grant.limits.runsPerDay.BAD')
    if (isInt(v.limits.minutes, 1, 120) && isInt(v.limits.runsPerDay, 1, 24)) limits = { minutes: v.limits.minutes, runsPerDay: v.limits.runsPerDay }
  } else if (!isObj(v.limits)) problems.push('grant.limits.BAD')
  if (problems.length > start || !tools || !creates || !routes || !reads || !writes || !limits) return null
  const grant: JobGrant = { tools, creates, routes, reads, writes, outbound: v.outbound as JobGrant['outbound'], limits }
  // Consistency: each power is named once, in the place that grants it.
  if (grant.reads.paths.length > 0 && !tools.includes('files_read')) problems.push('grant.reads.NEEDS_FILES_READ')
  if (tools.includes('files_read') && grant.reads.paths.length === 0) problems.push('grant.tools.FILES_READ_WITHOUT_PATHS')
  if ((grant.writes.area === 'deliverable') !== tools.includes('files_write')) problems.push('grant.writes.FILES_WRITE_MISMATCH')
  if ((grant.outbound === 'draft_only') !== tools.includes('outbound_draft')) problems.push('grant.outbound.OUTBOUND_DRAFT_MISMATCH')
  if (routes.length > 0 && !tools.includes('records') && !tools.includes('outbound_draft')) problems.push('grant.routes.NEEDS_RECORDS')
  return problems.length > start ? null : grant
}

/**
 * The one parser of a job's definition: strict (an unknown key or value anywhere is a problem), every
 * problem a short code (`trigger.at.BAD`) — never the value sent. A valid definition is returned as a
 * fresh object built from known keys only.
 */
export function parseJobDefinition(input: unknown): JobDefinitionResult {
  const problems: string[] = []
  if (!isObj(input)) return { ok: false, problems: ['BAD'] }
  const keys = ['schema', 'name', 'actingUser', 'trigger', 'check', 'run', 'placement', 'missed', 'grant']
  keysExactly(input, keys, 'definition', problems)
  if (!(JOB_SCHEMAS as readonly unknown[]).includes(input.schema)) problems.push('schema.UNKNOWN')
  const name = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : ''
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > JOB_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name) || name !== input.name) problems.push('name.BAD')
  if (typeof input.actingUser !== 'string' || !USER_ID_RE.test(input.actingUser)) problems.push('actingUser.BAD')
  const trigger = parseTrigger(input.trigger, problems)
  const check = parseCheck(input.check, problems)
  const run = parseRun(input.run, problems)
  if (!(JOB_PLACEMENTS as readonly unknown[]).includes(input.placement)) problems.push('placement.BAD')
  const missed = parseMissed(input.missed, problems)
  const grant = parseGrant(input.grant, problems)
  if (problems.length > 0 || !trigger || !check || !run || !missed || !grant) return { ok: false, problems: problems.length ? problems : ['BAD'] }
  const placement = input.placement as JobPlacement
  // What runs where: a server operation on the server, a procedure on the PC.
  if (run.kind === 'operation' && placement !== 'e') problems.push('placement.OPERATION_RUNS_ON_SERVER')
  if (run.kind === 'procedure' && placement !== 'a') problems.push('placement.PROCEDURE_RUNS_ON_PC')
  // D6: the clock alone never runs the AI — a procedure needs a check without the AI first.
  if (run.kind === 'procedure' && check.kind === 'none') problems.push('check.REQUIRED_FOR_PROCEDURE')
  // The server's operation runs no AI: it needs no AI powers, reads nothing on a PC.
  if (run.kind === 'operation' && (grant.tools.length > 0 || grant.routes.length > 0 || grant.reads.paths.length > 0 || check.kind !== 'none')) {
    problems.push('grant.OPERATION_TAKES_NO_AI_POWERS')
  }
  if (run.kind === 'operation' && !grant.creates.includes('task')) problems.push('grant.creates.OPERATION_NEEDS_TASK')
  // The AI creates through its record tools.
  if (run.kind === 'procedure' && grant.creates.length > 0 && !grant.tools.includes('records')) problems.push('grant.creates.NEEDS_RECORDS')
  if (check.kind === 'new_files' && !grant.reads.paths.includes(check.path)) problems.push('check.path.NOT_IN_READS')
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, definition: { schema: input.schema as JobSchema, name, actingUser: input.actingUser as string, trigger, check, run, placement, missed, grant } }
}

/** The canonical text of a whole definition (its version's fingerprint is sha256 of it). */
export function jobDefinitionCanonical(definition: JobDefinition): string {
  return canonicalJson(definition)
}

/**
 * The part of a definition the responsible person consents to (owner decision D4): who it runs as,
 * what runs and where, and the grant. A new version that keeps this part (a name, a time, the missed
 * policy, the check changed) needs no new acceptance; any change to it does.
 */
export function jobConsentCanonical(definition: JobDefinition): string {
  return canonicalJson({ actingUser: definition.actingUser, run: definition.run, placement: definition.placement, grant: definition.grant })
}

/** Every company path a definition names (what the responsible person must be able to read). */
export function jobDefinitionPaths(definition: JobDefinition): string[] {
  const paths = [...definition.grant.reads.paths]
  if (definition.check.kind === 'new_files') paths.push(definition.check.path)
  if (definition.grant.writes.area === 'deliverable') paths.push(definition.grant.writes.place)
  return [...new Set(paths)]
}

/** Why a job is paused (short codes, never text). */
export const JOB_PAUSE_REASONS = ['ADMIN', 'BY_RESPONSIBLE', 'OWNER_LEFT', 'OWNER_RIGHTS_CHANGED'] as const
export type JobPauseReason = typeof JOB_PAUSE_REASONS[number]
/** Pauses the server made by itself (the responsible person left, their rights shrank): told to owners/admins. */
export const JOB_SYSTEM_PAUSE_REASONS: readonly JobPauseReason[] = ['OWNER_LEFT', 'OWNER_RIGHTS_CHANGED']
