/**
 * A member proposes a time job from the AI chat (「AIへの相談」から定期の仕事, owner memo 2026-11-22 第1〜5版, `.claude/rules/jobs.md`
 * "Member proposals"; PR A, the server). The definitions, approval and acceptance stay services/jobs.ts's.
 *
 * - **A candidate** (案の候補, `POST /api/records-ai/job-proposals-ai/candidates`, the member's AI): the server builds a schema-4 definition
 *   from list values only — the responsible person fixed to the signed-in member **before** any Skill is read, an existing
 *   Skill pinned now (its version / tree), places that exist and are the member's to read (and, for the deliverable, to
 *   write), the name and the deliverable folder made by the server — and keeps it for its creator alone, 24 hours, at most 20
 *   a member. Never a job, so never in any job list. **Refused to a token bound to an execution run** (a scheduled job's run,
 *   an 「AI の番」): nobody watches those, so a proposal never comes from one.
 * - **The submit** (`POST /me/job-candidates/:id/submit { fingerprint }`, the member's session only — no record-token route
 *   reaches it): the candidate as stored (never resolved again), the fingerprint the card showed, the member's rights and
 *   the Skill checked again; then, in one transaction, the draft job (version 1, created by the member), its proposal record
 *   and one notice per owner / admin — at most 5 waiting and 10 submits a company day per member, counted in that
 *   transaction. Idempotent by the permanent (company, proposer, candidate) record, also after the content's 24 hours.
 * - **Withdraw** (the proposer) and **return** (an owner / admin, a fixed reason code) move a proposal from `submitted` only
 *   (compare-and-set; the first approval in services/jobs.ts is the third way out), and retire its job.
 */
import { DEFAULT_COMPANY_TIME_ZONE } from '../../shared/core/calendar'
import {
  JOB_CANDIDATES_PER_MEMBER, JOB_CANDIDATE_TTL_MS, JOB_PROPOSALS_PER_DAY, JOB_PROPOSALS_WAITING_MAX, JOB_PROPOSAL_STATES,
  isJobCandidateId, isJobProposalId, isJobProposalReturnReason, jobCandidatePlaces, jobProposalReturnReasonText, newJobCandidateId, newJobProposalId,
  parseJobCandidateInput, proposalDefinition, type JobProposalReturnReason,
} from '../../shared/core/job-proposals'
import {
  JOB_PROPOSAL_SCHEMA, jobDefinitionCanonical, jobPathProblem, newJobId, parseJobDefinition, storedJobDefinition,
  type JobDefinition, type JobProcedure,
} from '../../shared/core/jobs'
import { resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import type { JobCandidatePlaces, JobCandidateView, JobProposalView } from '../../shared/types/job-proposals'
import { hashCanonical } from '../lib/content-hash'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobCandidateRow, JobProposalRow } from '../ports/jobs'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess, type Member } from './access'
import { companyTimeToUtc } from './job-occurrences'
import { HIDDEN_JOB_NAME, JOBS_FORBIDDEN, versionRow, type JobService } from './jobs'
import { companyNow } from './notifications'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'

