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
import { AI_ROUTES, AI_TURN_BASE_ROUTES } from './ai-turn-routes'
import { BUILTIN_CONNECTORS, isBuiltinConnectorId, type DeliveryPlaceKind } from './builtin-connectors'
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
 * `new_meetings` (B PR 5a-2): a meeting the responsible person attended since the previous occurrence
 * (the server finds them: `meeting` records whose people-only list names them), only those whose title
 * holds one of `titleWords` when any are given; its run may read those meetings' minutes only, and only
 * when the grant names `JOB_MINUTES_ROUTE` (part of what the responsible person accepts).
 */
export type JobCheck = { kind: 'none' } | { kind: 'new_files'; path: string } | { kind: 'new_meetings'; titleWords: string[] }

/** The checks a PC can run (`none` is the server's operation only). The app says which it runs when it claims. */
export const JOB_PC_CHECK_KINDS = ['new_files', 'new_meetings'] as const
export type JobPcCheckKind = typeof JOB_PC_CHECK_KINDS[number]
export const JOB_TITLE_WORDS_MAX = 5
export const JOB_TITLE_WORD_MAX = 40
/** The route that reads a meeting's minutes (`minutes_read`): a PC job's run reaches it only for the meetings its check found. */
export const JOB_MINUTES_ROUTE = 'GET /minutes/:recordId/text'

/**
 * A job's procedure, pinned when its version is made (the server reads the fingerprint, never the
 * caller): a company Skill of the shared company folder at its tree id (`company_skill`), or — in a
 * company without the shared folder (B PR 5a) — a Skill of the Skill shelf (`shelf_skill`): the shelf
 * item (`item`, which fixes its place) at its version (`fingerprint`, sha256 of `shelfListing`), `skill`
 * its name as the shelf had it.
 */
export type JobProcedure =
  | { source: 'company_skill'; skill: string; fingerprint: string }
  | { source: 'shelf_skill'; item: string; skill: string; fingerprint: string }

/**
 * What runs. `operation` (placement `e`, on the server, no AI): today only `create_task` — a やること for
 * the responsible person titled `title`, due `dueBusinessDays` business days after the occurrence
 * (null: none). `procedure` (placement `a`, the responsible person's PC): a Skill pinned at the
 * fingerprint the server read when this version was made (`JobProcedure`).
 */
