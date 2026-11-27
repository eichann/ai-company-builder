/**
 * 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval"; redesign step ⑥, design memo §3 I3–I5,
 * §5, §6-3, §10, §11; owner decisions 2026-11-25). A company Skill may carry `browser.yaml` (shared/core/browser-skill.ts);
 * the AI may write only within an **approved** version of it, and **the server decides**:
 *
 * - **The server reads the Skill itself** (`BrowserSkillSource`: the company repository's shared branch, or the Skill
 *   shelf for a company without the shared folder) — never content an app sent. The approval key is `sha256:` of
 *   `browser.yaml`; the whole folder's fingerprint (`git:<tree>` / `shelf:<version>`) tells a change of the other files.
 * - **Approving**: an owner / admin approves exactly the declaration they saw (`declarationHash`, compare-and-set against
 *   what the server reads now), `per_run` (each run's card) or `pre_approved` (no card). Only a skill's latest approval
 *   counts, and only for its hash. **Revoking** any time (owner / admin).
 * - **A changed declaration needs approving again** — unless an owner / admin made the change (the pusher as git-http
 *   authenticated it and the push checker accepted it, or the shelf's publisher): that counts as approving it (`edited`,
 *   who is kept). A change by anyone else (「Skill を直せる人」) waits, and owners / admins are told. An approval taken back
 *   stays taken back whoever edits next.
 * - **Only the other files changed** (the steps' text, site notes): nothing is blocked; the next run shows the per-run
 *   card once even when pre-approved (`textChanged` / `needsRunCard`, until step ⑤ calls `runCardShown`), and owners /
 *   admins are told 「手順が直りました」 once per version.
 * - **The frames** (`approvedFrames`, for step ⑤'s permit): built by the server from the approved declaration it read,
 *   re-checked on every call (a few git reads): the declaration valid, its domain registered by the company now, the
 *   approval in force for this very hash. Anything else is a refusal with a fixed code.
 * - **Which Skill** ("Department Skills"): a Skill is its path — the company's `.claude/skills/<name>` or a department's
 *   `<department>/.claude/skills/<name>` (two departments may each have one name) — and every approval row, run and
 *   notice keys on it. A bare name means the company's (rows written before department Skills, an older admin page).
 *   The AI may name a Skill by its name: `resolve` takes it only when exactly one Skill of that name is there for the
 *   member, else refuses (`BROWSER_SKILL_AMBIGUOUS`) — never a guess. A department's Skill is used only by a member who
 *   reads that place now (`readsPath`, the core's read rules), asked at every permit.
 */
import {
  BROWSER_SKILL_PATH_MAX, BROWSER_SKILL_PROBLEM_WORDS, browserSkillDomainProblem, browserSkillFrames, browserSkillPathOf, browserSkillPlaceWords, browserSkillWriteLine,
  parseBrowserSkillDeclaration, parseBrowserSkillPath,
  type BrowserSkillDeclaration, type BrowserSkillFrames, type BrowserSkillPlace, type BrowserSkillProblem,
} from '../../shared/core/browser-skill'
import { CONTENT_HASH_RE } from '../../shared/core/fixed-content'
import { browserSkillStepsSeal, browserSkillStepsText, type BrowserSkillStepsSeal } from '../../shared/core/browser-skill-steps'
import { isValidFolderName, isValidSkillName } from '../../shared/core/names'
import {
  BROWSER_SKILL_APPROVAL_MODES, type BrowserSkillApprovalMode, type BrowserSkillStatus, type BrowserSkillsView, type BrowserSkillView,
} from '../../shared/types/browser-skills'
import type { AccountDirectory } from '../ports/accounts'
import type { BrowserSkillApprovalRepository, BrowserSkillApprovalRow, BrowserSkillContent, BrowserSkillLanded, BrowserSkillSource } from '../ports/browser-skills'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import { logError } from '../lib/error-log'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserSkillDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  memberships: Pick<MembershipRepository, 'listByCompany'>
  accounts: Pick<AccountDirectory, 'byIds'>
  /** The company's own copy of its Skills (adapters/browser-skill-source.ts). */
  source: BrowserSkillSource
  /** The domains the company registered for 「ブラウザ操作」 now (its setting's sites). */
  registeredHosts(companyId: string): string[]
  /** sha256 (hex) of a text's UTF-8. */
  sha256(text: string): string
  /** Does the member read this company path now (shared/core/permissions.ts `resolveAccess`)? A department Skill's use. */
  readsPath(member: Member, path: string): boolean
  /** Tell these members' apps to read their notices again (the push channel). */
  noticesChanged?(companyId: string, userIds: string[]): void
}