const NOT_IN_RUN = () => refuse('forbidden', '定期の仕事や「AI の番」で動いている AI は、定期の仕事の案を作れません。', { code: 'JOB_PROPOSAL_NOT_IN_RUN' })
const BAD_INPUT = (problems: string[]) => refuse('bad-request', '定期の仕事の案の内容に正しくないところがあります。', { code: 'BAD_JOB_CANDIDATE', problems })
const BAD_DEFINITION = (problems: string[]) => refuse('bad-request', '定期の仕事の内容に正しくないところがあります。', { code: 'BAD_JOB_DEFINITION', problems })
const BAD_BODY = (what: string) => refuse('bad-request', `Body must be ${what}`, { code: 'BAD_REQUEST' })
/** One answer for a place that is not there and one the member may not read (or write): never which. */
const PLACE_REFUSED = () => refuse('conflict', '選んだ場所は、あなたが読めない（置けない）か、ありません。あなたが使えるフォルダから選んでください。', { code: 'JOB_CANDIDATE_PLACE' })
const PLACE_NOT_FOUND = () => refuse('not-found', 'その場所はありません。', { code: 'JOB_PLACE_NOT_FOUND' })
const SKILL_MISSING = () => refuse('conflict', 'その Skill はまだありません。先に Skill を作ってから、もう一度頼んでください。', { code: 'JOB_SKILL_MISSING' })
const CANDIDATES_FULL = () => refuse('conflict', '定期の仕事の案の候補が多すぎます。しばらくたってから（24時間で消えます）、もう一度ためしてください。', { code: 'JOB_CANDIDATES_LIMIT' })
const CANDIDATE_NOT_FOUND = () => refuse('not-found', '定期の仕事の案が見つかりません（24時間たつと消えます）。もう一度 AI に頼んでください。', { code: 'JOB_CANDIDATE_NOT_FOUND' })
const FINGERPRINT_CHANGED = () => refuse('conflict', '画面に出ていた内容と違います。読み直してから、もう一度ためしてください。', { code: 'JOB_VERSION_FINGERPRINT' })
const GRANT_EXCEEDS = () => refuse('conflict', 'あなたの今の権限では、この案の範囲に足りません。AI にもう一度頼んでください。', { code: 'JOB_GRANT_EXCEEDS' })
const WAITING_FULL = () => refuse('conflict', `管理者の確認を待っている案が${JOB_PROPOSALS_WAITING_MAX}つあります。どれかが決まるか、取り下げてから出してください。`, { code: 'JOB_PROPOSALS_WAITING_LIMIT' })
const TODAY_FULL = () => refuse('conflict', `今日はもう${JOB_PROPOSALS_PER_DAY}回出しました。あした、もう一度出してください。`, { code: 'JOB_PROPOSALS_DAY_LIMIT' })
const PROPOSAL_NOT_FOUND = () => refuse('not-found', '定期の仕事の案が見つかりません。', { code: 'JOB_PROPOSAL_NOT_FOUND' })
const DECIDED = (state: string) => refuse('conflict', state === 'approved' ? 'この案はもう承認されました。' : 'この案はもう決まっています。', { code: 'JOB_PROPOSAL_DECIDED', state })

/** How many proposals a list answers. */
export const PROPOSALS_LISTED = 100

export interface JobProposalDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  /** The approval's own checks (services/jobs.ts): rights now, the pinned Skill still as pinned. */
  jobs: Pick<JobService, 'rightsFit' | 'readsAllFor' | 'skillStillPinned' | 'nameOf'>
  /** The git tree id of a company Skill now, or null. */
  skillTree: (companyId: string, name: string) => Promise<string | null>
  hasCompanyFolder: (companyId: string) => boolean
  /** A Skill of the Skill shelf as `who` reads it (services/skill-shelf.ts `jobSkill`). Absent → no shelf. */
  shelfSkill?: (who: Member, itemId: string) => { name: string; current: string | null; readable: boolean } | null
  /** Is `path` an existing folder of the company (its repository, a private folder's, or — without the shared folder — a department's place)? */
  placeExists: (companyId: string, path: string) => Promise<boolean>
  /** The sub-folder names of an existing folder ('' = the top), or null when it is not one. Not filtered: the caller does. */
  placeFolders: (companyId: string, path: string) => Promise<string[] | null>
  /** The company's zone (the submits' day). Absent → `DEFAULT_COMPANY_TIME_ZONE`. */
  timeZoneOf?: (companyId: string) => string
  /** The push signal to these members (their bell re-reads). Absent → nothing. */
  noticesChanged?: (companyId: string, userIds: string[]) => void
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hex32 = (ids: IdGenerator) => ids.newId().replace(/-/g, '').toLowerCase()