export type JobRun =
  | { kind: 'operation'; operation: 'create_task'; title: string; dueBusinessDays: number | null }
  | { kind: 'procedure'; procedure: JobProcedure }

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
 * A place outside ACB where a job's deliverables go (owner decision 2026-11-11): a connector and a kind of
 * place it declares (`BUILTIN_CONNECTORS[…].deliveryPlaces`), and `ref` — the exact place. Never one
 * service's own field, so another connector's place (OneDrive, Box) is another `connector` / `kind`, not a new
 * shape. In a definition `ref` is null: the responsible person chooses it when accepting (`chosenBy:
 * 'responsible'` — under a per-member permission such as Drive's `drive.file` only their own pick opens it);
 * the accepted place has it filled (`parseJobAcceptedPlace`).
 */
export interface JobDeliveryPlace {
  connector: string
  kind: string
  ref: string | null
}

/**
 * The grant (実行契約, design memo §4-1): the most a run of this version may do, on top of the
 * responsible person's own rights. `routes` are names from `AI_ROUTES` (no conditions in schema 1);
 * `reads.calls` (connector reads) stays empty; `writes`: nothing, or only the deliverable folder
 * `<place>/.personal/<folder>/` on the PC; `outbound`: `none`, or drafts only (sending is always a
 * person's); `limits`: minutes per run and runs per day. `deliverTo` (absent = none): a place outside ACB
 * the run may also put its deliverables (made in the deliverable folder first) into — and nothing else there.
 */
export interface JobGrant {
  tools: string[]
  creates: string[]
  routes: string[]
  reads: { paths: string[]; calls: never[] }
  writes: { area: 'none' } | { area: 'deliverable'; place: string; folder: string }
  outbound: 'none' | 'draft_only'
  limits: { minutes: number; runsPerDay: number }
  deliverTo?: JobDeliveryPlace
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
const SHELF_VERSION_RE = /^[0-9a-f]{64}$/
/** A shelf item's id (the server's own: a UUID today). */
export const SHELF_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const DELIVERABLE_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** An accepted place's `ref` (a connector's own id: a Drive folder id today). */
const PLACE_REF_RE = /^[A-Za-z0-9_-]{1,200}$/
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
  if (v.kind === 'new_meetings') {
    if (!keysExactly(v, ['kind', 'titleWords'], 'check', problems)) return null
    const words = uniqueStrings(v.titleWords, w => {
      const t = w.normalize('NFC').trim()
      // eslint-disable-next-line no-control-regex
      return t === w && t.length > 0 && t.length <= JOB_TITLE_WORD_MAX && !/[\u0000-\u001f\u007f]/.test(t)
    }, JOB_TITLE_WORDS_MAX)
    if (!words) { problems.push('check.titleWords.BAD'); return null }
    return { kind: 'new_meetings', titleWords: words }
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
    if (!isObj(p)) { problems.push('run.procedure.BAD'); return null }
    const shelf = p.source === 'shelf_skill'
    if (!keysExactly(p, shelf ? ['source', 'item', 'skill', 'fingerprint'] : ['source', 'skill', 'fingerprint'], 'run.procedure', problems)) return null
    const start = problems.length
    if (p.source !== 'company_skill' && !shelf) problems.push('run.procedure.source.BAD')
    if (shelf && (typeof p.item !== 'string' || !SHELF_ITEM_ID_RE.test(p.item))) problems.push('run.procedure.item.BAD')
    if (typeof p.skill !== 'string' || !isValidSkillName(p.skill) || p.skill.length > 64) problems.push('run.procedure.skill.BAD')
    // A shelf version is sha256 (64 hex); a tree id is 40 or 64 hex.
    if (typeof p.fingerprint !== 'string' || !(shelf ? SHELF_VERSION_RE : FINGERPRINT_RE).test(p.fingerprint)) problems.push('run.procedure.fingerprint.BAD')
    if (problems.length > start) return null
    const procedure: JobProcedure = shelf
      ? { source: 'shelf_skill', item: p.item as string, skill: p.skill as string, fingerprint: p.fingerprint as string }
      : { source: 'company_skill', skill: p.skill as string, fingerprint: p.fingerprint as string }
    return { kind: 'procedure', procedure }
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

/** The kind of place a connector declares for a job's deliverables, or undefined. */
function deliveryKind(connector: unknown, kind: unknown): DeliveryPlaceKind | undefined {
  if (!isBuiltinConnectorId(connector)) return undefined
  const places: readonly DeliveryPlaceKind[] = BUILTIN_CONNECTORS[connector].deliveryPlaces
  return places.find(p => p.kind === kind)
}

/** A definition's place: a declared connector and kind, `ref` null (the responsible person chooses it when accepting). */
function parseDeliverTo(v: unknown, problems: string[]): JobDeliveryPlace | null {
  if (!isObj(v) || !keysExactly(v, ['connector', 'kind', 'ref'], 'grant.deliverTo', problems)) { if (!isObj(v)) problems.push('grant.deliverTo.BAD'); return null }
  const declared = deliveryKind(v.connector, v.kind)
  if (!declared) { problems.push('grant.deliverTo.UNKNOWN_PLACE'); return null }
  // Schema 1: the exact place is the responsible person's choice (chosenBy 'responsible'), never the definition's.
  if (v.ref !== null) { problems.push('grant.deliverTo.ref.CHOSEN_WHEN_ACCEPTING'); return null }
  return { connector: v.connector as string, kind: v.kind as string, ref: null }
}

/**
 * The place the responsible person chose when accepting (`POST /me/jobs/:jobId/accept { place }`): the version's
 * connector and kind, with `ref` filled (the connector's id of it). Null when it is not one.
 */
export function parseJobAcceptedPlace(v: unknown, of: JobDeliveryPlace): JobDeliveryPlace | null {
  if (!isObj(v) || Object.keys(v).length !== 3) return null
  if (v.connector !== of.connector || v.kind !== of.kind || typeof v.ref !== 'string' || !PLACE_REF_RE.test(v.ref)) return null
  return { connector: of.connector, kind: of.kind, ref: v.ref }
}

/** The connector's AI routes a run may use for its grant's deliverable place (none without one). */
export function jobDeliveryRoutes(grant: JobGrant): readonly string[] {
  return grant.deliverTo ? deliveryKind(grant.deliverTo.connector, grant.deliverTo.kind)?.routes ?? [] : []
}

/** The connector's app tools a run may use for its grant's deliverable place (none without one). */
export function jobDeliveryTools(grant: JobGrant): readonly string[] {
  return grant.deliverTo ? deliveryKind(grant.deliverTo.connector, grant.deliverTo.kind)?.tools ?? [] : []
}

/** How the run puts a file into its chosen place (the first message's sentence, the place's id in it), or null. */
export function jobDeliveryHowTo(place: JobDeliveryPlace): string | null {
  const declared = deliveryKind(place.connector, place.kind)
  return declared && typeof place.ref === 'string' ? declared.howToPut.replace('{ref}', place.ref) : null
}

/** How long a chosen place of this kind lasts (the connector's sentence), or null for one this build does not know. */
export function jobDeliveryLapseNote(place: { connector: string; kind: string }): string | null {
  return deliveryKind(place.connector, place.kind)?.lapseNote ?? null
}

/** The words of a deliverable place's kind (「Google Drive のフォルダ」), or null for one this build does not know. */
export function jobDeliveryLabel(place: { connector: string; kind: string }): string | null {
  return deliveryKind(place.connector, place.kind)?.label ?? null
}

function parseGrant(v: unknown, problems: string[]): JobGrant | null {
  // `deliverTo` is optional (absent = none): a definition without it is exactly what it was before.
  const grantKeys = ['tools', 'creates', 'routes', 'reads', 'writes', 'outbound', 'limits', ...(isObj(v) && Object.prototype.hasOwnProperty.call(v, 'deliverTo') ? ['deliverTo'] : [])]
  if (!isObj(v) || !keysExactly(v, grantKeys, 'grant', problems)) {
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
  const deliverTo = grantKeys.includes('deliverTo') ? parseDeliverTo(v.deliverTo, problems) : undefined
  if (problems.length > start || !tools || !creates || !routes || !reads || !writes || !limits || deliverTo === null) return null
  const grant: JobGrant = { tools, creates, routes, reads, writes, outbound: v.outbound as JobGrant['outbound'], limits, ...(deliverTo ? { deliverTo } : {}) }
  // Consistency: each power is named once, in the place that grants it.
  if (grant.reads.paths.length > 0 && !tools.includes('files_read')) problems.push('grant.reads.NEEDS_FILES_READ')
  if (tools.includes('files_read') && grant.reads.paths.length === 0) problems.push('grant.tools.FILES_READ_WITHOUT_PATHS')
  if ((grant.writes.area === 'deliverable') !== tools.includes('files_write')) problems.push('grant.writes.FILES_WRITE_MISMATCH')
  if ((grant.outbound === 'draft_only') !== tools.includes('outbound_draft')) problems.push('grant.outbound.OUTBOUND_DRAFT_MISMATCH')
  if (routes.length > 0 && !tools.includes('records') && !tools.includes('outbound_draft')) problems.push('grant.routes.NEEDS_RECORDS')
  // What goes outside is made in the deliverable folder first (the app puts a file from there).
  if (grant.deliverTo && grant.writes.area !== 'deliverable') problems.push('grant.deliverTo.NEEDS_DELIVERABLE')
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
  // The server's operation runs no AI: it needs no AI powers, reads nothing on a PC (and so puts nothing outside:
  // a place outside needs the deliverable folder, which needs `files_write`).
  if (run.kind === 'operation' && (grant.tools.length > 0 || grant.routes.length > 0 || grant.reads.paths.length > 0 || check.kind !== 'none')) {
    problems.push('grant.OPERATION_TAKES_NO_AI_POWERS')
  }
  if (run.kind === 'operation' && !grant.creates.includes('task')) problems.push('grant.creates.OPERATION_NEEDS_TASK')
  // The AI creates through its record tools.
  if (run.kind === 'procedure' && grant.creates.length > 0 && !grant.tools.includes('records')) problems.push('grant.creates.NEEDS_RECORDS')
  if (check.kind === 'new_files' && !grant.reads.paths.includes(check.path)) problems.push('check.path.NOT_IN_READS')
  // Reading the meetings' minutes is a power the responsible person accepts (the grant), not the check alone.
  if (check.kind === 'new_meetings' && !grant.routes.includes(JOB_MINUTES_ROUTE)) problems.push('check.NEEDS_MINUTES_ROUTE')
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

/**
 * An occurrence's state (design memo §3-2): `due` (made by the clock, waiting for its run), `running`
 * (a PC's run, PR 5), `done`, `nothing` (the check found nothing, PR 5), `needs_person` (the run could
 * not do its work: a person looks), `skipped` (not run on purpose: the responsible person absent, a
 * newer occurrence, missed under `skip`), `expired` (its time ran out before it ran), `held` (the job
 * or the company was stopped, or the job is not runnable as pinned: never run, also not on resume).
 */
export const JOB_OCCURRENCE_STATES = ['due', 'running', 'done', 'nothing', 'needs_person', 'skipped', 'expired', 'held'] as const
export type JobOccurrenceState = typeof JOB_OCCURRENCE_STATES[number]

/**
 * Why an occurrence ended as it did (`outcome_code`, short codes only, never text):
 * held — `JOB_PAUSED`, `COMPANY_STOPPED`, `NOT_ACCEPTED`, `JOB_VERSION_CHANGED` (another version was
 * approved after the occurrence was made), `OWNER_LEFT` / `OWNER_RIGHTS_CHANGED` (the job was paused for it);
 * skipped — `OWNER_ABSENT` (D5: no delegate runs it), `SUPERSEDED` (a newer occurrence, `latest_only`),
 * `MISSED` (found late under `skip`); expired — `EXPIRED`; needs_person — `RECORDS_OFF`, `TASK_NOT_CREATED`,
 * `RUN_FAILED` (a PC's run ended waiting for a person), `TIME_LIMIT` (a PC's run past its approved minutes),
 * `RESULT_UNKNOWN` (a PC's run waits for a person to say whether an outside operation happened, and its time
 * ran out) — B PR 5a; `PLACE_NOT_USABLE` (the deliverable place the responsible person chose can no longer be used
 * — a Drive folder pick past its 90 days, or gone: they choose it again when accepting).
 */
export const JOB_OUTCOME_CODES = [
  'JOB_PAUSED', 'COMPANY_STOPPED', 'NOT_ACCEPTED', 'JOB_VERSION_CHANGED', 'OWNER_LEFT', 'OWNER_RIGHTS_CHANGED',
  'OWNER_ABSENT', 'SUPERSEDED', 'MISSED', 'EXPIRED', 'RECORDS_OFF', 'TASK_NOT_CREATED', 'RUN_FAILED', 'TIME_LIMIT', 'RESULT_UNKNOWN',
  'PLACE_NOT_USABLE',
] as const
export type JobOutcomeCode = typeof JOB_OUTCOME_CODES[number]

/**
 * 「もう一度」 (B PR 5b, jobs.md "「もう一度」"): the states an owner / admin may send back to `due` — an occurrence that
 * ended without doing its work and was told (`needs_person`, `expired`). Never `skipped` (an absence or a newer
 * occurrence decided it on purpose), `held` (a pause or the stop said not to run it), nor one that ran.
 */
export const JOB_RETRY_STATES: readonly JobOccurrenceState[] = ['needs_person', 'expired']

/**
 * Why 「もう一度」 cannot be pressed on an occurrence now (the API's codes; the words are job-words.ts
 * `jobRetryBlockText`): `NOT_RETRYABLE` (its state), `NOT_LATEST` (a later occurrence of the job came already:
 * its check covered this one's window), `JOB_PAUSED` / `JOB_STOPPED` (the job paused, the company's jobs stopped),
 * `AI_STOPPED` (the emergency stop covers its responsible person), `JOB_VERSION_CHANGED`, `JOB_NOT_ACCEPTED`,
 * `JOB_GRANT_EXCEEDS` (the responsible person's rights now), `JOB_SKILL_MISSING`, `JOB_PLACE_NOT_USABLE`,
 * `JOB_RESULT_UNKNOWN` (an outside operation of its run whose result nobody confirmed: 結果が分からないうちは再開しない).
 */
export const JOB_RETRY_BLOCKS = [
  'NOT_RETRYABLE', 'NOT_LATEST', 'JOB_PAUSED', 'JOB_STOPPED', 'AI_STOPPED', 'JOB_VERSION_CHANGED', 'JOB_NOT_ACCEPTED',
  'JOB_GRANT_EXCEEDS', 'JOB_SKILL_MISSING', 'JOB_PLACE_NOT_USABLE', 'JOB_RESULT_UNKNOWN',
] as const
export type JobRetryBlock = typeof JOB_RETRY_BLOCKS[number]

/**
 * The new deadline of an occurrence sent back by 「もう一度」: from the press, as long as the pinned version gives a
 * slot (`missed.expiresAfterMinutes`; the clock's `expires_at` = `due_at` + it) — the window the approved version
 * chose, counted from now instead of from the slot.
 */
export function jobRetryExpiresAt(nowMs: number, expiresAfterMinutes: number): string {
  return new Date(nowMs + expiresAfterMinutes * 60_000).toISOString()
}

/**
 * How late the clock may first see a slot and still count it on time (two clock runs): later than this
 * it was missed (the server was down) — `latest_only` runs it while not expired, `skip` does not.
 */
export const JOB_ON_TIME_MS = 10 * 60_000

/**
 * Who a server operation's change is by (the ledger's actor): the job itself, like the clock
 * (`CLOCK_ACTOR`) — kind `external`, an `acb:` id, so the cause is `system` (`ledgerCause`), with the
 * run's id beside it.
 */
export const JOB_ACTOR = Object.freeze({ id: 'acb:job', kind: 'external' as const, source: '定期の仕事' })

/** The step name of a job's server run (`ai_runs.step`): the server's own operation (placement `e`). */
export const JOB_SERVER_STEP = 'job-operation'

/** The id of the やること an occurrence's `create_task` makes: one per occurrence by construction. */
export function occurrenceTaskId(occurrenceId: string): string {
  if (!OCCURRENCE_ID_RE.test(occurrenceId)) throw new Error('occurrenceTaskId: not an occurrence id')
  return `task-${occurrenceId.slice(4)}`
}

/**
 * The step name of a PC job's run (`ai_runs.step`, placement `a`, B PR 5a): claimed by the responsible
 * person's app through `POST /job-run-claims`, never through the record claim.
 */
export const JOB_PC_STEP = 'job-procedure'

/** The outbound-draft routes (only with `grant.outbound: draft_only`). */
export const JOB_OUTBOUND_ROUTES: readonly string[] = ['POST /outbound-recipients', 'POST /outbound', 'GET /outbound/:messageId', 'PUT /outbound/:messageId']

/**
 * Every AI route a PC job's run may ever reach (B PR 5a, design memo §4-2), whatever its grant says: the
 * member's own record reads, mail drafts and (B PR 5a-2) the minutes of the meetings its `new_meetings` check
 * found — the server asks that per call (`jobRunRouteAllowed`'s `meetingFound`). Never a create (`POST /item`, `POST /decisions`: the one
 * やること a grant's `creates: ['task']` allows is made by the server when the run finishes, `JobRunResult`,
 * so a grant naming `POST /item` keeps its schema-1 shape but the token never creates), an action, a
 * plugin's operation or call, another connector read (threads, Drive, any other meeting's minutes) or a file link. A grant may
 * still name such a route (the parser takes every `AI_ROUTES` name): it is refused at every call. Beside it, only a grant
 * with a deliverable place outside (`deliverTo`) reaches that place's own routes (`jobDeliveryRoutes`: Drive's status,
 * put and receipt — never a read or a pick), and the connector's route puts only into the place the responsible person
 * chose (checked there, at every call).
 */
export const JOB_RUN_ROUTE_CEILING: readonly string[] = [
  'GET /types', 'GET /my-turn', 'POST /query', 'GET /item/:recordId', 'GET /item/:recordId/history',
  ...JOB_OUTBOUND_ROUTES,
  JOB_MINUTES_ROUTE,
]

/**
 * May a PC job's run use this AI route (`<METHOD> <path under /api/records-ai>`) under this grant? The
 * turn start's reads (`AI_TURN_BASE_ROUTES`) always; anything else only when the grant names it, it is
 * within `JOB_RUN_ROUTE_CEILING`, an outbound route only with `draft_only`, and the minutes route only for a
 * meeting the occurrence's check found (`meetingFound`, asked by the server per call; absent → never). The
 * server checks it at every call of the run's token.
 */
export function jobRunRouteAllowed(grant: JobGrant, route: string, meetingFound?: () => boolean): boolean {
  if ((AI_TURN_BASE_ROUTES as readonly string[]).includes(route)) return true
  // The deliverable place's own routes: only with a `deliverTo`, only those its connector declares for it.
  if (jobDeliveryRoutes(grant).includes(route)) return true
  if (!grant.routes.includes(route) || !JOB_RUN_ROUTE_CEILING.includes(route)) return false
  if (route === JOB_MINUTES_ROUTE) return meetingFound?.() === true
  return !JOB_OUTBOUND_ROUTES.includes(route) || grant.outbound === 'draft_only'
}

/**
 * What a PC job's run hands back when it finishes done (`POST /ai-runs/:runId/finish { jobResult }`):
 * `nothing` — the check found nothing new (no AI ran), the occurrence ends `nothing`; or the one やること
 * the server makes for the responsible person (owner-only, its id from the occurrence: one by
 * construction), `title` one line ≤ `JOB_TASK_TITLE_MAX`, `summary` ≤ 300 or null. Never a place: the
 * server places it.
 */
export type JobRunResult = 'nothing' | { title: string; summary: string | null }

export function parseJobRunResult(v: unknown): JobRunResult | null {
  if (v === 'nothing') return 'nothing'
  if (!isObj(v) || !Object.keys(v).every(k => k === 'title' || k === 'summary')) return null
  const title = typeof v.title === 'string' ? v.title.normalize('NFC').trim() : ''
  // eslint-disable-next-line no-control-regex
  if (title.length === 0 || title.length > JOB_TASK_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) return null
  if (v.summary !== undefined && v.summary !== null && (typeof v.summary !== 'string' || v.summary.length > 300)) return null
  const summary = typeof v.summary === 'string' && v.summary.trim() !== '' ? v.summary.normalize('NFC') : null
  return { title, summary }
}