/**
 * The notices ride the existing admin-only browser kind (shared/types/notifications.ts `browser_shape_changed`: recordless,
 * text built when read, shown only to owners / admins): a new kind would grow every app's bundle and settings list. The
 * dedupe key's prefix tells them apart (composition.ts hands `browser_skill:` keys here).
 */
export const BROWSER_SKILL_NOTICE_KIND = 'browser_shape_changed'
export const BROWSER_SKILL_NOTICE_PREFIX = 'browser_skill:'
const NOTICE_RE = /^browser_skill:(waiting|text):(?:([^:/]+)\/)?([a-z0-9][a-z0-9_-]*):[0-9a-f]{16}$/

export const BROWSER_SKILL_WORDS = Object.freeze({
  manageForbidden: 'Skill の承認は、オーナーと管理者だけができます。',
  notFound: 'その Skill は見つかりません（ブラウザ操作の宣言がないか、名前が違います）。',
  badBody: '頼み方の形が正しくありません。',
  notApproved: 'この Skill のいまの宣言は、まだ承認されていません。',
  changed: 'この Skill の宣言が、見ている間に変わりました。読み込み直してから、もう一度確かめてください。',
  notRevocable: 'この Skill には、取り消せる承認がありません。',
  ambiguous: 'その名前の Skill が、全社と部署（または複数の部署）にあります。どれを使うか決められないので、動かしていません。Skill のパス（全社のものは .claude/skills/<名前>、部署のものは <部署のフォルダ>/.claude/skills/<名前>）で頼み直してください。',
})
/** How long a Skill a run names may be (a name or a path). */
export const BROWSER_SKILL_REF_MAX = BROWSER_SKILL_PATH_MAX
const W = BROWSER_SKILL_WORDS

/**
 * The Skill a request names: a Skill path, or a bare name meaning the company's `.claude/skills/<name>` (what approval rows,
 * runs and an older admin page said before department Skills). Null: neither.
 */
export function browserSkillPlaceOf(skill: unknown): BrowserSkillPlace | null {
  if (typeof skill !== 'string' || skill.length > BROWSER_SKILL_REF_MAX) return null
  return isValidSkillName(skill) ? parseBrowserSkillPath(browserSkillPathOf(null, skill)) : parseBrowserSkillPath(skill.normalize('NFC'))
}
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k))

/** What the server makes of one Skill as it reads it now. */
interface Judged {
  place: BrowserSkillPlace
  content: BrowserSkillContent
  hash: string
  declaration: BrowserSkillDeclaration | null
  problem: BrowserSkillProblem | null
}

/** What step ⑤ gets for a Skill whose declaration is approved. */
export interface BrowserSkillApproved {
  /** The Skill's path as the server's copy spells it (what the run keeps and hands back). */
  skill: string
  declarationHash: string
  /** The whole folder's fingerprint read now (hand it back to `runCardShown`). */
  files: string
  frames: BrowserSkillFrames
  mode: BrowserSkillApprovalMode
  /** The approval row this answer rests on (hand it to `stillApproved` inside the caller's transaction). */
  approval: number
  /** The Skill's other files changed since the approver or the last run's card saw them. */
  textChanged: boolean
  /** The run must show the per-run card: `per_run`, or the text changed. */
  needsRunCard: boolean
}

