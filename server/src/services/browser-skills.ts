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
 */
import {
  BROWSER_SKILL_PROBLEM_WORDS, browserSkillDomainProblem, browserSkillFrames, browserSkillWriteLine, parseBrowserSkillDeclaration,
  type BrowserSkillDeclaration, type BrowserSkillFrames, type BrowserSkillProblem,
} from '../../shared/core/browser-skill'
import { CONTENT_HASH_RE } from '../../shared/core/fixed-content'
import { isValidSkillName } from '../../shared/core/names'
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
const NOTICE_RE = /^browser_skill:(waiting|text):([a-z0-9][a-z0-9_-]*):[0-9a-f]{16}$/

export const BROWSER_SKILL_WORDS = Object.freeze({
  manageForbidden: 'Skill の承認は、オーナーと管理者だけができます。',
  notFound: 'その Skill は見つかりません（ブラウザ操作の宣言がないか、名前が違います）。',
  badBody: '頼み方の形が正しくありません。',
  notApproved: 'この Skill のいまの宣言は、まだ承認されていません。',
  changed: 'この Skill の宣言が、見ている間に変わりました。読み込み直してから、もう一度確かめてください。',
  notRevocable: 'この Skill には、取り消せる承認がありません。',
})
const W = BROWSER_SKILL_WORDS

const skillPathOf = (name: string) => `.claude/skills/${name}`
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k))

/** What the server makes of one Skill as it reads it now. */
interface Judged {
  content: BrowserSkillContent
  hash: string
  declaration: BrowserSkillDeclaration | null
  problem: BrowserSkillProblem | null
}

/** What step ⑤ gets for a Skill whose declaration is approved. */
export interface BrowserSkillApproved {
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

