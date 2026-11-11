// A scheduled job's run on this PC (定期の仕事, placement `a`, B PR 5a-2, .claude/rules/jobs.md "The app's
// runner"): main's part, beside the record AI turns' (claims.ts), which hands it its claim / hold / finish
// machinery. The run itself is the same hidden consultation in the main window (useAiTurnRunner).
//   - turns: `GET /me/job-turns`, the occurrences this app can run (its check kinds), remembered for the claim;
//   - claim: the server's run (`POST /job-run-claims`, naming the checks this app runs), then the check — new
//     files in the grant's path, or the meetings the server found — before any AI: nothing found → the run
//     finishes `nothing` and no message is sent; then the pinned Skill read (a company Skill from the pinned
//     tree, a shelf Skill fetched and verified by its version) and the first message;
//   - while it runs: the grant's tool ceiling and write area for that consultation only, its `job_report`,
//     a stop just before the approved minutes run out, and a stop when the server takes the run away;
//   - settle: done with the reported title (the server makes the one やること), else a failure the server
//     sends where it belongs.
import path from 'node:path'
import { readdir, realpath, stat } from 'node:fs/promises'
import { JOB_PC_CHECK_KINDS, isOccurrenceId, parseJobRunResult, type JobRunResult } from '../../../../shared/core/jobs'
import { jobPathProblem } from '../../../../shared/core/jobs'
import {
  JOB_PC_STEP, jobFirstMessage, jobToolAccess, jobWriteArea, parseJobTurn, parseJobTurns,
  type JobFound, type JobToolAccess, type JobWriteArea, type QueuedJobTurn,
} from '../../../shared/ai-turn-steps/job'
import type { AiTurnClaimResult, AiTurnSettleResult } from '../../../shared/ai-turns'

type Session = (companyId: string, method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; data: unknown } | null>
type Failure = { class: 'temporary' | 'bad-input' | 'permission' | 'unknown-result'; code: string }

export interface JobRunDeps {
  /** claims.ts's own: the member's session call, holding a run (registry + renewal) and finishing it. */
  session: Session
  hold: (companyId: string, key: string, conversationId: string, run: { id: string; generation: number }, onLost: () => void) => void
  finishRun: (companyId: string, key: string, failure: Failure | null, extra?: { jobResult: JobRunResult }) => Promise<{ status: number } | null>
  /** Whether this app still holds that run (registered for the consultation's tokens, not taken away). */
  holds: (companyId: string, key: string, runId: string) => boolean
  deviceId: string
  /** A company Skill's SKILL.md at the pinned tree in the company folder (claims.ts's `readProcedure`); null = not here. */
  readCompanySkill: (companyId: string, skill: string, tree: string, companyRoot: string | null) => Promise<string | null>
  /** A shelf Skill's SKILL.md at the pinned version, fetched and checked against it; null = not readable. */
  readShelfSkill: (companyId: string, item: string, skill: string, version: string) => Promise<string | null>
  /**
   * Files (company paths) added under `place` in [since, until); null when this PC cannot tell (not downloaded, no
   * folder, a link on the way); `not-synced` when this PC has not fetched since `until` (a colleague's file may be missing).
   */
  newFiles: (companyRoot: string | null, place: string, since: string, until: string) => Promise<string[] | null | 'not-synced'>
  /** Stop the consultation's AI now (main's chat turns), saying why in its reply. */
  stopTurn: (conversationId: string) => void
  now?: () => number
  log?: Pick<Console, 'warn'>
}

/** How long before the approved minutes run out the app stops its AI (the server refuses every call after them). */
export const JOB_STOP_BEFORE_MS = 60_000