export function createJobProposals(deps: JobProposalDeps) {
  const { companyData, memberships, transactions, clock, ids } = deps

  /** May the member write at `path` now (rules, private folders)? */
  function writes(handle: CompanyData, member: Member, path: string): boolean {
    const scopes = handle.scopes.listWithRules()
    const perms: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => scopes }
    return resolveAccess(member.companyId, member.userId, path, perms).write
  }

  /**
   * Every place exists and is the member's to read; the deliverable's place also theirs to write. One answer for every
   * failure (`PLACE_REFUSED`): an unreadable private folder's name is never confirmed.
   */
  async function placesUsable(member: Member, places: string[], deliverable: string | null): Promise<boolean> {
    const handle = companyData.forCompany(member.companyId)
    const reader = recordReader(member, handle.scopes.listWithRules())
    for (const p of places) {
      if (!reader.file(p)) return false
      if (p === deliverable && !writes(handle, member, p)) return false
    }
    for (const p of places) {
      let exists = false
      try { exists = await deps.placeExists(member.companyId, p) } catch { exists = false }
      if (!exists) return false
    }
    // Read again after the awaits (Codex 4th pass): a private folder made, or its readers changed, meanwhile counts.
    const now = currentReader(member)
    return now !== null && places.every(p => now.reader.file(p) && (p !== deliverable || writes(handle, now.member, p)))
  }

  /** The member as they are now (role) and their reader over the scopes now; null once they are not a member. */
  function currentReader(member: Member): { member: Member; reader: ReturnType<typeof recordReader> } | null {
    const role = memberships.roleOf(member.companyId, member.userId)
    if (role === null) return null
    const now = { ...member, role }
    return { member: now, reader: recordReader(now, companyData.forCompany(member.companyId).scopes.listWithRules()) }
  }

  /** The Skill pinned for the member (they are the responsible person): the shared folder's tree, or the shelf's version. */
  async function pinSkill(member: Member, ref: string): Promise<Outcome<{ procedure: JobProcedure; name: string }>> {
    if (deps.hasCompanyFolder(member.companyId)) {
      // A company Skill's folder name (an ASCII skill name: the parser checks it again).
      const tree = await deps.skillTree(member.companyId, ref)
      if (tree === null) return SKILL_MISSING()
      return ok({ procedure: { source: 'company_skill', skill: ref, fingerprint: tree }, name: ref })
    }
    const found = deps.shelfSkill?.(member, ref) ?? null
    if (!found || !found.readable || found.current === null) return SKILL_MISSING()
    return ok({ procedure: { source: 'shelf_skill', item: ref, skill: found.name, fingerprint: found.current }, name: found.name })
  }

  /**
   * May `viewer` be told the submitted version's fingerprint (the job view's own rule, `fingerprintShown`)? An owner / admin
   * always; anyone else only while they read every place that version names (a sha256 of a known shape lets them test guesses).
   */
  function fingerprintShown(viewer: Member, p: JobProposalRow): boolean {
    if (hasFullAccess(viewer.role)) return true
    const v = companyData.forCompany(viewer.companyId).jobs.version(p.jobId, p.submittedVersion)
    const definition = v ? storedJobDefinition(v) : null
    return definition !== null && deps.jobs.readsAllFor(viewer.companyId, viewer.userId, definition)
  }

  function proposalView(p: JobProposalRow, viewer: Member): JobProposalView {
    return {
      id: p.id, jobId: p.jobId, proposerId: p.proposerId, candidateId: p.candidateId, submittedVersion: p.submittedVersion,
      submittedFingerprint: fingerprintShown(viewer, p) ? p.submittedFingerprint : null, state: p.state, returnReason: p.returnReason as JobProposalReturnReason | null,
      decidedBy: p.decidedBy, decidedAt: p.decidedAt, createdAt: p.createdAt,
    }
  }

  function candidateView(row: JobCandidateRow, proposal: JobProposalRow | null, viewer: Member): JobCandidateView {
    return {
      id: row.id, definition: storedJobDefinition({ schema: JOB_PROPOSAL_SCHEMA, definition: row.definition }) as JobDefinition,
      fingerprint: row.fingerprint, createdAt: row.createdAt, expiresAt: row.expiresAt, proposal: proposal ? proposalView(proposal, viewer) : null,
    }
  }

  /** The owners / admins of the company now (a proposal's notice goes to each). */
  const adminsOf = (companyId: string) => memberships.listByCompany(companyId).filter(m => hasFullAccess(m.role)).map(m => m.user_id)

  /** Where today began in company time (UTC ISO): the submits' day. */
  function dayStart(companyId: string): string {
    const zone = deps.timeZoneOf?.(companyId) ?? DEFAULT_COMPANY_TIME_ZONE
    return companyTimeToUtc(`${companyNow(clock.nowMs(), zone).slice(0, 10)}T00:00`, zone)
  }

  return {
    /**
     * `GET /api/records-ai/job-proposals-ai/places?under=`: the existing folders directly under `under` ('' = the top) that the
     * member reads, and whether they may write there — what a candidate may name. `under` itself must be one (else the one
     * 404). Refused to a run-bound token.
     */
    async places(member: Member, run: unknown, under: unknown): Promise<Outcome<JobCandidatePlaces>> {
      if (run !== null) return NOT_IN_RUN()
      const path = under === undefined || under === '' ? '' : under
      if (typeof path !== 'string' || (path !== '' && jobPathProblem(path) !== null)) return BAD_BODY('?under=<a company path>')
      const handle = companyData.forCompany(member.companyId)
      const reader = recordReader(member, handle.scopes.listWithRules())
      if (path !== '' && !(reader.file(path) && await deps.placeExists(member.companyId, path).catch(() => false))) return PLACE_NOT_FOUND()
      const names = await deps.placeFolders(member.companyId, path).catch(() => null)
      if (names === null) return PLACE_NOT_FOUND()
      // The membership and the scopes read again after the awaits (Codex 4th pass): a private folder made, or its readers
      // changed, while the repository was listed must never be named to someone no longer among its readers.
      const now = currentReader(member)
      if (now === null || (path !== '' && !now.reader.file(path))) return PLACE_NOT_FOUND()
      const folders = names
        .map(name => (path ? `${path}/${name}` : name))
        // Only what the member reads (a private folder they do not read is never named) and what a grant may name.
        .filter(p => jobPathProblem(p) === null && !p.split('/').some(s => s.startsWith('.')) && now.reader.file(p))
        .map(p => ({ path: p, write: writes(handle, now.member, p) }))
      return ok({ under: path, folders })
    },

    /**
     * `POST /api/records-ai/job-proposals-ai/candidates` (the member's AI): a candidate for the member alone. `run`: the execution run the
     * token is bound to — any run refuses, before anything is read.
     */
    async createCandidate(member: Member, run: unknown, body: unknown): Promise<Outcome<JobCandidateView>> {
      if (run !== null) return NOT_IN_RUN()
      const parsed = parseJobCandidateInput(body)
      if (!parsed.ok) return BAD_INPUT(parsed.problems)
      const input = parsed.input
      const handle = companyData.forCompany(member.companyId)
      handle.jobs.dropExpiredCandidates(clock.now())
      if (handle.jobs.liveCandidates(member.userId, clock.now()) >= JOB_CANDIDATES_PER_MEMBER) return CANDIDATES_FULL()
      // The responsible person is the signed-in member, fixed before any Skill is read (the Skill is read as theirs).
      const actingUser = member.userId
      const skill = await pinSkill(member, input.skill)
      if (!skill.ok) return skill
      if (!(await placesUsable(member, jobCandidatePlaces(input), input.deliverable))) return PLACE_REFUSED()
      const id = newJobCandidateId(hex32(ids))
      const def = parseJobDefinition(proposalDefinition(input, { actingUser, procedure: skill.value.procedure, skillName: skill.value.name, candidateId: id }))
      if (!def.ok) return BAD_DEFINITION(def.problems)
      const canonical = jobDefinitionCanonical(def.definition)
      const at = clock.now()
      const row: JobCandidateRow = {
        id, createdBy: member.userId, definition: canonical, fingerprint: hashCanonical(canonical), createdAt: at,
        expiresAt: new Date(clock.nowMs() + JOB_CANDIDATE_TTL_MS).toISOString(),
      }
      const saved = transactions.run((): Outcome<void> => {
        // The approval's own rights check (also the shelf Skill's place) inside the write, on the membership and scopes now —
        // after every await above — as it will run at the submit and the approval.
        if (!deps.jobs.rightsFit(member.companyId, actingUser, def.definition)) return PLACE_REFUSED()
        if (handle.jobs.liveCandidates(member.userId, at) >= JOB_CANDIDATES_PER_MEMBER) return CANDIDATES_FULL()
        handle.jobs.insertCandidate(row)
        return ok(undefined)
      })
      if (!saved.ok) return saved
      return ok(candidateView(row, null, member))
    },

    /** `GET /me/job-candidates/:candidateId`: the caller's own candidate (anyone else's, expired, another company's: the one 404). */
    candidate(member: Member, candidateId: string): Outcome<JobCandidateView> {
      if (!isJobCandidateId(candidateId)) return CANDIDATE_NOT_FOUND()
      const handle = companyData.forCompany(member.companyId)
      const row = handle.jobs.candidate(candidateId, member.userId, clock.now())
      if (!row) return CANDIDATE_NOT_FOUND()
      // What it names must still be theirs to read (jobs.md "Names never leak"): a place — or a shelf Skill's place — they no
      // longer read withholds the content and its fingerprint, answered as a candidate that is not there (naming nothing).
      const definition = storedJobDefinition({ schema: JOB_PROPOSAL_SCHEMA, definition: row.definition })
      if (definition === null || !deps.jobs.readsAllFor(member.companyId, member.userId, definition)) return CANDIDATE_NOT_FOUND()
      return ok(candidateView(row, handle.jobs.proposalOfCandidate(member.userId, candidateId), member))
    },

    /**
     * `POST /me/job-candidates/:candidateId/submit { fingerprint }` (the member's session): the candidate as the server built
     * it becomes a draft job, its proposal and the owners' / admins' notices, in one transaction. A repeat answers the first
     * result (`created: false`) and adds nothing — also after the candidate's content is gone.
     */
    async submit(member: Member, candidateId: string, body: unknown): Promise<Outcome<{ proposal: JobProposalView; created: boolean }>> {
      if (!isJobCandidateId(candidateId)) return CANDIDATE_NOT_FOUND()
      if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.fingerprint !== 'string') return BAD_BODY('{ fingerprint }')
      const fingerprint = body.fingerprint
      const handle = companyData.forCompany(member.companyId)
      // The first result — compared with what was sent only where the fingerprint is theirs to see: else the same refusal
      // whatever was sent (no guess is confirmed).
      const first = (p: JobProposalRow): Outcome<{ proposal: JobProposalView; created: boolean }> => {
        if (!fingerprintShown(member, p)) return PLACE_REFUSED()
        return p.submittedFingerprint === fingerprint ? ok({ proposal: proposalView(p, member), created: false }) : FINGERPRINT_CHANGED()
      }
      const before = handle.jobs.proposalOfCandidate(member.userId, candidateId)
      if (before) return first(before)
      const row = handle.jobs.candidate(candidateId, member.userId, clock.now())
      if (!row) return CANDIDATE_NOT_FOUND()
      // As stored: never resolved again (the card showed this).
      const definition = storedJobDefinition({ schema: JOB_PROPOSAL_SCHEMA, definition: row.definition })
      if (definition === null || definition.actingUser !== member.userId) return CANDIDATE_NOT_FOUND()
      // Its fingerprint is compared only where it is theirs to see (they read every place it names, a shelf Skill's place too —
      // the candidate's own view withholds it otherwise): else the same refusal whatever was sent (Codex, 3rd pass).
      if (!deps.jobs.readsAllFor(member.companyId, member.userId, definition)) return PLACE_REFUSED()
      if (row.fingerprint !== fingerprint) return FINGERPRINT_CHANGED()
      const places = [...new Set([...definition.grant.reads.paths, ...(definition.grant.writes.area === 'deliverable' ? [definition.grant.writes.place] : [])])]
      if (!(await placesUsable(member, places, definition.grant.writes.area === 'deliverable' ? definition.grant.writes.place : null))) return PLACE_REFUSED()
      const skill = await deps.jobs.skillStillPinned(member.companyId, definition)
      if (!skill.ok) return skill
      // Every owner / admin but the proposer (an owner / admin's own proposal tells nobody about itself).
      const admins = adminsOf(member.companyId).filter(userId => userId !== member.userId)
      const result = transactions.run((): Outcome<{ proposal: JobProposalView; created: boolean }> => {
        // Everything that can change meanwhile, again, inside the write.
        const again = handle.jobs.proposalOfCandidate(member.userId, candidateId)
        if (again) return first(again)
        if (!deps.jobs.rightsFit(member.companyId, member.userId, definition)) return GRANT_EXCEEDS()
        if (handle.jobs.countProposals(member.userId, { state: 'submitted' }) >= JOB_PROPOSALS_WAITING_MAX) return WAITING_FULL()
        if (handle.jobs.countProposals(member.userId, { since: dayStart(member.companyId) }) >= JOB_PROPOSALS_PER_DAY) return TODAY_FULL()
        const at = clock.now()
        const jobId = newJobId(hex32(ids))
        handle.jobs.create({
          id: jobId, name: definition.name, state: 'draft', actingUserId: member.userId, latestVersion: 1, approvedVersion: null,
          approvedFingerprint: null, acceptedVersion: null, acceptedConsent: null, acceptedPlace: null, pausedReason: null, pausedBy: null, pausedAt: null,
          createdBy: member.userId, createdAt: at, updatedAt: at,
        }, versionRow(jobId, 1, definition, row.definition, member.userId, at))
        const proposal: JobProposalRow = {
          id: newJobProposalId(hex32(ids)), jobId, proposerId: member.userId, candidateId, submittedVersion: 1, submittedFingerprint: row.fingerprint,
          state: 'submitted', returnReason: null, decidedBy: null, decidedAt: null, createdAt: at, updatedAt: at,
        }
        handle.jobs.insertProposal(proposal)
        // One notice per proposal and owner / admin (its own id each), the key the proposal's: never a second one.
        handle.notifications.insert(admins.map(userId => ({
          id: ids.newId(), userId, kind: 'job_proposal', recordId: '', recordVersion: 0, action: '', actorId: member.userId, actorKind: 'human',
          dedupeKey: `job_proposal:${proposal.id}`, createdAt: at, readAt: null,
        })))
        return ok({ proposal: proposalView(proposal, member), created: true })
      })
      if (result.ok && result.value.created) { try { deps.noticesChanged?.(member.companyId, admins) } catch { /* their own check catches up */ } }
      return result
    },

    /**
     * The member left the company (`companies.removeMember`, in its transaction, before the jobs' own pause): every proposal of
     * theirs still waiting is withdrawn (by `actorId`) and its job retired — nobody could approve or accept it any more.
     */
    memberLeft(companyId: string, userId: string, actorId: string): void {
      const handle = companyData.forCompany(companyId)
      const at = clock.now()
      for (const p of handle.jobs.proposals({ proposerId: userId, state: 'submitted' }, JOB_PROPOSALS_WAITING_MAX * 10)) {
        if (handle.jobs.decideProposal(p.id, 'withdrawn', { reason: null, by: actorId, at })) handle.jobs.setState(p.jobId, 'retired', null, actorId, at)
      }
    },

    /** `GET /me/job-proposals`: the caller's proposals, newest first. */
    mine(member: Member): Outcome<{ proposals: JobProposalView[] }> {
      return ok({ proposals: companyData.forCompany(member.companyId).jobs.proposals({ proposerId: member.userId }, PROPOSALS_LISTED).map(p => proposalView(p, member)) })
    },

    /** `GET /job-proposals?state=` (owner / admin): the company's proposals, newest first. */
    list(member: Member, state: unknown): Outcome<{ proposals: JobProposalView[] }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      if (state !== undefined && !(JOB_PROPOSAL_STATES as readonly unknown[]).includes(state)) return BAD_BODY('?state=submitted|approved|withdrawn|returned')
      const filter = state === undefined ? {} : { state: state as JobProposalRow['state'] }
      return ok({ proposals: companyData.forCompany(member.companyId).jobs.proposals(filter, PROPOSALS_LISTED).map(p => proposalView(p, member)) })
    },

    /** `POST /me/job-proposals/:proposalId/withdraw`: the proposer, only while it waits (anyone else: the one 404). */
    withdraw(member: Member, proposalId: string): Outcome<{ proposal: JobProposalView }> {
      const handle = companyData.forCompany(member.companyId)
      const p = isJobProposalId(proposalId) ? handle.jobs.proposal(proposalId) : null
      if (!p || p.proposerId !== member.userId) return PROPOSAL_NOT_FOUND()
      return decide(handle, member, p, 'withdrawn', null)
    },

    /** `POST /job-proposals/:proposalId/return { reason }` (owner / admin): a fixed reason code, only while it waits. */
    returnProposal(member: Member, proposalId: string, body: unknown): Outcome<{ proposal: JobProposalView }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      if (!isObject(body) || Object.keys(body).length !== 1 || !isJobProposalReturnReason(body.reason)) return BAD_BODY('{ reason } (a fixed reason code)')
      const handle = companyData.forCompany(member.companyId)
      const p = isJobProposalId(proposalId) ? handle.jobs.proposal(proposalId) : null
      if (!p) return PROPOSAL_NOT_FOUND()
      return decide(handle, member, p, 'returned', body.reason)
    },

    /**
     * The bell's words of `job_proposal_returned` for the member now: only to its proposer, while it is returned — the job's
     * name as they may read it (`HIDDEN_JOB_NAME` rule) and the fixed reason's words, never text.
     */
    proposalReturned(member: Member, proposalId: string): { name: string; reason: string } | null {
      if (!isJobProposalId(proposalId)) return null
      const p = companyData.forCompany(member.companyId).jobs.proposal(proposalId)
      if (!p || p.state !== 'returned' || p.proposerId !== member.userId) return null
      return { name: deps.jobs.nameOf(member, p.jobId) ?? HIDDEN_JOB_NAME, reason: jobProposalReturnReasonText(p.returnReason ?? 'OTHER') }
    },

    /** The bell's words of `job_proposal` for the member now: the job's name while it still waits and they are an owner / admin. */
    proposalNotice(member: Member, proposalId: string): { name: string } | null {
      if (!hasFullAccess(member.role) || !isJobProposalId(proposalId)) return null
      const handle = companyData.forCompany(member.companyId)
      const p = handle.jobs.proposal(proposalId)
      if (!p || p.state !== 'submitted') return null
      const job = handle.jobs.find(p.jobId)
      return job ? { name: job.name } : null
    },
  }

  /** From `submitted` to an end (compare-and-set) and the job retired, in one transaction; the first decision wins. */
  function decide(handle: CompanyData, member: Member, p: JobProposalRow, to: 'withdrawn' | 'returned', reason: string | null): Outcome<{ proposal: JobProposalView }> {
    const result = transactions.run((): Outcome<{ proposal: JobProposalView }> => {
      const at = clock.now()
      if (!handle.jobs.decideProposal(p.id, to, { reason, by: member.userId, at })) return DECIDED(handle.jobs.proposal(p.id)?.state ?? p.state)
      // Never edited, approved, accepted or run again (also by a build that does not know proposals: retired).
      handle.jobs.setState(p.jobId, 'retired', null, member.userId, at)
      // A return is told to its proposer (owner decision 2026-11-22): one notice per proposal, its words built when read.
      if (to === 'returned') {
        handle.notifications.insert([{
          id: ids.newId(), userId: p.proposerId, kind: 'job_proposal_returned', recordId: '', recordVersion: 0, action: '', actorId: member.userId, actorKind: 'human',
          dedupeKey: `job_proposal_returned:${p.id}`, createdAt: at, readAt: null,
        }])
      }
      return ok({ proposal: proposalView(handle.jobs.proposal(p.id) as JobProposalRow, member) })
    })
    if (result.ok && to === 'returned') { try { deps.noticesChanged?.(member.companyId, [p.proposerId]) } catch { /* their own check catches up */ } }
    return result
  }
}

export type JobProposalService = ReturnType<typeof createJobProposals>
