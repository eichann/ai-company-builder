/**
 * Scheduled jobs (定期の仕事, B 「実行を記録から分ける」 PR 3a, `.claude/rules/jobs.md`): definitions and
 * approval only — nothing runs yet (no clock, no occurrences, no claims: PR 3b on).
 *
 * Who (owner decisions 2026-11-10, D3 / D4 / D5 / D8 / D10):
 * - owner / admin create, edit (a new version: the approved one stays as it was), approve, pause,
 *   resume and stop all jobs of the company (「定期の仕事をすべて止める」).
 * - The responsible person (責任者, `actingUser`: whom it runs as) sees only their own jobs, accepts a
 *   version in their own name, and may pause their own job and resume a pause they made. No delegate
 *   acts for them (D5). Anyone else: a job they are not responsible for does not exist (404).
 * - A version needs acceptance again only when its consent (who, what runs, where, the grant:
 *   `jobConsentCanonical`) differs from the one accepted.
 * - At approval (and acceptance, and an owner/admin's resume) the server checks again that the
 *   responsible person is a member now and may read every place the version names, and that a pinned
 *   Skill is still the company's as pinned (design memo §4-3). Refusals are codes and fixed sentences:
 *   never a place, a Skill's content or a name.
 * - The responsible person leaving the company, or losing what the approved version needs on a role
 *   change, pauses the job (`OWNER_LEFT` / `OWNER_RIGHTS_CHANGED`) and tells every owner / admin
 *   (notice `job_paused`), in the same transaction as the change.
 */
import {
  JOB_SYSTEM_PAUSE_REASONS, isJobId, jobConsentCanonical, jobDefinitionCanonical, jobDefinitionPaths, newJobId, parseJobDefinition,
  type JobDefinition, type JobPauseReason,
} from '../../shared/core/jobs'
import type { JobList, JobState, JobVersionView, JobView, JobWaiting } from '../../shared/types/jobs'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobRow, JobVersionRow } from '../ports/jobs'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { hashCanonical } from '../lib/content-hash'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'

export const JOBS_FORBIDDEN = 'Only owners and admins can manage scheduled jobs'
const NOT_FOUND = () => refuse('not-found', '定期の仕事が見つかりません。', { code: 'JOB_NOT_FOUND' })
const BAD_DEFINITION = (problems: string[]) => refuse('bad-request', '定期の仕事の内容に正しくないところがあります。', { code: 'BAD_JOB_DEFINITION', problems })
const BAD_BODY = (what: string) => refuse('bad-request', `Body must be ${what}`, { code: 'BAD_REQUEST' })
const VERSION_NOT_FOUND = () => refuse('not-found', 'その版はありません。', { code: 'JOB_VERSION_NOT_FOUND' })
const FINGERPRINT_CHANGED = () => refuse('conflict', '画面に出ていた内容と違います。読み直してから、もう一度ためしてください。', { code: 'JOB_VERSION_FINGERPRINT' })
const OWNER_NOT_MEMBER = () => refuse('conflict', '責任者がこの会社のメンバーではありません。責任者を決め直してください。', { code: 'JOB_OWNER_NOT_MEMBER' })
const GRANT_EXCEEDS = () => refuse('conflict', '責任者の今の権限では、この仕事の範囲に足りません。範囲か責任者を見直してください。', { code: 'JOB_GRANT_EXCEEDS' })
const SKILL_MISSING = () => refuse('conflict', '会社のスキルが見つかりません。.claude/skills/ に置いて同期してから、もう一度ためしてください。', { code: 'JOB_SKILL_MISSING' })
const SKILL_CHANGED = () => refuse('conflict', '手順のスキルが、この版を作ったあとに変わりました。新しい版を作ってから承認してください。', { code: 'JOB_SKILL_CHANGED' })
const RETIRED = () => refuse('conflict', 'この定期の仕事はもう使われていません。', { code: 'JOB_RETIRED' })

export interface JobServiceDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  /** The git tree id of a company Skill now (`.claude/skills/<name>`), or null (none, or no shared folder). */
  skillTree: (companyId: string, name: string) => Promise<string | null>
}