interface Held {
  companyId: string
  occurrenceId: string
  runId: string
  access: JobToolAccess
  area: JobWriteArea
  report: { title: string; summary: string | null } | null
  timedOut: boolean
  lost: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export function createJobRuns(deps: JobRunDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  /** The member's turns as last listed, per company. */
  const listed = new Map<string, Map<string, QueuedJobTurn>>()
  /** Runs this app holds, by consultation. */
  const byConversation = new Map<string, Held>()
  const keyOf = (companyId: string, occurrenceId: string) => `${companyId}\n${occurrenceId}`
  const byOccurrence = new Map<string, string>()

  function forget(conversationId: string) {
    const h = byConversation.get(conversationId)
    if (!h) return
    if (h.timer) clearTimeout(h.timer)
    byConversation.delete(conversationId)
    byOccurrence.delete(keyOf(h.companyId, h.occurrenceId))
  }

  async function findings(turn: QueuedJobTurn, companyRoot: string | null): Promise<JobFound | null | 'not-synced'> {
    if (turn.check.kind === 'new_meetings') return { kind: 'meetings', meetings: turn.meetings ?? [] }
    if (turn.check.kind === 'new_files') {
      // The window ends at the occurrence's own time (an older server: now).
      const until = turn.checkUntil ?? new Date(now()).toISOString()
      const files = await deps.newFiles(companyRoot, turn.check.path, turn.checkSince, until).catch(() => null)
      return files === null || files === 'not-synced' ? files : { kind: 'files', files }
    }
    return null
  }

  /** The run is still this app's: not taken away (renew 409) and still registered for the consultation's tokens. */
  const live = (h: Held) => !h.lost && deps.holds(h.companyId, h.occurrenceId, h.runId)

  return {
    /** The occurrences this app can run now; not readable (offline, an older server) → the last list. */
    async turns(companyId: string): Promise<QueuedJobTurn[]> {
      const r = await deps.session(companyId, 'GET', '/me/job-turns')
      const turns = r?.status === 200 ? parseJobTurns(r.data) : null
      if (turns === null) return [...(listed.get(companyId)?.values() ?? [])]
      listed.set(companyId, new Map(turns.map(t => [t.occurrenceId, t])))
      return turns
    },

    /** Whether the runner's id is a job occurrence this app listed (claims.ts routes the claim here). */
    isJob(companyId: string, id: string): boolean {
      return isOccurrenceId(id) && !!listed.get(companyId)?.has(id)
    },

    /**
     * Claim the occurrence's run for this consultation, run the check, read the pinned procedure. The common
     * refusals (window, agent, emergency stop, stop policy) are claims.ts's, made before this is asked.
     */
    async claim(companyId: string, occurrenceId: string, conversationId: string, companyRoot: string | null): Promise<AiTurnClaimResult> {
      if (!listed.get(companyId)?.has(occurrenceId)) return { claimed: false, reason: 'not-allowed' }
      const answer = await deps.session(companyId, 'POST', '/job-run-claims', { occurrenceId, deviceId: deps.deviceId, conversationId, checks: [...JOB_PC_CHECK_KINDS] })
      if (!answer || answer.status >= 500) return { claimed: false, reason: 'unavailable' }
      const data = answer.status < 300 ? answer.data as { run?: { id?: unknown; generation?: unknown; createdAt?: unknown; updatedAt?: unknown }; turn?: unknown } | undefined : undefined
      const run = data?.run
      // The turn as the claim answered it (the meetings found are only there): the server's, not the list's.
      const turn = parseJobTurn(data?.turn)
      if (!run || typeof run.id !== 'string' || typeof run.generation !== 'number') {
        listed.get(companyId)?.delete(occurrenceId)
        return { claimed: false, reason: 'taken' }
      }
      const key = keyOf(companyId, occurrenceId)
      const claimedAt = now()
      const held: Held = { companyId, occurrenceId, runId: run.id, access: { allowsRecordTool: () => false, builtinTools: [] }, area: { nowhere: true, reads: [] }, report: null, timedOut: false, lost: false, timer: null }
      // Taken away by the server (a pause, the company's stop, the time limit, another PC): the AI stops here too.
      deps.hold(companyId, occurrenceId, conversationId, { id: run.id, generation: run.generation }, () => {
        held.lost = true
        if (byConversation.get(conversationId) === held) deps.stopTurn(conversationId)
      })
      const giveUp = async (failure: Failure): Promise<AiTurnClaimResult> => {
        await deps.finishRun(companyId, occurrenceId, failure)
        return { claimed: false, reason: 'unavailable' }
      }
      if (!turn || turn.occurrenceId !== occurrenceId) return giveUp({ class: 'bad-input', code: 'TURN_NOT_READABLE' })
      // The check, before any AI (D6).
      const found = await findings(turn, companyRoot)
      if (found === null) return giveUp({ class: 'bad-input', code: 'CHECK_NOT_POSSIBLE' })
      // Not synced since the window's end: a colleague's file may not be here yet — never `nothing` on a guess.
      if (found === 'not-synced') return giveUp({ class: 'temporary', code: 'NOT_SYNCED' })
      if ((found.kind === 'files' ? found.files.length : found.meetings.length) === 0) {
        const r = await deps.finishRun(companyId, occurrenceId, null, { jobResult: 'nothing' })
        if (!r || r.status >= 300) log.warn(`[jobs] finish (nothing): answered ${r?.status ?? 'nothing'}`)
        listed.get(companyId)?.delete(occurrenceId)
        return { claimed: false, reason: 'taken' }
      }
      const procedure = turn.procedure.source === 'company_skill'
        ? await deps.readCompanySkill(companyId, turn.procedure.skill, turn.procedure.fingerprint, companyRoot).catch(() => null)
        : await deps.readShelfSkill(companyId, turn.procedure.item, turn.procedure.skill, turn.procedure.fingerprint).catch(() => null)
      // Not on this PC yet (not synced, the shelf unreachable): tried again later.
      if (procedure === null) return giveUp({ class: 'temporary', code: 'PROCEDURE_NOT_HERE' })
      // The approved minutes count from the run's first claim, on the server's clock; on this PC's clock that is
      // shifted by how far the two differ (the claim's own time on the server vs here).
      const serverMs = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null)
      const started = serverMs(run.createdAt)
      const serverNow = serverMs(run.updatedAt)
      const skew = serverNow !== null ? claimedAt - serverNow : 0
      const deadlineMs = (started ?? claimedAt - skew) + skew + turn.grant.limits.minutes * 60_000
      const left = deadlineMs - JOB_STOP_BEFORE_MS - now()
      if (left <= 0) return giveUp({ class: 'bad-input', code: 'TIME_LIMIT' })
      held.access = jobToolAccess(turn.grant, turn.check)
      held.area = jobWriteArea(turn.grant)
      held.timer = setTimeout(() => {
        held.timedOut = true
        if (byConversation.get(conversationId) === held) deps.stopTurn(conversationId)
      }, left)
      held.timer.unref?.()
      // Taken away while the check or the procedure was being read: nothing starts (the run is the server's again).
      if (!live(held)) {
        clearTimeout(held.timer)
        return { claimed: false, reason: 'unavailable' }
      }
      byConversation.set(conversationId, held)
      byOccurrence.set(key, conversationId)
      const deadline = new Date(deadlineMs - JOB_STOP_BEFORE_MS)
      return {
        claimed: true, version: null,
        message: jobFirstMessage({ name: turn.name, found, procedure, grant: turn.grant, deadline: `${deadline.getHours()}:${String(deadline.getMinutes()).padStart(2, '0')}` }),
      }
    },

    /** The ceiling of a job run's consultation this app holds (the chat server asks it); null for anything else. */
    toolsOf(conversationId: string, step: string): JobToolAccess | null {
      const h = byConversation.get(conversationId)
      // No live run (taken away, released): no ceiling, so the chat server refuses the turn — never an ordinary one.
      return h && step === JOB_PC_STEP && live(h) ? h.access : null
    },

    /** Where a job run's consultation may write; null when it is not one. */
    writeAreaOf(conversationId: string): JobWriteArea | null {
      return byConversation.get(conversationId)?.area ?? null
    },

    /** The run's `job_report` (only for a consultation this app holds a job run for). */
    reporter(conversationId: string): ((result: unknown) => string | null) | null {
      const h = byConversation.get(conversationId)
      if (!h) return null
      return (result: unknown) => {
        const parsed = parseJobRunResult(result)
        if (parsed === null || parsed === 'nothing') return 'title は1行・80文字まで、summary は300文字までにしてください。'
        h.report = parsed
        return null
      }
    },

    /** After the turn: done with the reported title, or a failure (the server decides where it goes). */
    async settle(companyId: string, occurrenceId: string): Promise<AiTurnSettleResult> {
      const conversationId = byOccurrence.get(keyOf(companyId, occurrenceId))
      const h = conversationId ? byConversation.get(conversationId) : undefined
      if (!h || !conversationId) return { outcome: 'unknown' }
      forget(conversationId)
      listed.get(companyId)?.delete(occurrenceId)
      if (h.lost) {
        await deps.finishRun(companyId, occurrenceId, { class: 'temporary', code: 'RUN_LOST' })
        return { outcome: 'failed' }
      }
      if (h.report) {
        const r = await deps.finishRun(companyId, occurrenceId, null, { jobResult: h.report })
        // Refused (the time ran out, paused, stopped): the person looks; the consultation stays open.
        return { outcome: r && r.status < 300 ? 'done' : 'failed' }
      }
      // Stopped at its time limit without a report: a person looks (needs_person); otherwise tried again later.
      await deps.finishRun(companyId, occurrenceId, h.timedOut ? { class: 'bad-input', code: 'TIME_LIMIT' } : { class: 'temporary', code: 'UNFINISHED' })
      return { outcome: h.timedOut ? 'failed' : 'put-back' }
    },
  }
}