export function createBrowserSkillService(deps: BrowserSkillDeps) {
  const repo = (companyId: string): BrowserSkillApprovalRepository => deps.companyData.forCompany(companyId).browserSkills
  const forbidden = (): Refusal => refuse('forbidden', W.manageForbidden, { code: 'BROWSER_SKILL_FORBIDDEN' })
  const notFound = (): Refusal => refuse('not-found', W.notFound, { code: 'BROWSER_SKILL_NOT_FOUND' })
  const bad = (): Refusal => refuse('bad-request', W.badBody, { code: 'BROWSER_SKILL_BAD_REQUEST' })

  /** The Skill as the server read it, judged — null when what the source handed is no Skill path (never trusted). */
  function judge(companyId: string, content: BrowserSkillContent): Judged | null {
    const place = parseBrowserSkillPath(content.path)
    if (!place) return null
    if (content.declaration === 'too-large') {
      // Never read whole, so nothing to hash: the folder's fingerprint keeps the key unique and never approvable.
      return { place, content, hash: `sha256:${deps.sha256(`too-large\0${content.files}`)}`, declaration: null, problem: 'too-large' }
    }
    const hash = `sha256:${deps.sha256(content.declaration)}`
    const parsed = parseBrowserSkillDeclaration(content.declaration)
    if (!parsed.ok) return { place, content, hash, declaration: null, problem: parsed.problem }
    return { place, content, hash, declaration: parsed.declaration, problem: browserSkillDomainProblem(parsed.declaration, deps.registeredHosts(companyId)) }
  }
  /** Read a Skill at its place and judge it (null: not there). */
  async function readJudged(companyId: string, place: BrowserSkillPlace): Promise<Judged | null> {
    const content = await deps.source.read(companyId, place.path)
    return content ? judge(companyId, content) : null
  }
  /** May the member use this Skill? The company's: as before; a department's: only while they read its place. */
  const mayUse = (member: Member, place: BrowserSkillPlace) => place.department === null || deps.readsPath(member, place.path)

  /** The approval in force for this hash: the skill's latest row, this hash, not revoked. */
  const inForce = (latest: BrowserSkillApprovalRow | null, hash: string): BrowserSkillApprovalRow | null =>
    latest && latest.declarationHash === hash && latest.revokedAt === null ? latest : null

  function statusOf(j: Judged, latest: BrowserSkillApprovalRow | null): BrowserSkillStatus {
    if (j.problem) return 'invalid'
    if (!latest || latest.declarationHash !== j.hash) return 'waiting'
    if (latest.revokedAt !== null) return 'revoked'
    if (latest.filesSeen !== null && latest.filesSeen !== j.content.files) return 'text_changed'
    return latest.mode === 'pre_approved' ? 'pre_approved' : 'approved'
  }

  function viewOf(companyId: string, j: Judged): BrowserSkillView {
    const latest = repo(companyId).latest(j.place.path)
    const approval = latest && latest.declarationHash === j.hash ? latest : null
    const names = approval ? deps.accounts.byIds([approval.approvedBy]) : new Map()
    const d = j.declaration
    return {
      name: j.place.name,
      path: j.place.path,
      department: j.place.department,
      declarationHash: j.hash,
      files: j.content.files,
      status: statusOf(j, latest),
      problem: j.problem ? BROWSER_SKILL_PROBLEM_WORDS[j.problem] : null,
      domain: d?.domain ?? null,
      writes: d ? d.writes.map(browserSkillWriteLine) : [],
      neverRead: d ? [...d.neverRead] : [],
      afterRead: d ? [...d.afterRead] : [],
      accountMarker: d?.accountMarker?.meta ?? null,
      approval: approval && approval.revokedAt === null
        ? {
            mode: approval.mode, how: approval.how, approvedBy: approval.approvedBy,
            approvedByName: names.get(approval.approvedBy)?.name ?? null, approvedAt: approval.approvedAt,
          }
        : null,
    }
  }

  /** Tell the company's owners / admins (but `except`), once per key. */
  function tell(companyId: string, key: string, except: string | null): void {
    try {
      const admins = deps.memberships.listByCompany(companyId).filter(m => hasFullAccess(m.role) && m.user_id !== except).map(m => m.user_id)
      if (admins.length === 0) return
      const now = deps.clock.now()
      const written = deps.companyData.forCompany(companyId).notifications.insert(admins.map(userId => ({
        id: deps.ids.newId(), userId, kind: BROWSER_SKILL_NOTICE_KIND, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
        dedupeKey: key, createdAt: now, readAt: null,
      })))
      if (written.length > 0) deps.noticesChanged?.(companyId, admins)
    } catch (err) {
      logError('browser-skills', 'Telling owners and admins failed', err, { company: companyId })
    }
  }
  const short = (s: string) => deps.sha256(s).slice(0, 16)
  /** A notice key's version part: the company's Skill as before; a department's also by its path (two may share a name). */
  const keyPart = (place: BrowserSkillPlace, of: string) => short(place.department === null ? of : `${place.path}\0${of}`)
  /** A notice key's Skill: its name, after its department folder for a department's (`営業/order-copy`; the text says it). */
  const keyName = (place: BrowserSkillPlace) => (place.department === null ? place.name : `${place.department}/${place.name}`)

  /** 「手順が直りました」 once per folder version (the notice's dedupe key), when an approval in force has not seen this version. */
  function noticeTextChanged(companyId: string, j: Judged, except: string | null): void {
    const approval = inForce(repo(companyId).latest(j.place.path), j.hash)
    if (!approval || approval.filesSeen === null || approval.filesSeen === j.content.files) return
    tell(companyId, `${BROWSER_SKILL_NOTICE_PREFIX}text:${keyName(j.place)}:${keyPart(j.place, j.content.files)}`, except)
  }

  /**
   * A Skill someone landed (a push the checker accepted, read at the pushed commit; or the shelf's version they published).
   * `by`: who, with their role at that time. `current`: the Skill as the server reads it now — a landing that is no longer
   * what is there (a later push or publish, read in another order) changes nothing: the later one is judged on its own.
   */
  function landed(companyId: string, by: { userId: string; role: string }, content: BrowserSkillLanded, current: BrowserSkillContent | null): void {
    if (!current || current.files !== content.files || current.path !== content.path) return
    const j = judge(companyId, content)
    if (!j) return
    const r = repo(companyId)
    const path = j.place.path
    const latest = r.latest(path)
    if (latest && latest.declarationHash === j.hash) {
      // The declaration is the approved one (or the revoked one): only the other files may have moved.
      if (latest.revokedAt === null) noticeTextChanged(companyId, j, by.userId)
      return
    }
    // A declaration that cannot be read is nothing to approve: 「Skill の承認」 shows its problem.
    if (!j.declaration || j.problem === 'too-large') return
    // Only a change of the declaration itself counts as its approval: an owner / admin who changed only the text of a
    // Skill whose declaration someone else changed approves nothing by that (Codex review).
    if (!content.declarationChanged) return
    // An owner / admin's change approves only on top of what was approved: the declaration right before it was the
    // approved one (in force), or there was none and nothing was ever approved (a new Skill). Anything else — a skill
    // editor's pending declaration carried along by a pull --rebase, a revoked one — waits (independent review M1).
    const before = content.previousDeclaration
    const onApproved = before === null
      ? latest === null && newPathApprovable(r, j.hash, content.sameElsewhere)
      : before !== 'too-large' && latest !== null && latest.revokedAt === null && latest.declarationHash === `sha256:${deps.sha256(before)}`
    if (hasFullAccess(by.role) && onApproved) {
      r.insert({
        skillPath: path, declarationHash: j.hash, mode: latest?.mode ?? 'per_run', how: 'edited',
        // Not counted as seen: the first run of a declaration changed this way shows the card once, also when pre-approved
        // (the change may have been written by the admin's AI; independent review).
        approvedBy: by.userId, approvedAt: deps.clock.now(), filesSeen: null,
      })
      return
    }
    noticeWaiting(companyId, j, by.userId)
  }

  /**
   * A declaration new at its path (a new Skill — or one moved or copied from another path) counts as the owner / admin's
   * approval only when it is no declaration someone is still waiting on or took back: every other path that held exactly
   * it right before or after the change has it approved and in force (a move or copy of an approved Skill), every place
   * could be looked into, and no approval of it was ever revoked anywhere in the company. Else it waits (coordinator's
   * review of #879: moving or copying a pending or revoked declaration must not approve it).
   */
  function newPathApprovable(r: BrowserSkillApprovalRepository, hash: string, elsewhere: BrowserSkillLanded['sameElsewhere']): boolean {
    if (!elsewhere.complete || r.everRevoked(hash)) return false
    return elsewhere.paths.every(p => inForce(r.latest(p), hash) !== null)
  }

  /** 「宣言が直されました…承認してください」 once per declaration version (the notice's dedupe key). */
  function noticeWaiting(companyId: string, j: Judged, except: string | null): void {
    tell(companyId, `${BROWSER_SKILL_NOTICE_PREFIX}waiting:${keyName(j.place)}:${keyPart(j.place, j.hash)}`, except)
  }

  const later = (what: string, companyId: string, work: () => Promise<void>) => {
    setImmediate(() => {
      work().catch(err => logError('browser-skills', what, err, { company: companyId }))
    })
  }

  return {
    /** GET /browser-skill-approvals (owner/admin): every company and department Skill with `browser.yaml`, as read now. */
    async list(member: Member): Promise<Outcome<BrowserSkillsView>> {
      if (!hasFullAccess(member.role)) return forbidden()
      const items: BrowserSkillView[] = []
      const listed = await deps.source.list(member.companyId)
      for (const path of listed.paths) {
        const place = parseBrowserSkillPath(path)
        const j = place ? await readJudged(member.companyId, place) : null
        if (!j) continue
        noticeTextChanged(member.companyId, j, null)
        const view = viewOf(member.companyId, j)
        // A waiting declaration whose notice a landing could not send (read in another order, past the push's limit, a
        // server-made commit): told now, once per version by its key (independent review L4).
        if (view.status === 'waiting') noticeWaiting(member.companyId, j, null)
        items.push(view)
      }
      // The page says plainly when not every place could be looked into (a Skill may be missing from it).
      return ok({ items, complete: listed.complete })
    },

    /** POST /browser-skill-approvals { skill, declarationHash, files, mode } (owner/admin): approve exactly what was seen. */
    async approve(member: Member, body: unknown): Promise<Outcome<BrowserSkillView>> {
      if (!hasFullAccess(member.role)) return forbidden()
      if (!isMap(body) || !exactKeys(body, ['skill', 'declarationHash', 'files', 'mode'])) return bad()
      const { skill, declarationHash, files, mode } = body
      const place = browserSkillPlaceOf(skill)
      if (!place) return bad()
      if (typeof declarationHash !== 'string' || !CONTENT_HASH_RE.test(declarationHash)) return bad()
      if (typeof files !== 'string' || files.length > 200) return bad()
      if (!(BROWSER_SKILL_APPROVAL_MODES as readonly unknown[]).includes(mode)) return bad()
      const j = await readJudged(member.companyId, place)
      if (!j) return notFound()
      const content = j.content
      if (j.problem) return refuse('conflict', BROWSER_SKILL_PROBLEM_WORDS[j.problem], { code: j.problem === 'not-registered' ? 'BROWSER_SKILL_DOMAIN_NOT_REGISTERED' : 'BROWSER_SKILL_BAD_DECLARATION' })
      if (j.hash !== declarationHash || content.files !== files) return refuse('conflict', W.changed, { code: 'BROWSER_SKILL_CHANGED' })
      // Approving is approving the version as a whole, as the page showed it: its files count as seen.
      repo(member.companyId).insert({
        skillPath: j.place.path, declarationHash: j.hash, mode: mode as BrowserSkillApprovalMode, how: 'approved',
        approvedBy: member.userId, approvedAt: deps.clock.now(), filesSeen: content.files,
      })
      return ok(viewOf(member.companyId, j))
    },

    /** POST /browser-skill-approvals/revoke { skill } (owner/admin): take the latest approval back (`skill`: its path). */
    revoke(member: Member, body: unknown): Outcome<{ revoked: true }> {
      if (!hasFullAccess(member.role)) return forbidden()
      const place = isMap(body) && exactKeys(body, ['skill']) ? browserSkillPlaceOf(body.skill) : null
      if (!place) return bad()
      const r = repo(member.companyId)
      const latest = r.latest(place.path)
      if (!latest || latest.revokedAt !== null || !r.revoke(latest.seq, deps.clock.now(), member.userId)) {
        return refuse('conflict', W.notRevocable, { code: 'BROWSER_SKILL_NOT_APPROVED' })
      }
      return ok({ revoked: true })
    },

    /**
     * Which Skill a run's start means: a path as it is; a bare name only when exactly one Skill with `browser.yaml` of that
     * name is there for this member (the company's, or a department's they read) — more than one →
     * `BROWSER_SKILL_AMBIGUOUS`, never a guess; none → the not-found answer. Answers the Skill's path.
     */
    async resolve(member: Member, skill: string): Promise<Outcome<string>> {
      if (skill.length > BROWSER_SKILL_REF_MAX) return notFound()
      if (!isValidSkillName(skill)) {
        const place = parseBrowserSkillPath(skill.normalize('NFC'))
        return place ? ok(place.path) : notFound()
      }
      // Every Skill of that name, not the bounded list (a second one past its bound would be guessed away: Codex review).
      const found = await deps.source.withName(member.companyId, skill)
      const matches = found.paths
        .map(parseBrowserSkillPath)
        .filter((p): p is BrowserSkillPlace => p !== null && p.name === skill && mayUse(member, p))
      if (matches.length === 0) return notFound()
      // Two — or one, when some place could not be looked into (another may stand there) — is never a guess: give the path.
      if (matches.length > 1 || !found.complete) return refuse('conflict', W.ambiguous, { code: 'BROWSER_SKILL_AMBIGUOUS' })
      return ok(matches[0].path)
    },

    /**
     * Step ⑤'s question, asked at every permit: the frames the server builds from the approved declaration of this
     * Skill (its path; a bare name = the company's), read now from the company's own copy — or why not. A department's
     * Skill only for a member who reads its place now (else the same answer as a missing one). Never trusts anything the
     * app holds.
     */
    async approvedFrames(member: Member, skill: string): Promise<Outcome<BrowserSkillApproved>> {
      const place = browserSkillPlaceOf(skill)
      if (!place || !mayUse(member, place)) return notFound()
      const j = await readJudged(member.companyId, place)
      // Asked again of the path as the server's copy spells it: that is the place the approval and the read rules name.
      if (!j || !mayUse(member, j.place)) return notFound()
      const content = j.content
      if (j.problem || !j.declaration) {
        const problem = j.problem ?? 'not-object'
        return refuse('conflict', BROWSER_SKILL_PROBLEM_WORDS[problem], { code: problem === 'not-registered' ? 'BROWSER_SKILL_DOMAIN_NOT_REGISTERED' : 'BROWSER_SKILL_BAD_DECLARATION' })
      }
      const approval = inForce(repo(member.companyId).latest(j.place.path), j.hash)
      if (!approval) return refuse('conflict', W.notApproved, { code: 'BROWSER_SKILL_NOT_APPROVED' })
      // `filesSeen` null: approved by an owner / admin's own change, not yet run — the card once, nobody told.
      const textChanged = approval.filesSeen !== null && approval.filesSeen !== content.files
      if (textChanged) noticeTextChanged(member.companyId, j, null)
      return ok({
        skill: j.place.path, declarationHash: j.hash, files: content.files, frames: browserSkillFrames(j.declaration), mode: approval.mode, approval: approval.seq,
        textChanged, needsRunCard: approval.mode === 'per_run' || approval.filesSeen !== content.files,
      })
    },

    /**
     * Step ⑤'s second look inside its transaction (synchronous: no git read): the approval `approvedFrames` answered
     * (`approval`, its row) is still the skill's latest, in force, for exactly this declaration hash. `approvedFrames`
     * read before the transaction; this catches an approval revoked, superseded or given another mode in between (a
     * `pre_approved` replaced by `per_run` is a new row: Codex review of ⑤a), and a department's Skill whose place the
     * member no longer reads.
     */
    stillApproved(member: Member, skill: string, declarationHash: string, approval: number): boolean {
      const place = browserSkillPlaceOf(skill)
      if (!place || !mayUse(member, place)) return false
      return inForce(repo(member.companyId).latest(place.path), declarationHash)?.seq === approval
    },

    /**
     * The seal of a Skill's steps at exactly the folder version `approvedFrames` answered (`skill` its path, `files` its
     * fingerprint): what the frames run's start hands the app, which starts the operator only with steps of that very
     * text (agent-browser.md "The operator works from the approved steps"). Null when that version cannot be read.
     */
    async stepsSeal(member: Pick<Member, 'companyId'>, skill: string, files: string): Promise<BrowserSkillStepsSeal | null> {
      const read = await deps.source.stepFiles(member.companyId, { path: skill, files })
      return read === null ? null : browserSkillStepsSeal(browserSkillStepsText(read), deps.sha256)
    },

    /** Step ⑤: the per-run card was shown for this version (`files` as `approvedFrames` gave it); false when the approval moved. */
    runCardShown(member: Pick<Member, 'companyId'>, skill: string, declarationHash: string, files: string): boolean {
      const place = browserSkillPlaceOf(skill)
      if (!place) return false
      const r = repo(member.companyId)
      const approval = inForce(r.latest(place.path), declarationHash)
      if (!approval) return false
      r.setFilesSeen(approval.seq, files)
      return true
    },

    /**
     * After a push the checker accepted (git-http): `refUpdates` = the `<old> <new> <ref>` lines it checked, `role` = the
     * pusher's role as git-http authenticated them. Off the request, never throws.
     */
    afterPush(companyId: string, by: { userId: string; role: string }, refUpdates: string): void {
      later('Reading a push for browser Skills failed', companyId, async () => {
        for (const content of await deps.source.pushed(companyId, refUpdates)) {
          const current = await deps.source.read(companyId, content.path)
          // Synchronous from here: no other landing or approval runs between this read and the write.
          landed(companyId, by, content, current)
        }
      })
    },

    /** After the shelf published or put back a version (services/skill-shelf.ts): the publisher and their role. */
    shelfChanged(
      member: Member, item: { kind: string; departmentId: string | null; name: string },
      versions: { before: string | null; written: string; how: 'publish' | 'restore' | 'request' },
    ): void {
      if (item.kind !== 'skill') return
      // Only the publisher's own upload counts as their change. Putting an earlier version back or publishing a member's
      // request lands a declaration nobody reviewed on 「Skill の承認」: it waits (independent review M2).
      const by = versions.how === 'publish' ? member : { userId: member.userId, role: 'member' }
      // Judged at exactly the version this member wrote, and only while it is still the current one (as a push).
      later('Reading a shelf Skill for browser Skills failed', member.companyId, async () => {
        const content = await deps.source.shelfLanded(member.companyId, { departmentId: item.departmentId, name: item.name }, versions)
        if (!content) return
        const current = await deps.source.read(member.companyId, content.path)
        landed(member.companyId, by, content, current)
      })
    },

    /** The inbox's text of a `browser_skill:` notice, built when read (owner / admin only; else not shown). */
    noticeText(member: Member, dedupeKey: string | null): string | null {
      if (!hasFullAccess(member.role) || !dedupeKey) return null
      const m = NOTICE_RE.exec(dedupeKey)
      if (!m) return null
      const department = m[2] ?? null
      if (department !== null && !isValidFolderName(department)) return null
      // Which Skill: its place too (two departments may each have one of this name).
      const skill = `${browserSkillPlaceWords(department)}の Skill「${m[3]}」`
      return m[1] === 'waiting'
        ? `ブラウザ操作：${skill}の宣言（書き込み先など）が直されました。管理画面の「Skill の承認」で確かめて承認するまで、この Skill では書き込めません`
        : `ブラウザ操作：${skill}の手順が直りました。次に動かすときは、前もって承認していても、実行の前に確かめのカードが1回出ます`
    },
  }
}

export type BrowserSkillService = ReturnType<typeof createBrowserSkillService>
