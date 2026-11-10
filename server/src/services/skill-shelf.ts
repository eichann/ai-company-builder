/**
 * The Skill shelf (「会社の Skill」, plugins.md "The Skill shelf", owner decision 2026-11-07): how
 * a company WITHOUT the shared company folder shares Skills, AI instruction texts and rule files —
 * from the server, on the path business plugins take. The server stores and checks; it never runs
 * what it stores. A company with the shared folder keeps sharing them by sync: every endpoint
 * answers it 409 SKILL_SHELF_NOT_HERE.
 *
 * - Publishing (`publish`, `restore`, `unpublish`) runs the push checker's own file rules on the
 *   place path each file would have in a company folder (shared/core/skill-shelf.ts
 *   `shelfChangeProblems`: agent config owner/admin only, instruction files for the department's
 *   managers, skill files for managers and 「Skill を直せる人」, auto-run parts owner/admin only)
 *   plus the push checker's write check of that place (`resolveAccess(...).write`) and its secret
 *   patterns. Concurrency: the caller sends the version they saw; someone else's change first →
 *   409 SHELF_VERSION_CHANGED with the current one.
 * - Reading (`list`, `versions`, `content`, `mine`) shows only items of places the member reads
 *   (a department, or a read-restricted department of #648 / its groups, through `resolveAccess`):
 *   anything else is the same 404 as an item that does not exist, never named.
 * - Every version is kept until an owner/admin removes it (`removeVersion`, never the current one;
 *   `removeItem` for an item taken off): putting an earlier one back is `restore` (checked like
 *   publishing it, secrets included). The company limit is checked inside the publish's write.
 * - Requests (「会社に出してほしいと頼む」, owner decision 2026-11-09): someone who may NOT publish a
 *   Skill at a place sends it (`createRequest`: the publish checks that do not depend on who sends
 *   it — paths, sizes, secrets, and the parts only an owner/admin may publish, `shelfRequestProblems`
 *   — refused when sent); those who may publish there see it (`requests`, `requestFiles`) and
 *   publish it (`publishRequest`: the whole publish check again, with their authority; the history
 *   keeps who asked) or decline it (`declineRequest`). A request is seen only by its sender and by
 *   those who may publish at its place, and only while they read that place: anything else is the
 *   same 404 as a request that does not exist.
 */
import { resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import { secretIn } from '../../shared/core/secret-patterns'
import {
  INSTRUCTIONS_NAME, SHELF_LIMITS, SHELF_REQUEST_LIMITS, isShelfKind, isShelfVersion, isValidShelfName, shelfChangeProblems, shelfFileNeedsText,
  shelfFilePathProblem, shelfListing, shelfPathClash, shelfRequestProblems, shelfTextFileName, type ShelfAuthority, type ShelfKind,
} from '../../shared/core/skill-shelf'
import { autorunFindingsInText } from '../../shared/core/skill-autorun'
import type { SkillEditing } from '../../shared/core/skill-files'
import type {
  DeliveredShelfItem, MyShelfRequest, MyShelfView, ShelfItemView, ShelfListView, ShelfPerson, ShelfPublishResult, ShelfRequestContent,
  ShelfRequestDecided, ShelfRequestView, ShelfRequestsView, ShelfVersionContent, ShelfVersionsView,
} from '../../shared/types/skill-shelf'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { ShelfItemRow, ShelfRequestRow, ShelfStoredFile } from '../ports/skill-shelf'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export const SHELF_NOT_HERE = {
  error: 'この会社では、Skill と AI への指示は全社フォルダで共有しています。',
  code: 'SKILL_SHELF_NOT_HERE',
} as const
export const SHELF_ITEM_NOT_FOUND = { error: 'その Skill・指示は見つかりません。', code: 'SHELF_ITEM_NOT_FOUND' } as const
export const SHELF_PLACE_NOT_FOUND = { error: 'その部署は見つかりません。', code: 'SHELF_PLACE_NOT_FOUND' } as const
export const SHELF_VERSION_NOT_FOUND = { error: 'その版は見つかりません。', code: 'SHELF_VERSION_NOT_FOUND' } as const
export const SHELF_VERSION_CHANGED = {
  error: 'ほかの人が先に変えました。いまの内容を確かめてから、もう一度やり直してください。',
  code: 'SHELF_VERSION_CHANGED',
} as const
export const SHELF_NOT_ALLOWED = {
  error: 'この Skill・指示を変えられるのは、決められた人だけです。自動で動く部分（hooks や ! で始まるコマンドなど）は、オーナーと管理者だけが入れられます。',
  code: 'SHELF_NOT_ALLOWED',
} as const
export const SHELF_CONTENT_CHANGED = { error: 'この版の中身が変わっています。管理者に確かめてもらってください。', code: 'SHELF_CONTENT_CHANGED' } as const
export const SHELF_COMPANY_FULL = {
  error: '会社の Skill の置き場がいっぱいです。使っていない Skill を整理してください。',
  code: 'SHELF_COMPANY_FULL',
} as const

export const SHELF_OWNER_ADMIN_ONLY = { error: '版や Skill を消せるのは、オーナーと管理者だけです。', code: 'SHELF_OWNER_ADMIN_ONLY' } as const
export const SHELF_VERSION_IS_CURRENT = {
  error: 'いま配っている版は消せません。別の版に戻すか、配るのをやめてから消してください。',
  code: 'SHELF_VERSION_IS_CURRENT',
} as const
export const SHELF_ITEM_PUBLISHED = { error: '配っているものは消せません。先に配るのをやめてください。', code: 'SHELF_ITEM_PUBLISHED' } as const

export const SHELF_REQUEST_NOT_FOUND = { error: 'そのお願いは見つかりません。', code: 'SHELF_REQUEST_NOT_FOUND' } as const
export const SHELF_REQUEST_NOT_NEEDED = {
  error: 'あなたはこの場所に公開できます。お願いせずに「会社に公開」を使ってください。',
  code: 'SHELF_REQUEST_NOT_NEEDED',
} as const
export const SHELF_REQUEST_CHANGED = { error: 'お願いの中身が変わりました。もう一度中身を見てください。', code: 'SHELF_REQUEST_CHANGED' } as const
export const SHELF_REQUEST_DECIDED = { error: 'このお願いは、もう公開されたか見送られています。', code: 'SHELF_REQUEST_DECIDED' } as const
export const SHELF_REQUEST_NOT_DECIDER = {
  error: 'このお願いを公開したり見送ったりできるのは、この場所に Skill を公開できる人だけです。',
  code: 'SHELF_REQUEST_NOT_DECIDER',
} as const
export const SHELF_REQUEST_MEMBER_LIMIT = {
  error: `返事を待っているお願いが多すぎます（1人 ${SHELF_REQUEST_LIMITS.pendingPerMember} 件まで）。返事が来てから、もう一度やり直してください。`,
  code: 'SHELF_REQUEST_LIMIT',
} as const
export const SHELF_REQUEST_COMPANY_LIMIT = {
  error: '会社全体で、返事を待っているお願いが多すぎます。管理者に相談してください。',
  code: 'SHELF_REQUEST_LIMIT',
} as const

export interface SkillShelfDeps {
  companyData: CompanyDataSource
  /** Does the company have the shared company folder (services/company-folder.ts)? */
  hasCompanyFolder(companyId: string): boolean
  /** Department folders (NFC) the member manages (permission-views.ts). */
  managedFolders(companyId: string, userId: string): string[]
  /** The member's place on 「Skill を直せる人」 (permission-views.ts). */
  skillEditing(companyId: string, userId: string): SkillEditing
  accounts: Pick<AccountDirectory, 'byIds'>
  clock: Clock
  ids: IdGenerator
  /** sha256 of bytes, lower-case hex (composition: node's crypto). */
  sha256(bytes: Uint8Array): string
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const bad = (code: string, error: string, extra: Record<string, unknown> = {}) => refuse('bad-request', error, { code, ...extra })

/** A checked file: its path, bytes, and the text when the auto-run check reads it. */
interface ShelfFile {
  path: string
  bytes: Buffer
  text?: string
}

const utf8 = (bytes: Buffer) => bytes.toString('utf8')

function filesOf(stored: ShelfStoredFile[]): ShelfFile[] {
  return stored.map(f => {
    const bytes = Buffer.from(f.base64, 'base64')
    return { path: f.path, bytes, ...(shelfFileNeedsText(f.path) ? { text: utf8(bytes) } : {}) }
  })
}

/**
 * The files of a publish request, checked: names, paths (nothing can leave the folder), sizes,
 * SKILL.md, secrets. A Skill sends `files`; an instruction text or a rule file sends `text`.
 */
export function parseShelfContent(kind: ShelfKind, name: string, body: Record<string, unknown>): Outcome<ShelfFile[]> {
  if (kind !== 'skill') {
    if (body.files !== undefined) return bad('SHELF_BAD_CONTENT', 'Instruction texts and rule files are sent as text')
    if (typeof body.text !== 'string' || body.text.trim() === '') return bad('SHELF_EMPTY_TEXT', '中身が空です。')
    const bytes = Buffer.from(body.text, 'utf8')
    if (bytes.length > SHELF_LIMITS.textBytes) return bad('SHELF_TOO_LARGE', `文章が大きすぎます（${SHELF_LIMITS.textBytes / 1024} KB まで）。`)
    return ok([{ path: shelfTextFileName(kind, name), bytes, text: body.text }])
  }
  if (body.text !== undefined) return bad('SHELF_BAD_CONTENT', 'A Skill is sent as files')
  const raw = body.files
  if (!Array.isArray(raw) || raw.length === 0) return bad('SHELF_BAD_CONTENT', 'files must be a non-empty array of { path, base64 }')
  if (raw.length > SHELF_LIMITS.files) return bad('SHELF_TOO_MANY_FILES', `ファイルが多すぎます（${SHELF_LIMITS.files} 個まで）。`)
  const files: ShelfFile[] = []
  let total = 0
  for (const f of raw) {
    if (!isObject(f) || typeof f.base64 !== 'string') return bad('SHELF_BAD_CONTENT', 'files must be a non-empty array of { path, base64 }')
    const problem = shelfFilePathProblem(f.path)
    // The path is the member's own upload; echoing it back names nothing they did not send.
    if (problem) return bad('SHELF_BAD_PATH', 'ファイルの名前か場所が使えません。', { path: typeof f.path === 'string' ? f.path : null, problem })
    const tooLarge = () => bad('SHELF_FILE_TOO_LARGE', `大きすぎるファイルがあります（1つ ${SHELF_LIMITS.fileBytes / 1024 / 1024} MB まで）。`, { path: f.path })
    if (!BASE64_RE.test(f.base64)) return bad('SHELF_BAD_CONTENT', 'base64 is not valid', { path: f.path })
    const bytes = Buffer.from(f.base64, 'base64')
    if (bytes.length > SHELF_LIMITS.fileBytes) return tooLarge()
    total += bytes.length
    if (total > SHELF_LIMITS.skillBytes) return bad('SHELF_TOO_LARGE', `Skill 全体が大きすぎます（${SHELF_LIMITS.skillBytes / 1024 / 1024} MB まで）。`)
    files.push({ path: f.path as string, bytes, ...(shelfFileNeedsText(f.path as string) ? { text: utf8(bytes) } : {}) })
  }
  const clash = shelfPathClash(files.map(f => f.path))
  if (clash !== null) return bad('SHELF_BAD_PATH', '同じ名前とみなされるファイルがあります。', { path: clash, problem: 'clash' })
  if (!files.some(f => f.path === 'SKILL.md')) return bad('SHELF_NO_SKILL_MD', 'Skill のいちばん上に SKILL.md が必要です。')
  return ok(files)
}

export function createSkillShelfService(deps: SkillShelfDeps) {
  const { companyData, accounts, clock, ids } = deps

  const notHere = (): Refusal => refuse('conflict', SHELF_NOT_HERE.error, { code: SHELF_NOT_HERE.code })
  const itemNotFound = (): Refusal => refuse('not-found', SHELF_ITEM_NOT_FOUND.error, { code: SHELF_ITEM_NOT_FOUND.code })

  /** What a member's request is judged with, read once per request. */
  function contextOf(member: Member) {
    const handle = companyData.forCompany(member.companyId)
    const scopes = handle.scopes.listWithRules()
    const perms: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => scopes }
    const access = (folder: string | null) => resolveAccess(member.companyId, member.userId, folder ?? '', perms)
    const departments = new Map(handle.departments.listUnordered().map(d => [d.id, d]))
    const authority: ShelfAuthority = {
      role: member.role,
      managedFolders: deps.managedFolders(member.companyId, member.userId),
      skillEditing: deps.skillEditing(member.companyId, member.userId),
    }
    /** The department folder of an item's place (null = the whole company), or undefined when it is gone. */
    const folderOf = (departmentId: string | null): string | null | undefined =>
      departmentId === null ? null : departments.get(departmentId)?.folder.normalize('NFC')
    /** May the member read this place (a department they cannot read — e.g. a restricted one — is not there for them)? */
    const reads = (departmentId: string | null) => {
      const folder = folderOf(departmentId)
      return folder !== undefined && access(folder).read
    }
    /** Why these files may not be published here by this member (empty = they may). */
    const problems = (kind: ShelfKind, departmentId: string | null, name: string, files: ReadonlyArray<{ path: string; text?: string }>, autorun: boolean) => {
      const folder = folderOf(departmentId) ?? null
      // The push checker's write check of the place: a list grants no folder access.
      if (!access(folder).write) return files.map(f => ({ path: f.path, reason: 'no-write' as const }))
      return shelfChangeProblems(authority, kind, folder, name, files, { autorun })
    }
    const representative = (row: ShelfItemRow) => [{ path: row.kind === 'skill' ? 'SKILL.md' : shelfTextFileName(row.kind, row.name) }]
    return { handle, departments, folderOf, reads, problems, representative }
  }

  type Context = ReturnType<typeof contextOf>

  function people(userIds: string[]): (id: string) => ShelfPerson {
    const found = accounts.byIds([...new Set(userIds)])
    return id => ({ id, name: found.get(id)?.name ?? null })
  }

  function view(ctx: Context, row: ShelfItemRow, person: (id: string) => ShelfPerson): ShelfItemView {
    const dept = row.departmentId === null ? null : ctx.departments.get(row.departmentId)
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      department: dept ? { id: dept.id, name: dept.name, folder: dept.folder } : null,
      version: row.currentVersion,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      changedAt: row.changedAt,
      changedBy: person(row.changedBy),
      canChange: ctx.problems(row.kind, row.departmentId, row.name, ctx.representative(row), false).length === 0,
    }
  }

  /** The item when the member reads its place; else the one 404 (a missing item answers the same). */
  function readableItem(ctx: Context, itemId: unknown): Outcome<ShelfItemRow> {
    if (typeof itemId !== 'string' || itemId.length > 100) return itemNotFound()
    const row = ctx.handle.skillShelf.item(itemId)
    if (!row || !ctx.reads(row.departmentId)) return itemNotFound()
    return ok(row)
  }

  function versionOf(files: ShelfFile[]): string {
    return deps.sha256(Buffer.from(shelfListing(files.map(f => ({ path: f.path, sha256: deps.sha256(f.bytes) }))), 'utf8'))
  }

  /** The push checker's secret patterns over every file (a binary file is read as text, the patterns are ASCII). */
  function secretsIn(files: ShelfFile[]): Refusal | null {
    for (const f of files) {
      const secret = secretIn(f.text ?? utf8(f.bytes))
      if (secret) return bad('SHELF_SECRET_DETECTED', 'パスワードやキーのようなものが入っています。取り除いてから、もう一度やり直してください。', { path: f.path, pattern: secret })
    }
    return null
  }

  function notAllowed(list: Array<{ path: string; reason: string; findings?: string[] }>): Refusal {
    return refuse('forbidden', SHELF_NOT_ALLOWED.error, { code: SHELF_NOT_ALLOWED.code, files: list })
  }

  function changed(currentVersion: string | null): Refusal {
    return refuse('conflict', SHELF_VERSION_CHANGED.error, { code: SHELF_VERSION_CHANGED.code, currentVersion })
  }

  function parseExpected(value: unknown): Outcome<string | null> {
    if (value === null || isShelfVersion(value)) return ok(value)
    return bad('SHELF_BAD_VERSION', 'expectedVersion must be the version you saw (64 hex) or null')
  }

  function result(ctx: Context, itemId: string, wasChanged: boolean): ShelfPublishResult {
    const row = ctx.handle.skillShelf.item(itemId) as ShelfItemRow
    return { item: view(ctx, row, people([row.changedBy])), changed: wasChanged }
  }

  /** May the member publish a Skill at this request's place (who may 公開する / 見送る)? Content aside: judged again on publishing. */
  const mayDecide = (ctx: Context, row: ShelfRequestRow) =>
    ctx.reads(row.departmentId) && ctx.problems('skill', row.departmentId, row.name, [{ path: 'SKILL.md' }], false).length === 0

  /** The request when the member sent it or may decide it, and reads its place; else the one 404. */
  function visibleRequest(ctx: Context, member: Member, requestId: unknown): Outcome<ShelfRequestRow> {
    const notFound = refuse('not-found', SHELF_REQUEST_NOT_FOUND.error, { code: SHELF_REQUEST_NOT_FOUND.code })
    if (typeof requestId !== 'string' || requestId.length > 100) return notFound
    const row = ctx.handle.skillShelf.request(requestId)
    if (!row || !ctx.reads(row.departmentId)) return notFound
    if (row.requestedBy !== member.userId && !mayDecide(ctx, row)) return notFound
    return ok(row)
  }

  function requestView(ctx: Context, member: Member, row: ShelfRequestRow, person: (id: string) => ShelfPerson): ShelfRequestView {
    const dept = row.departmentId === null ? null : ctx.departments.get(row.departmentId)
    return {
      id: row.id,
      name: row.name,
      department: dept ? { id: dept.id, name: dept.name, folder: dept.folder } : null,
      requestedBy: person(row.requestedBy),
      requestedAt: row.requestedAt,
      state: row.state,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      version: row.version,
      autorun: row.autorun,
      decidedBy: row.decidedBy ? person(row.decidedBy) : null,
      decidedAt: row.decidedAt,
      reason: row.reason,
      publishedVersion: row.publishedVersion,
      mine: row.requestedBy === member.userId,
      canDecide: mayDecide(ctx, row),
      currentVersion: ctx.handle.skillShelf.itemAt('skill', row.departmentId, row.name)?.currentVersion ?? null,
    }
  }

  /** Who may 公開する / 見送る, checked before the body: 404 when not seen, 403 for a sender who may not, 409 once decided. */
  function decidable(ctx: Context, member: Member, requestId: string): Outcome<ShelfRequestRow> {
    const found = visibleRequest(ctx, member, requestId)
    if (!found.ok) return found
    if (!mayDecide(ctx, found.value)) return refuse('forbidden', SHELF_REQUEST_NOT_DECIDER.error, { code: SHELF_REQUEST_NOT_DECIDER.code })
    if (found.value.state !== 'pending') return refuse('conflict', SHELF_REQUEST_DECIDED.error, { code: SHELF_REQUEST_DECIDED.code })
    return found
  }

  const requestChanged = () => refuse('conflict', SHELF_REQUEST_CHANGED.error, { code: SHELF_REQUEST_CHANGED.code })
  /** The version of the request's files the decider looked at (`ShelfRequestContent.version`, also in the list). */
  function parseRequestVersion(body: unknown): Outcome<string> {
    const v = isObject(body) ? body.requestVersion : undefined
    return isShelfVersion(v) ? ok(v) : bad('SHELF_BAD_VERSION', 'requestVersion must be the version of the request that was looked at')
  }

  function decidedView(ctx: Context, member: Member, requestId: string, itemId?: string): ShelfRequestDecided {
    const row = ctx.handle.skillShelf.request(requestId) as ShelfRequestRow
    const out: ShelfRequestDecided = { request: requestView(ctx, member, row, people(row.decidedBy ? [row.requestedBy, row.decidedBy] : [row.requestedBy])) }
    if (itemId) out.item = result(ctx, itemId, true).item
    return out
  }

  const service = {
    /** GET /skill-shelf — every item of a place the member reads, published or taken off. */
    list(member: Member): Outcome<ShelfListView> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const rows = ctx.handle.skillShelf.items().filter(r => ctx.reads(r.departmentId))
      const person = people(rows.map(r => r.changedBy))
      return ok({ items: rows.map(r => view(ctx, r, person)) })
    },

    /**
     * GET /me/skill-shelf — what the member's app places: the current version of every item of a
     * place they read (`reads`, the one read check: a department's people, its groups, people
     * named on it; owners/admins read every place), and where they may publish a Skill
     * (`problems`, the publish check itself), so the app offers 「会社に公開」 only there.
     */
    mine(member: Member): Outcome<MyShelfView> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const items: DeliveredShelfItem[] = ctx.handle.skillShelf.items()
        .filter(r => r.currentVersion !== null && ctx.reads(r.departmentId))
        .map(r => {
          const dept = r.departmentId === null ? null : ctx.departments.get(r.departmentId)
          return {
            id: r.id, kind: r.kind, name: r.name,
            department: dept ? { id: dept.id, folder: dept.folder } : null,
            version: r.currentVersion as string, fileCount: r.fileCount, totalBytes: r.totalBytes, changedAt: r.changedAt,
          }
        })
      // Content aside (auto-run parts are judged on the files): may a Skill be published at the place at all?
      const mayPublish = (departmentId: string | null) => ctx.problems('skill', departmentId, 'skill', [{ path: 'SKILL.md' }], false).length === 0
      // `reads` as publishing asks it first (a company without the shared folder allows no write-only rule).
      const departmentFolders = [...ctx.departments.values()]
        .filter(d => ctx.reads(d.id) && mayPublish(d.id))
        .map(d => d.folder.normalize('NFC'))
      // Their own requests, only at places they still read (a department's name never leaks through them).
      const requests: MyShelfRequest[] = ctx.handle.skillShelf.requestsBy(member.userId)
        .filter(r => ctx.reads(r.departmentId))
        .map(r => {
          const dept = r.departmentId === null ? null : ctx.departments.get(r.departmentId)
          return {
            id: r.id, name: r.name, department: dept ? { id: dept.id, folder: dept.folder } : null,
            state: r.state, requestedAt: r.requestedAt, decidedAt: r.decidedAt, reason: r.reason,
          }
        })
      return ok({ items, skillPublishing: { company: mayPublish(null), departmentFolders }, requests })
    },

    /** GET /skill-shelf/:itemId/versions — every version (newest first) and who changed what. */
    versions(member: Member, itemId: string): Outcome<ShelfVersionsView> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = readableItem(ctx, itemId)
      if (!found.ok) return found
      const row = found.value
      const versions = ctx.handle.skillShelf.versions(row.id)
      const history = ctx.handle.skillShelf.history(row.id)
      const person = people([row.changedBy, ...versions.map(v => v.publishedBy), ...history.flatMap(h => (h.requestedBy ? [h.byUser, h.requestedBy] : [h.byUser]))])
      return ok({
        item: view(ctx, row, person),
        versions: versions.map(v => ({
          version: v.version, fileCount: v.fileCount, totalBytes: v.totalBytes, publishedAt: v.publishedAt,
          publishedBy: person(v.publishedBy), current: v.version === row.currentVersion, autorun: v.autorun,
        })),
        history: history.map(h => ({ action: h.action, version: h.version, at: h.at, by: person(h.byUser), ...(h.requestedBy ? { requestedBy: person(h.requestedBy) } : {}) })),
      })
    },

    /** GET /skill-shelf/:itemId/versions/:version — the files (checked against the version on the way out). */
    content(member: Member, itemId: string, version: string): Outcome<ShelfVersionContent> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = readableItem(ctx, itemId)
      if (!found.ok) return found
      const row = found.value
      const stored = isShelfVersion(version) ? ctx.handle.skillShelf.versionFiles(row.id, version) : null
      if (!stored) return refuse('not-found', SHELF_VERSION_NOT_FOUND.error, { code: SHELF_VERSION_NOT_FOUND.code })
      if (versionOf(filesOf(stored)) !== version) return refuse('conflict', SHELF_CONTENT_CHANGED.error, { code: SHELF_CONTENT_CHANGED.code })
      return ok({ id: row.id, kind: row.kind, name: row.name, version, files: stored.map(f => ({ path: f.path, base64: f.base64 })) })
    },

    /** POST /skill-shelf — publish a Skill, an instruction text or a rule file at a place. */
    publish(member: Member, body: unknown): Outcome<ShelfPublishResult & { created: boolean }> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      if (!isObject(body)) return bad('SHELF_BAD_CONTENT', 'Request body must be a JSON object')
      if (!isShelfKind(body.kind)) return bad('SHELF_BAD_KIND', 'kind must be skill, instructions or rule')
      const kind = body.kind
      const name = kind === 'instructions' && body.name === undefined ? INSTRUCTIONS_NAME : body.name
      if (!isValidShelfName(kind, name)) return bad('SHELF_BAD_NAME', '名前は半角の英小文字・数字・「-」「_」で入れてください（64文字まで）。')
      if (body.departmentId !== null && typeof body.departmentId !== 'string') return bad('SHELF_BAD_CONTENT', 'departmentId must be a department id or null')
      const expected = parseExpected(body.expectedVersion)
      if (!expected.ok) return expected
      const content = parseShelfContent(kind, name, body)
      if (!content.ok) return content
      const files = content.value

      const ctx = contextOf(member)
      const departmentId = body.departmentId as string | null
      // A department that does not exist and one the member cannot read: one answer.
      if (!ctx.reads(departmentId)) return refuse('not-found', SHELF_PLACE_NOT_FOUND.error, { code: SHELF_PLACE_NOT_FOUND.code })
      const problems = ctx.problems(kind, departmentId, name, files, true)
      if (problems.length > 0) return notAllowed(problems)
      const secret = secretsIn(files)
      if (secret) return secret
      const totalBytes = files.reduce((n, f) => n + f.bytes.length, 0)
      const version = versionOf(files)
      const existing = ctx.handle.skillShelf.itemAt(kind, departmentId, name)
      const written = ctx.handle.skillShelf.put({
        newItemId: ids.newId(), kind, departmentId, name, expected: expected.value, version,
        files: files.map(f => ({ path: f.path, base64: f.bytes.toString('base64') })),
        fileCount: files.length, totalBytes,
        autorun: files.some(f => f.text !== undefined && kind === 'skill' && autorunFindingsInText(f.text).length > 0),
        companyLimitBytes: SHELF_LIMITS.companyBytes,
        at: clock.now(), by: member.userId,
      })
      if (!written.ok) {
        if (written.reason === 'conflict') return changed(written.currentVersion)
        if (written.reason === 'full') return refuse('conflict', SHELF_COMPANY_FULL.error, { code: SHELF_COMPANY_FULL.code })
        return itemNotFound()
      }
      return ok({ ...result(ctx, written.itemId, written.changed), created: !existing })
    },

    /** POST /skill-shelf/:itemId/restore { version, expectedVersion } — put an earlier version back (checked like publishing it). */
    restore(member: Member, itemId: string, body: unknown): Outcome<ShelfPublishResult> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = readableItem(ctx, itemId)
      if (!found.ok) return found
      const row = found.value
      if (!isObject(body) || !isShelfVersion(body.version)) return bad('SHELF_BAD_VERSION', 'version must be a version of this item')
      const expected = parseExpected(body.expectedVersion)
      if (!expected.ok) return expected
      const stored = ctx.handle.skillShelf.versionFiles(row.id, body.version)
      if (!stored) return refuse('not-found', SHELF_VERSION_NOT_FOUND.error, { code: SHELF_VERSION_NOT_FOUND.code })
      const restored = filesOf(stored)
      const problems = ctx.problems(row.kind, row.departmentId, row.name, restored, true)
      if (problems.length > 0) return notAllowed(problems)
      // Checked again: a version stored before a pattern was added must not come back with it.
      const secret = secretsIn(restored)
      if (secret) return secret
      const written = ctx.handle.skillShelf.setCurrent(row.id, expected.value, body.version, clock.now(), member.userId)
      if (!written.ok) return written.reason === 'conflict' ? changed(written.currentVersion) : itemNotFound()
      return ok(result(ctx, row.id, written.changed))
    },

    /** POST /skill-shelf/:itemId/unpublish { expectedVersion } — stop handing it out (its versions stay). */
    unpublish(member: Member, itemId: string, body: unknown): Outcome<ShelfPublishResult> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = readableItem(ctx, itemId)
      if (!found.ok) return found
      const row = found.value
      if (!isObject(body)) return bad('SHELF_BAD_VERSION', 'expectedVersion must be the version you saw (64 hex) or null')
      const expected = parseExpected(body.expectedVersion)
      if (!expected.ok) return expected
      // Taking files away is a change of those paths (git: a deletion), the auto-run check aside.
      const current = row.currentVersion ? ctx.handle.skillShelf.versionFiles(row.id, row.currentVersion) : null
      const paths = current ? current.map(f => ({ path: f.path })) : ctx.representative(row)
      const problems = ctx.problems(row.kind, row.departmentId, row.name, paths, false)
      if (problems.length > 0) return notAllowed(problems)
      const written = ctx.handle.skillShelf.setCurrent(row.id, expected.value, null, clock.now(), member.userId)
      if (!written.ok) return written.reason === 'conflict' ? changed(written.currentVersion) : itemNotFound()
      return ok(result(ctx, row.id, written.changed))
    },

    /**
     * DELETE /skill-shelf/:itemId/versions/:version — owners and admins remove an old version (never
     * the current one) to make room; the removal is in the history. Without it, versions only grow
     * and one busy editor could fill the company's limit for everyone.
     */
    removeVersion(member: Member, itemId: string, version: string): Outcome<ShelfVersionsView> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = readableItem(ctx, itemId)
      if (!found.ok) return found
      if (!hasFullAccess(member.role)) return refuse('forbidden', SHELF_OWNER_ADMIN_ONLY.error, { code: SHELF_OWNER_ADMIN_ONLY.code })
      const removed = isShelfVersion(version) ? ctx.handle.skillShelf.removeVersion(found.value.id, version, clock.now(), member.userId) : 'not-found'
      if (removed === 'not-found') return refuse('not-found', SHELF_VERSION_NOT_FOUND.error, { code: SHELF_VERSION_NOT_FOUND.code })
      if (removed === 'current') return refuse('conflict', SHELF_VERSION_IS_CURRENT.error, { code: SHELF_VERSION_IS_CURRENT.code })
      return service.versions(member, itemId)
    },

    /**
     * DELETE /skill-shelf/:itemId — owners and admins remove an item that is taken off, with its
     * versions and history (what a department needs before it can be deleted).
     */
    removeItem(member: Member, itemId: string): Outcome<{ removed: true }> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = readableItem(ctx, itemId)
      if (!found.ok) return found
      if (!hasFullAccess(member.role)) return refuse('forbidden', SHELF_OWNER_ADMIN_ONLY.error, { code: SHELF_OWNER_ADMIN_ONLY.code })
      const removed = ctx.handle.skillShelf.removeItem(found.value.id)
      if (removed === 'not-found') return itemNotFound()
      if (removed === 'published') return refuse('conflict', SHELF_ITEM_PUBLISHED.error, { code: SHELF_ITEM_PUBLISHED.code })
      return ok({ removed: true })
    },

    /** GET /skill-shelf-requests — the member's own requests and those they may decide, at places they read. */
    requests(member: Member): Outcome<ShelfRequestsView> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const rows = ctx.handle.skillShelf.requests(SHELF_REQUEST_LIMITS.decidedShown)
        .filter(r => ctx.reads(r.departmentId) && (r.requestedBy === member.userId || mayDecide(ctx, r)))
      const person = people(rows.flatMap(r => (r.decidedBy ? [r.requestedBy, r.decidedBy] : [r.requestedBy])))
      return ok({ requests: rows.map(r => requestView(ctx, member, r, person)) })
    },

    /**
     * POST /skill-shelf-requests — 「会社に出してほしいと頼む」: a Skill folder from someone who may not
     * publish it at that place. Refused when sent for what no publisher could take from them either.
     */
    createRequest(member: Member, body: unknown): Outcome<ShelfRequestView> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      if (!isObject(body)) return bad('SHELF_BAD_CONTENT', 'Request body must be a JSON object')
      if (!isValidShelfName('skill', body.name)) return bad('SHELF_BAD_NAME', '名前は半角の英小文字・数字・「-」「_」で入れてください（64文字まで）。')
      const name = body.name
      if (body.departmentId !== null && typeof body.departmentId !== 'string') return bad('SHELF_BAD_CONTENT', 'departmentId must be a department id or null')
      const content = parseShelfContent('skill', name, { files: body.files })
      if (!content.ok) return content
      const files = content.value

      const ctx = contextOf(member)
      const departmentId = body.departmentId as string | null
      // A department that does not exist and one the member cannot read: one answer.
      if (!ctx.reads(departmentId)) return refuse('not-found', SHELF_PLACE_NOT_FOUND.error, { code: SHELF_PLACE_NOT_FOUND.code })
      // Someone who may publish here publishes; a request is for those who may not.
      if (ctx.problems('skill', departmentId, name, files, false).length === 0) {
        return refuse('conflict', SHELF_REQUEST_NOT_NEEDED.error, { code: SHELF_REQUEST_NOT_NEEDED.code })
      }
      // What only an owner/admin may publish (agent config, auto-run parts): refused now, with publishing's reasons.
      const onlyOwners = shelfRequestProblems('skill', ctx.folderOf(departmentId) ?? null, name, files)
      if (onlyOwners.length > 0) return notAllowed(onlyOwners)
      const secret = secretsIn(files)
      if (secret) return secret
      const written = ctx.handle.skillShelf.putRequest({
        newId: ids.newId(), departmentId, name, by: member.userId, at: clock.now(), version: versionOf(files),
        files: files.map(f => ({ path: f.path, base64: f.bytes.toString('base64') })), fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + f.bytes.length, 0),
        autorun: false,
        limits: SHELF_REQUEST_LIMITS,
      })
      if (!written.ok) {
        const limit = written.reason === 'member-limit' ? SHELF_REQUEST_MEMBER_LIMIT : SHELF_REQUEST_COMPANY_LIMIT
        return refuse('conflict', limit.error, { code: limit.code })
      }
      const row = ctx.handle.skillShelf.request(written.id) as ShelfRequestRow
      return ok(requestView(ctx, member, row, people([member.userId])))
    },

    /** GET /skill-shelf-requests/:requestId/files — a pending request's files (its sender, or who may decide it). */
    requestFiles(member: Member, requestId: string): Outcome<ShelfRequestContent> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = visibleRequest(ctx, member, requestId)
      if (!found.ok) return found
      const stored = ctx.handle.skillShelf.requestFiles(found.value.id)
      if (!stored) return refuse('conflict', SHELF_REQUEST_DECIDED.error, { code: SHELF_REQUEST_DECIDED.code })
      return ok({ id: found.value.id, name: found.value.name, version: found.value.version, files: stored.map(f => ({ path: f.path, base64: f.base64 })) })
    },

    /**
     * POST /skill-shelf-requests/:requestId/publish { expectedVersion, requestVersion } — 公開する:
     * published as a new version by the caller (every publish check again, with their authority), the
     * history noting who asked; the request is decided and its files go, in the same transaction.
     * `requestVersion` is the version of the files the caller looked at: anything else → 409
     * `SHELF_REQUEST_CHANGED` (a request sent again has a new id, so an old id is 404 anyway).
     */
    publishRequest(member: Member, requestId: string, body: unknown): Outcome<ShelfRequestDecided> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = decidable(ctx, member, requestId)
      if (!found.ok) return found
      const row = found.value
      const expected = parseExpected(isObject(body) ? body.expectedVersion : undefined)
      if (!expected.ok) return expected
      const seen = parseRequestVersion(body)
      if (!seen.ok) return seen
      if (seen.value !== row.version) return requestChanged()
      const stored = ctx.handle.skillShelf.requestFiles(row.id)
      if (!stored) return refuse('conflict', SHELF_REQUEST_DECIDED.error, { code: SHELF_REQUEST_DECIDED.code })
      // The upload rules again (paths, sizes, count), and the files are still the version looked at.
      const content = parseShelfContent('skill', row.name, { files: stored })
      if (!content.ok) return content
      const files = content.value
      if (versionOf(files) !== row.version) return requestChanged()
      const problems = ctx.problems('skill', row.departmentId, row.name, files, true)
      if (problems.length > 0) return notAllowed(problems)
      // Checked again: a pattern added since it was sent.
      const secret = secretsIn(files)
      if (secret) return secret
      const version = versionOf(files)
      const at = clock.now()
      const written = ctx.handle.skillShelf.put({
        newItemId: ids.newId(), kind: 'skill', departmentId: row.departmentId, name: row.name, expected: expected.value, version,
        files: stored, fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes.length, 0),
        autorun: files.some(f => f.text !== undefined && autorunFindingsInText(f.text).length > 0),
        companyLimitBytes: SHELF_LIMITS.companyBytes,
        at, by: member.userId, requestedBy: row.requestedBy, fromRequest: { id: row.id, version: row.version },
      })
      if (!written.ok) {
        if (written.reason === 'request-changed') return requestChanged()
        if (written.reason === 'conflict') return changed(written.currentVersion)
        if (written.reason === 'full') return refuse('conflict', SHELF_COMPANY_FULL.error, { code: SHELF_COMPANY_FULL.code })
        return itemNotFound()
      }
      return ok(decidedView(ctx, member, row.id, written.itemId))
    },

    /** POST /skill-shelf-requests/:requestId/decline { requestVersion, reason? } — 見送る, with a short reason or none. */
    declineRequest(member: Member, requestId: string, body: unknown): Outcome<ShelfRequestDecided> {
      if (deps.hasCompanyFolder(member.companyId)) return notHere()
      const ctx = contextOf(member)
      const found = decidable(ctx, member, requestId)
      if (!found.ok) return found
      const raw = isObject(body) ? body.reason : undefined
      if (raw !== undefined && raw !== null && typeof raw !== 'string') return bad('SHELF_BAD_REASON', 'reason must be a string')
      const reason = typeof raw === 'string' ? raw.trim() : ''
      if (reason.length > SHELF_REQUEST_LIMITS.reasonLength) return bad('SHELF_BAD_REASON', `理由は ${SHELF_REQUEST_LIMITS.reasonLength} 文字までです。`)
      const seen = parseRequestVersion(body)
      if (!seen.ok) return seen
      if (!ctx.handle.skillShelf.declineRequest(found.value.id, seen.value, { by: member.userId, at: clock.now(), reason: reason || null })) return requestChanged()
      return ok(decidedView(ctx, member, found.value.id))
    },
  }
  return service
}

export type SkillShelfService = ReturnType<typeof createSkillShelfService>