export type JobRuns = ReturnType<typeof createJobRuns>

/** At most this many files a check lists (the rest is not needed to know there is something). */
const NEW_FILES_MAX = 200
const SKIP = new Set(['.git', '.backups', '.workspace', '.personal', 'node_modules'])

/**
 * Files changed under `place` after `since`, in a working folder (no shared company folder): by their
 * modification time. `root` is the working folder (validated by the caller); null when the place is not
 * on this PC.
 */
export async function newFilesByTime(root: string, place: string, since: string, until: string): Promise<string[] | null> {
  const start = await placeOnDisk(root, place)
  if (start === null) return null
  const sinceMs = Date.parse(since)
  const untilMs = Date.parse(until)
  const out: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= NEW_FILES_MAX || depth > 10) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= NEW_FILES_MAX) return
      if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(full, childRel, depth + 1)
      else if (entry.isFile()) {
        const s = await stat(full).catch(() => null)
        if (s && s.mtimeMs >= sinceMs && s.mtimeMs < untilMs) out.push(childRel)
      }
    }
  }
  await walk(start, place, 0)
  return out
}

/**
 * Files added under `place` after `since` in the shared company folder, from git's history (what sync
 * brought), not from times on disk (a checkout sets them). The place's own repository: the company's, or a
 * private folder's clone above it. null when the place is not on this PC (not downloaded).
 */