const sha256 = hashCanonical
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function createJobService(deps: JobServiceDeps) {
  const { companyData, memberships, transactions, clock, ids } = deps
  const jobsOf = (companyId: string) => companyData.forCompany(companyId).jobs

  const definitionOf = (v: JobVersionRow): JobDefinition => JSON.parse(v.definition) as JobDefinition

  /** May `userId` (role `role`) read every place the definition names, now? */
  function readsAll(handle: CompanyData, userId: string, role: string, definition: JobDefinition): boolean {
    const reader = recordReader({ companyId: handle.companyId, userId, role }, handle.scopes.listWithRules())
    return jobDefinitionPaths(definition).every(p => reader.file(p))
  }

  /** The responsible person is a member and reads what the version names (design memo §4-3). */
  function withinRights(handle: CompanyData, definition: JobDefinition): Outcome<void> {
    const role = memberships.roleOf(handle.companyId, definition.actingUser)
    if (role === null) return OWNER_NOT_MEMBER()
    if (!readsAll(handle, definition.actingUser, role, definition)) return GRANT_EXCEEDS()
    return ok(undefined)
  }

  async function skillPinned(companyId: string, definition: JobDefinition): Promise<Outcome<void>> {
    if (definition.run.kind !== 'procedure') return ok(undefined)
    const tree = await deps.skillTree(companyId, definition.run.procedure.skill)
    if (tree === null) return SKILL_MISSING()
    return tree === definition.run.procedure.fingerprint ? ok(undefined) : SKILL_CHANGED()
  }

  /** The responsible person: of the approved version once there is one, else of the newest. */
  function responsibleOf(handle: CompanyData, job: JobRow): string {
    if (job.approvedVersion === null) return job.actingUserId
    return handle.jobs.version(job.id, job.approvedVersion)?.actingUserId ?? job.actingUserId
  }
  /** Is the member responsible for the job (its newest or approved version)? */
  function isResponsible(handle: CompanyData, job: JobRow, userId: string): boolean {
    return job.actingUserId === userId || responsibleOf(handle, job) === userId
  }

  /** The job as the member may see it; null = it does not exist for them. */
  function visibleJob(member: Member, jobId: unknown): { handle: CompanyData; job: JobRow } | null {
    if (!isJobId(jobId)) return null
    const handle = companyData.forCompany(member.companyId)
    const job = handle.jobs.find(jobId)
    if (!job) return null
    if (!hasFullAccess(member.role) && !isResponsible(handle, job, member.userId)) return null
    return { handle, job }
  }

  function consentAccepted(handle: CompanyData, job: JobRow): boolean {
    if (job.approvedVersion === null || job.acceptedConsent === null) return false
    const approved = handle.jobs.version(job.id, job.approvedVersion)
    return approved !== null && approved.consentFingerprint === job.acceptedConsent
  }

  function waitingOf(handle: CompanyData, job: JobRow, stopped: boolean): JobWaiting {
    if (job.state === 'paused' || job.state === 'retired') return 'PAUSED'
    if (stopped) return 'COMPANY_STOPPED'
    if (job.approvedVersion === null) return 'NOT_APPROVED'
    if (!consentAccepted(handle, job)) return 'NOT_ACCEPTED'
    return null
  }

  function view(member: Member, handle: CompanyData, job: JobRow, withVersions: boolean): JobView {
    const out: JobView = {
      id: job.id, name: job.name, state: job.state, actingUserId: job.actingUserId, latestVersion: job.latestVersion,
      approvedVersion: job.approvedVersion, accepted: consentAccepted(handle, job), pausedReason: job.pausedReason,
      waiting: waitingOf(handle, job, handle.jobs.stopped()), createdBy: job.createdBy, createdAt: job.createdAt, updatedAt: job.updatedAt,
    }
    if (withVersions) {
      const full = hasFullAccess(member.role)
      out.versions = handle.jobs.versions(job.id).map((v): JobVersionView => {
        const definition = definitionOf(v)
        // A responsible person who is not owner/admin sees a version's definition only while they read
        // every place it names (a draft may name one they cannot: its name is not theirs to learn).
        const shown = full || readsAll(handle, member.userId, member.role, definition)
        return {
          version: v.version, fingerprint: v.fingerprint, consentFingerprint: v.consentFingerprint, definition: shown ? definition : null,
          createdBy: v.createdBy, createdAt: v.createdAt, approvedBy: v.approvedBy, approvedAt: v.approvedAt, acceptedBy: v.acceptedBy, acceptedAt: v.acceptedAt,
        }
      })
    }
    return out
  }

  /**
   * The body's definition, checked and pinned: a procedure's Skill fingerprint is the server's (read
   * now), never the caller's; the responsible person must be a member now.
   */
  async function definitionFrom(companyId: string, body: unknown): Promise<Outcome<{ definition: JobDefinition; canonical: string }>> {
    if (!isObject(body) || Object.keys(body).length !== 1 || !isObject(body.definition)) return BAD_BODY('{ definition }')
    const input: Record<string, unknown> = { ...body.definition }
    let tree: string | null | undefined
    if (isObject(input.run) && input.run.kind === 'procedure' && isObject(input.run.procedure)) {
      const skill = input.run.procedure.skill
      tree = typeof skill === 'string' ? await deps.skillTree(companyId, skill) : null
      input.run = { ...input.run, procedure: { ...input.run.procedure, fingerprint: tree ?? '' } }
    }
    const parsed = parseJobDefinition(input)
    if (!parsed.ok) {
      // Everything else was right and only the Skill is not the company's: say that, not "bad definition".
      if (tree === null && parsed.problems.length === 1 && parsed.problems[0] === 'run.procedure.fingerprint.BAD') return SKILL_MISSING()
      return BAD_DEFINITION(parsed.problems)
    }
    if (memberships.roleOf(companyId, parsed.definition.actingUser) === null) return BAD_DEFINITION(['actingUser.NOT_MEMBER'])
    return ok({ definition: parsed.definition, canonical: jobDefinitionCanonical(parsed.definition) })
  }

  function versionRow(jobId: string, version: number, definition: JobDefinition, canonical: string, by: string, at: string): JobVersionRow {
    return {
      jobId, version, schema: definition.schema, definition: canonical, fingerprint: sha256(canonical),
      consentFingerprint: sha256(jobConsentCanonical(definition)), actingUserId: definition.actingUser, createdBy: by, createdAt: at,
      approvedBy: null, approvedAt: null, acceptedBy: null, acceptedAt: null,
    }
  }

  /** `{ version, fingerprint? }` */
  function versionBody(body: unknown): { version: number; fingerprint: string | null } | null {
    if (!isObject(body)) return null
    const keys = Object.keys(body)
    if (!keys.every(k => k === 'version' || k === 'fingerprint')) return null
    if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) return null
    if (body.fingerprint !== undefined && typeof body.fingerprint !== 'string') return null
    return { version: body.version, fingerprint: (body.fingerprint as string | undefined) ?? null }
  }

  /** Pause each job the member is responsible for, for `reason`, and tell every owner / admin (in the caller's transaction). */
  function pauseFor(companyId: string, jobs: JobRow[], reason: JobPauseReason, actorId: string) {
    if (jobs.length === 0) return
    const handle = companyData.forCompany(companyId)
    const at = clock.now()
    const admins = memberships.listByCompany(companyId).filter(m => hasFullAccess(m.role)).map(m => m.user_id)
    for (const job of jobs) {
      if (job.state === 'retired' || job.pausedReason === reason) continue
      handle.jobs.setState(job.id, 'paused', reason, actorId, at)
      handle.notifications.insert(admins.map(userId => ({
        id: ids.newId(), userId, kind: 'job_paused', recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
        dedupeKey: `job_paused:${job.id}:${reason}:${at}`, createdAt: at, readAt: null,
      })))
    }
  }

  return {
    /** `GET /jobs`: owner/admin every job; anyone else the jobs they are responsible for. */
    list(member: Member): Outcome<JobList> {
      const handle = companyData.forCompany(member.companyId)
      const full = hasFullAccess(member.role)
      const rows = full ? handle.jobs.list() : handle.jobs.listFor(member.userId)
      return ok({ stopped: handle.jobs.stopped(), canManage: full, jobs: rows.map(j => view(member, handle, j, false)) })
    },

    /** `GET /jobs/:jobId`: with every version, newest first. */
    get(member: Member, jobId: string): Outcome<JobView> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      return ok(view(member, found.handle, found.job, true))
    },

    /** `POST /jobs { definition }` (owner/admin): a draft with its first version. */
    async create(member: Member, body: unknown): Promise<Outcome<JobView>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      const parsed = await definitionFrom(member.companyId, body)
      if (!parsed.ok) return parsed
      const { definition, canonical } = parsed.value
      const handle = companyData.forCompany(member.companyId)
      const at = clock.now()
      const id = newJobId(ids.newId().replace(/-/g, '').toLowerCase())
      handle.jobs.create({
        id, name: definition.name, state: 'draft', actingUserId: definition.actingUser, latestVersion: 1, approvedVersion: null,
        approvedFingerprint: null, acceptedVersion: null, acceptedConsent: null, pausedReason: null, pausedBy: null, pausedAt: null,
        createdBy: member.userId, createdAt: at, updatedAt: at,
      }, versionRow(id, 1, definition, canonical, member.userId, at))
      return ok(view(member, handle, handle.jobs.find(id) as JobRow, true))
    },

    /** `PUT /jobs/:jobId { definition }` (owner/admin): a new version; the approved one keeps running as it was. */
    async update(member: Member, jobId: string, body: unknown): Promise<Outcome<JobView & { changed: boolean }>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      if (found.job.state === 'retired') return RETIRED()
      const parsed = await definitionFrom(member.companyId, body)
      if (!parsed.ok) return parsed
      const { definition, canonical } = parsed.value
      const { handle } = found
      const changed = transactions.run(() => {
        const job = handle.jobs.find(jobId) as JobRow
        const latest = handle.jobs.version(jobId, job.latestVersion)
        if (latest && latest.definition === canonical) return false
        handle.jobs.addVersion(versionRow(jobId, job.latestVersion + 1, definition, canonical, member.userId, clock.now()), clock.now())
        return true
      })
      return ok({ ...view(member, handle, handle.jobs.find(jobId) as JobRow, true), changed })
    },

    /** `POST /jobs/:jobId/approve { version, fingerprint? }` (owner/admin). */
    async approve(member: Member, jobId: string, body: unknown): Promise<Outcome<JobView>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const b = versionBody(body)
      if (!b) return BAD_BODY('{ version, fingerprint? }')
      const { handle } = found
      const v = handle.jobs.version(jobId, b.version)
      if (!v) return VERSION_NOT_FOUND()
      if (b.fingerprint !== null && b.fingerprint !== v.fingerprint) return FINGERPRINT_CHANGED()
      if (found.job.state === 'retired') return RETIRED()
      const definition = definitionOf(v)
      const skill = await skillPinned(member.companyId, definition)
      if (!skill.ok) return skill
      const result = transactions.run((): Outcome<void> => {
        // Checked again inside the write: the membership or the rules may have changed meanwhile.
        const rights = withinRights(handle, definition)
        if (!rights.ok) return rights
        const job = handle.jobs.find(jobId) as JobRow
        const state: JobState = job.state === 'draft' ? 'active' : job.state
        handle.jobs.approve(jobId, v.version, v.fingerprint, member.userId, clock.now(), state)
        return ok(undefined)
      })
      if (!result.ok) return result
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true))
    },

    /** `POST /me/jobs/:jobId/accept { version, fingerprint? }`: the approved version's responsible person, in their own name. */
    accept(member: Member, jobId: string, body: unknown): Outcome<JobView> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const b = versionBody(body)
      if (!b) return BAD_BODY('{ version, fingerprint? }')
      const { handle, job } = found
      const v = handle.jobs.version(jobId, b.version)
      if (!v) return VERSION_NOT_FOUND()
      if (v.actingUserId !== member.userId) return refuse('forbidden', 'この定期の仕事の責任者だけが受け取れます。', { code: 'JOB_NOT_RESPONSIBLE' })
      if (b.fingerprint !== null && b.fingerprint !== v.fingerprint) return FINGERPRINT_CHANGED()
      if (job.approvedVersion !== v.version) return refuse('conflict', 'まだ承認されていない版は受け取れません。', { code: 'JOB_NOT_APPROVED' })
      const result = transactions.run((): Outcome<void> => {
        const rights = withinRights(handle, definitionOf(v))
        if (!rights.ok) return rights
        handle.jobs.accept(jobId, v.version, v.consentFingerprint, member.userId, clock.now())
        return ok(undefined)
      })
      if (!result.ok) return result
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true))
    },

    /** `POST /jobs/:jobId/pause`: owner/admin (`ADMIN`), or the responsible person (`BY_RESPONSIBLE`). */
    pause(member: Member, jobId: string): Outcome<JobView> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const { handle, job } = found
      if (job.state === 'retired') return RETIRED()
      const reason: JobPauseReason = hasFullAccess(member.role) ? 'ADMIN' : 'BY_RESPONSIBLE'
      // An owner/admin's pause holds over the responsible person's own (who could otherwise resume it); a system pause stays as it is.
      if (job.state !== 'paused' || (reason === 'ADMIN' && job.pausedReason === 'BY_RESPONSIBLE')) {
        handle.jobs.setState(jobId, 'paused', reason, member.userId, clock.now())
      }
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true))
    },

    /**
     * `POST /jobs/:jobId/resume`: owner/admin any pause (an approved version's responsible person and
     * rights checked again); the responsible person only a pause they made themselves.
     */
    resume(member: Member, jobId: string): Outcome<JobView> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const { handle, job } = found
      if (job.state !== 'paused') return ok(view(member, handle, job, true))
      if (!hasFullAccess(member.role) && job.pausedReason !== 'BY_RESPONSIBLE') {
        return refuse('forbidden', '管理者が止めた定期の仕事は、管理者だけが再開できます。', { code: 'JOB_PAUSED_BY_ADMIN' })
      }
      const result = transactions.run((): Outcome<void> => {
        const current = handle.jobs.find(jobId) as JobRow
        if (current.approvedVersion !== null) {
          const approved = handle.jobs.version(jobId, current.approvedVersion) as JobVersionRow
          const rights = withinRights(handle, definitionOf(approved))
          if (!rights.ok) return rights
        }
        handle.jobs.setState(jobId, current.approvedVersion === null ? 'draft' : 'active', null, null, clock.now())
        return ok(undefined)
      })
      if (!result.ok) return result
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true))
    },

    /** `PUT /jobs-stop { stopped }` (owner/admin): 「定期の仕事をすべて止める」 (owner decision D8). */
    setStopped(member: Member, body: unknown): Outcome<{ stopped: boolean }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.stopped !== 'boolean') return BAD_BODY('{ stopped: boolean }')
      companyData.forCompany(member.companyId).jobs.setStopped(body.stopped, member.userId, clock.now())
      return ok({ stopped: body.stopped })
    },

    /**
     * The member left the company (`companies.removeMember`, in its transaction): every job whose newest
     * or approved version names them is paused (`OWNER_LEFT`) and every owner / admin is told.
     */
    memberLeft(companyId: string, userId: string, actorId: string): void {
      pauseFor(companyId, jobsOf(companyId).listFor(userId), 'OWNER_LEFT', actorId)
    },

    /**
     * The member's role changed (`companies.changeRole`, in its transaction): a job whose approved
     * version they are responsible for and no longer fits within what they may read is paused
     * (`OWNER_RIGHTS_CHANGED`) and every owner / admin is told. (A permission rule changed elsewhere is
     * not looked at here: the run's own checks come with PR 3b / 5, design memo §4-2.)
     */
    roleChanged(companyId: string, userId: string, actorId: string): void {
      const handle = companyData.forCompany(companyId)
      const role = memberships.roleOf(companyId, userId)
      if (role === null) return
      const lost = handle.jobs.listFor(userId).filter(job => {
        if (job.approvedVersion === null) return false
        if (job.state === 'paused' && JOB_SYSTEM_PAUSE_REASONS.includes(job.pausedReason as JobPauseReason)) return false
        const v = handle.jobs.version(job.id, job.approvedVersion)
        if (!v || v.actingUserId !== userId) return false
        return !readsAll(handle, userId, role, definitionOf(v))
      })
      pauseFor(companyId, lost, 'OWNER_RIGHTS_CHANGED', actorId)
    },

    /** The job's name for a notice the member may read now (owner/admin only), or null. */
    noticeJob(member: Member, jobId: string): { name: string } | null {
      if (!hasFullAccess(member.role) || !isJobId(jobId)) return null
      const job = jobsOf(member.companyId).find(jobId)
      return job ? { name: job.name } : null
    },
  }
}

export type JobService = ReturnType<typeof createJobService>