  function judge(companyId: string, content: BrowserSkillContent): Judged {
    if (content.declaration === 'too-large') {
      // Never read whole, so nothing to hash: the folder's fingerprint keeps the key unique and never approvable.
      return { content, hash: `sha256:${deps.sha256(`too-large\0${content.files}`)}`, declaration: null, problem: 'too-large' }
    }
    const hash = `sha256:${deps.sha256(content.declaration)}`
    const parsed = parseBrowserSkillDeclaration(content.declaration)
    if (!parsed.ok) return { content, hash, declaration: null, problem: parsed.problem }
    return { content, hash, declaration: parsed.declaration, problem: browserSkillDomainProblem(parsed.declaration, deps.registeredHosts(companyId)) }
  }

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
    const latest = repo(companyId).latest(skillPathOf(j.content.name))
    const approval = latest && latest.declarationHash === j.hash ? latest : null
    const names = approval ? deps.accounts.byIds([approval.approvedBy]) : new Map()
    const d = j.declaration
    return {
      name: j.content.name,
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

  /** 「手順が直りました」 once per folder version (the notice's dedupe key), when an approval in force has not seen this version. */
  function noticeTextChanged(companyId: string, j: Judged, except: string | null): void {
    const approval = inForce(repo(companyId).latest(skillPathOf(j.content.name)), j.hash)
    if (!approval || approval.filesSeen === null || approval.filesSeen === j.content.files) return
    tell(companyId, `${BROWSER_SKILL_NOTICE_PREFIX}text:${j.content.name}:${short(j.content.files)}`, except)
  }

  /**
   * A Skill someone landed (a push the checker accepted, read at the pushed commit; or the shelf's version they published).
   * `by`: who, with their role at that time. `current`: the Skill as the server reads it now — a landing that is no longer
   * what is there (a later push or publish, read in another order) changes nothing: the later one is judged on its own.
   */
  function landed(companyId: string, by: { userId: string; role: string }, content: BrowserSkillLanded, current: BrowserSkillContent | null): void {
    if (!current || current.files !== content.files) return
    const j = judge(companyId, content)
    const r = repo(companyId)
    const path = skillPathOf(content.name)
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
      ? latest === null
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

  /** 「宣言が直されました…承認してください」 once per declaration version (the notice's dedupe key). */
  function noticeWaiting(companyId: string, j: Judged, except: string | null): void {
    tell(companyId, `${BROWSER_SKILL_NOTICE_PREFIX}waiting:${j.content.name}:${short(j.hash)}`, except)
  }

  const later = (what: string, companyId: string, work: () => Promise<void>) => {
    setImmediate(() => {
      work().catch(err => logError('browser-skills', what, err, { company: companyId }))
    })
  }

  return {
    /** GET /browser-skill-approvals (owner/admin): every company Skill with `browser.yaml`, as the server reads it now. */
    async list(member: Member): Promise<Outcome<BrowserSkillsView>> {
      if (!hasFullAccess(member.role)) return forbidden()
      const items: BrowserSkillView[] = []
      for (const name of await deps.source.list(member.companyId)) {
        const content = await deps.source.read(member.companyId, name)
        if (!content) continue
        const j = judge(member.companyId, content)
        noticeTextChanged(member.companyId, j, null)
        const view = viewOf(member.companyId, j)
        // A waiting declaration whose notice a landing could not send (read in another order, past the push's limit, a
        // server-made commit): told now, once per version by its key (independent review L4).
        if (view.status === 'waiting') noticeWaiting(member.companyId, j, null)
        items.push(view)
      }
      return ok({ items })
    },

    /** POST /browser-skill-approvals { skill, declarationHash, files, mode } (owner/admin): approve exactly what was seen. */
    async approve(member: Member, body: unknown): Promise<Outcome<BrowserSkillView>> {
      if (!hasFullAccess(member.role)) return forbidden()
      if (!isMap(body) || !exactKeys(body, ['skill', 'declarationHash', 'files', 'mode'])) return bad()
      const { skill, declarationHash, files, mode } = body
      if (typeof skill !== 'string' || !isValidSkillName(skill)) return bad()
      if (typeof declarationHash !== 'string' || !CONTENT_HASH_RE.test(declarationHash)) return bad()
      if (typeof files !== 'string' || files.length > 200) return bad()
      if (!(BROWSER_SKILL_APPROVAL_MODES as readonly unknown[]).includes(mode)) return bad()
      const content = await deps.source.read(member.companyId, skill)
      if (!content) return notFound()
      const j = judge(member.companyId, content)
      if (j.problem) return refuse('conflict', BROWSER_SKILL_PROBLEM_WORDS[j.problem], { code: j.problem === 'not-registered' ? 'BROWSER_SKILL_DOMAIN_NOT_REGISTERED' : 'BROWSER_SKILL_BAD_DECLARATION' })
      if (j.hash !== declarationHash || content.files !== files) return refuse('conflict', W.changed, { code: 'BROWSER_SKILL_CHANGED' })
      // Approving is approving the version as a whole, as the page showed it: its files count as seen.
      repo(member.companyId).insert({
        skillPath: skillPathOf(skill), declarationHash: j.hash, mode: mode as BrowserSkillApprovalMode, how: 'approved',
        approvedBy: member.userId, approvedAt: deps.clock.now(), filesSeen: content.files,
      })
      return ok(viewOf(member.companyId, j))
    },

    /** POST /browser-skill-approvals/revoke { skill } (owner/admin): take the latest approval back. */
    revoke(member: Member, body: unknown): Outcome<{ revoked: true }> {
      if (!hasFullAccess(member.role)) return forbidden()
      if (!isMap(body) || !exactKeys(body, ['skill']) || typeof body.skill !== 'string' || !isValidSkillName(body.skill)) return bad()
      const r = repo(member.companyId)
      const latest = r.latest(skillPathOf(body.skill))
      if (!latest || latest.revokedAt !== null || !r.revoke(latest.seq, deps.clock.now(), member.userId)) {
        return refuse('conflict', W.notRevocable, { code: 'BROWSER_SKILL_NOT_APPROVED' })
      }
      return ok({ revoked: true })
    },

    /**
     * Step ⑤'s question, asked at every permit: the frames the server builds from the approved declaration of this
     * Skill, read now from the company's own copy — or why not. Never trusts anything the app holds.
     */
    async approvedFrames(member: Pick<Member, 'companyId'>, skill: string): Promise<Outcome<BrowserSkillApproved>> {
      if (!isValidSkillName(skill)) return notFound()
      const content = await deps.source.read(member.companyId, skill)
      if (!content) return notFound()
      const j = judge(member.companyId, content)
      if (j.problem || !j.declaration) {
        const problem = j.problem ?? 'not-object'
        return refuse('conflict', BROWSER_SKILL_PROBLEM_WORDS[problem], { code: problem === 'not-registered' ? 'BROWSER_SKILL_DOMAIN_NOT_REGISTERED' : 'BROWSER_SKILL_BAD_DECLARATION' })
      }
      const approval = inForce(repo(member.companyId).latest(skillPathOf(skill)), j.hash)
      if (!approval) return refuse('conflict', W.notApproved, { code: 'BROWSER_SKILL_NOT_APPROVED' })
      // `filesSeen` null: approved by an owner / admin's own change, not yet run — the card once, nobody told.
      const textChanged = approval.filesSeen !== null && approval.filesSeen !== content.files
      if (textChanged) noticeTextChanged(member.companyId, j, null)
      return ok({
        skill, declarationHash: j.hash, files: content.files, frames: browserSkillFrames(j.declaration), mode: approval.mode, approval: approval.seq,
        textChanged, needsRunCard: approval.mode === 'per_run' || approval.filesSeen !== content.files,
      })
    },

    /**
     * Step ⑤'s second look inside its transaction (synchronous: no git read): the approval `approvedFrames` answered
     * (`approval`, its row) is still the skill's latest, in force, for exactly this declaration hash. `approvedFrames`
     * read before the transaction; this catches an approval revoked, superseded or given another mode in between (a
     * `pre_approved` replaced by `per_run` is a new row: Codex review of ⑤a).
     */
    stillApproved(member: Pick<Member, 'companyId'>, skill: string, declarationHash: string, approval: number): boolean {
      if (!isValidSkillName(skill)) return false
      return inForce(repo(member.companyId).latest(skillPathOf(skill)), declarationHash)?.seq === approval
    },

    /** Step ⑤: the per-run card was shown for this version (`files` as `approvedFrames` gave it); false when the approval moved. */
    runCardShown(member: Pick<Member, 'companyId'>, skill: string, declarationHash: string, files: string): boolean {
      if (!isValidSkillName(skill)) return false
      const r = repo(member.companyId)
      const approval = inForce(r.latest(skillPathOf(skill)), declarationHash)
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
          const current = await deps.source.read(companyId, content.name)
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
      if (item.kind !== 'skill' || item.departmentId !== null) return
      // Only the publisher's own upload counts as their change. Putting an earlier version back or publishing a member's
      // request lands a declaration nobody reviewed on 「Skill の承認」: it waits (independent review M2).
      const by = versions.how === 'publish' ? member : { userId: member.userId, role: 'member' }
      // Judged at exactly the version this member wrote, and only while it is still the current one (as a push).
      later('Reading a shelf Skill for browser Skills failed', member.companyId, async () => {
        const content = await deps.source.shelfLanded(member.companyId, item.name, versions)
        if (!content) return
        const current = await deps.source.read(member.companyId, item.name)
        landed(member.companyId, by, content, current)
      })
    },

    /** The inbox's text of a `browser_skill:` notice, built when read (owner / admin only; else not shown). */
    noticeText(member: Member, dedupeKey: string | null): string | null {
      if (!hasFullAccess(member.role) || !dedupeKey) return null
      const m = NOTICE_RE.exec(dedupeKey)
      if (!m) return null
      return m[1] === 'waiting'
        ? `ブラウザ操作：Skill「${m[2]}」の宣言（書き込み先など）が直されました。管理画面の「Skill の承認」で確かめて承認するまで、この Skill では書き込めません`
        : `ブラウザ操作：Skill「${m[2]}」の手順が直りました。次に動かすときは、前もって承認していても、実行の前に確かめのカードが1回出ます`
    },
  }
}

export type BrowserSkillService = ReturnType<typeof createBrowserSkillService>