export async function newFilesByGit(git: (cwd: string, args: string[]) => Promise<string>, root: string, place: string, since: string, until: string): Promise<string[] | null | 'not-synced'> {
  const target = await placeOnDisk(root, place)
  if (target === null) return null
  root = await realpath(root)
  const segments = place.split('/')
  // The innermost repository holding the place (a private folder is a clone of its own inside the company folder).
  let repo = root
  for (let i = segments.length; i > 0; i--) {
    const candidate = path.join(root, ...segments.slice(0, i))
    if (await stat(path.join(candidate, '.git')).catch(() => null)) { repo = candidate; break }
  }
  const relInRepo = path.relative(repo, target).split(path.sep).join('/') || '.'
  const repoPrefix = path.relative(root, repo).split(path.sep).join('/')
  // Fetched from the server since the window's end? Else a colleague's file may not be here yet.
  const fetchHead = await git(repo, ['rev-parse', '--git-path', 'FETCH_HEAD']).then(p => p.trim()).catch(() => null)
  const fetched = fetchHead ? await stat(path.resolve(repo, fetchHead)).catch(() => null) : null
  if (!fetched || fetched.mtimeMs < Date.parse(until)) return 'not-synced'
  const outText = await git(repo, ['log', `--since=${new Date(Date.parse(since)).toISOString()}`, `--until=${new Date(Date.parse(until)).toISOString()}`, '--diff-filter=A', '--name-only', '--format=', '-z', '--', relInRepo]).catch(() => null)
  if (outText === null) return null
  const files = [...new Set(outText.split('\0').map(s => s.trim()).filter(Boolean))]
  return files.slice(0, NEW_FILES_MAX).map(f => (repoPrefix ? `${repoPrefix}/${f}` : f))
}

/**
 * The place as a folder on this PC, or null: a valid company path, a folder, and **no link on the way** — its real
 * location is exactly the place inside the company folder (a link committed at the place, or above it, could
 * otherwise list another company's files or reach another repository). Compared in NFC, A–Z folded.
 */
async function placeOnDisk(root: string, place: string): Promise<string | null> {
  if (jobPathProblem(place) !== null) return null
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return null
  const target = path.join(realRoot, ...place.split('/'))
  const real = await realpath(target).catch(() => null)
  const key = (p: string) => p.normalize('NFC').toLowerCase()
  if (!real || key(real) !== key(target)) return null
  return (await stat(real).catch(() => null))?.isDirectory() ? real : null
}
