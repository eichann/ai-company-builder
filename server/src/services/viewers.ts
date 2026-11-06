/**
 * 見られる人 for many records and files at once (`POST …/viewers`, for the
 * lists: plan「新しい画面のデモ」K サーバー乙 ②; `.claude/rules/records.md`
 * "Who can see it"). The phrase is shared/core/viewers.ts; who reads what is
 * exactly `recordReader` (services/record-access.ts), evaluated for every
 * member of the company.
 *
 * No leaks (owner decision B, records.md "No leaks"):
 * - a record the caller cannot read is left out of the answer (as if it did
 *   not exist), so a private folder's name only ever reaches its readers;
 * - `cannotOpen` (who reads a record but not a file linked to it) is a count
 *   only, for a record and paths the caller reads;
 * - files are judged over the folders the caller can see: a private folder
 *   they cannot read is treated as not there (as company-files does), so a
 *   path inside one is answered exactly like a path that does not exist —
 *   asking cannot tell that a folder is private, nor name it.
 *
 * A members-only record (records.md "Members-only records") is judged by its own list, outside
 * the per-place cache (every such record has folder null: the cache would mix them up).
 *
 * Cost: the members' readers are built once per request, and the readers of
 * an item are computed once per set of folders above it (items in the same
 * place share one answer), so a list of 200 rows costs a few evaluations.
 */
import { canReadPrivateScope, findPrivateScope, FULL_ACCESS_ROLES, isSameOrAncestorPath, normalizeScopePath, type ScopeWithRules } from '../../shared/core/permissions'
import { pathKey } from '../../shared/core/paths'
import { VIEWERS_LIMITS, viewersLabel, type ViewersLabel } from '../../shared/core/viewers'
import type { ViewersAnswer } from '../../shared/types/viewers'
import type { AccountDirectory } from '../ports/accounts'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader, type RecordReader } from './record-access'
import { currentTypes } from './record-index'

export interface ViewersDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  accounts: AccountDirectory
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const stringList = (v: unknown, max: number): string[] | null | 'too-many' => {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 1000)) return null
  const unique = [...new Set(v as string[])]
  return unique.length > max ? 'too-many' : unique
}

export function createViewersService(deps: ViewersDeps) {
  return {
    /**
     * POST …/viewers { records?: string[], files?: string[] } (any member) → the phrase per record
     * id and per file path the caller can see; anything else is left out.
     */
    labels(member: Member, body: unknown): Outcome<ViewersAnswer> {
      if (!isObject(body)) return refuse('bad-request', 'Body must be { records?: string[], files?: string[], linked?: { record, paths } }')
      const recordIds = stringList(body.records, VIEWERS_LIMITS.records)
      const files = stringList(body.files, VIEWERS_LIMITS.files)
      if (recordIds === null || files === null) return refuse('bad-request', 'records and files must be lists of strings')
      if (recordIds === 'too-many' || files === 'too-many') {
        return refuse('bad-request', `At most ${VIEWERS_LIMITS.records} records and ${VIEWERS_LIMITS.files} files at once`)
      }
      let linked: { record: string; paths: string[] } | null = null
      if (body.linked !== undefined) {
        const l = body.linked
        const paths = isObject(l) ? stringList(l.paths, VIEWERS_LIMITS.files) : null
        if (!isObject(l) || typeof l.record !== 'string' || l.record.length === 0 || l.record.length > 200 || paths === null) {
          return refuse('bad-request', 'linked must be { record: string, paths: string[] }')
        }
        if (paths === 'too-many') return refuse('bad-request', `At most ${VIEWERS_LIMITS.files} linked paths at once`)
        linked = { record: l.record, paths }
      }
      const handle = deps.companyData.forCompany(member.companyId)
      const all = handle.scopes.listWithRules()
      // The folders the caller can see: an unreadable private folder (and every rule inside it) is not there.
      const hidden = all.filter(s => s.repoId !== null && !canReadPrivateScope(s, member.userId, member.role))
      const scopes = all.filter(s => !hidden.some(h => isSameOrAncestorPath(h.path, s.path)))

      const members = deps.memberships.listByCompany(member.companyId)
      const readers: Array<{ userId: string; reader: RecordReader }> = members.map(m => ({
        userId: m.user_id, reader: recordReader({ companyId: member.companyId, userId: m.user_id, role: m.role }, scopes),
      }))
      const caller = recordReader(member, scopes)
      // Records are judged over every folder: a server record may now sit in a private folder (a 非公開
      // 案件・プロジェクト and its tasks, records.md "Private 案件・プロジェクト"), which `scopes` leaves out for a
      // non-reader — read through it, the record would look like everyone's.
      const callerOverAll = recordReader(member, all)
      const fullAccess = new Set(members.filter(m => FULL_ACCESS_ROLES.has(m.role)).map(m => m.user_id))
      const departments = handle.departments.list().map(d => ({ id: d.id, name: d.name, key: pathKey(d.folder) }))
      const departmentMembers = new Map<string, string[]>()
      const names = new Map<string, string>()
      const nameOf = (userId: string) => {
        if (!names.has(userId)) {
          const a = deps.accounts.byIds([userId]).get(userId)
          names.set(userId, a?.name?.trim() || a?.email?.split('@')[0] || 'メンバー')
        }
        return names.get(userId)!
      }

      /** The folders above a path (what decides who reads it), as a cache key. */
      const placeOf = (path: string): string => {
        const normalized = normalizeScopePath(path) ?? path
        return scopes.filter(s => isSameOrAncestorPath(s.path, normalized) || isSameOrAncestorPath(s.path, path)).map(s => s.id).sort().join(',')
      }
      const departmentOf = (path: string) => {
        const top = pathKey(path.split('/').find(p => p !== '') ?? '')
        const d = top ? departments.find(x => x.key === top) : undefined
        if (!d) return null
        if (!departmentMembers.has(d.id)) departmentMembers.set(d.id, handle.tasks.departmentMemberIds(d.id))
        return { name: d.name, memberIds: departmentMembers.get(d.id)! }
      }
      const cache = new Map<string, ViewersLabel>()
      const label = (key: string, path: string, privateFolder: ScopeWithRules | null, canRead: (r: RecordReader) => boolean): ViewersLabel => {
        const known = cache.get(key)
        if (known) return known
        const value = viewersLabel({
          viewerId: member.userId,
          readers: readers.filter(r => canRead(r.reader)).map(r => r.userId),
          ownerOnly: false,
          companyMembers: members.length,
          privateFolder: privateFolder?.path ?? null,
          department: departmentOf(path),
          fullAccess,
          nameOf,
        })
        cache.set(key, value)
        return value
      }

      const bundleTypes = new Set([...currentTypes(handle.records).values()].filter(t => t.definition.implements.includes('bundle')).map(t => t.definition.name))
      const out: ViewersAnswer = { records: {}, files: {} }
      for (const row of handle.records.byIds(recordIds)) {
        if (!callerOverAll.record(row)) continue
        if (row.personalOwner !== null) {
          out.records[row.id] = viewersLabel({
            viewerId: member.userId, readers: [member.userId], ownerOnly: true, companyMembers: members.length,
            privateFolder: null, department: null, fullAccess, nameOf,
          })
          continue
        }
        // Members-only (records.md "Members-only records"): its own list decides, never the place —
        // before the per-place cache, which would hand one record's readers to another.
        if (row.members !== null) {
          out.records[row.id] = viewersLabel({
            viewerId: member.userId, readers: readers.filter(r => r.reader.record(row)).map(r => r.userId), ownerOnly: false,
            companyMembers: members.length, privateFolder: null, department: null, fullAccess, nameOf,
          })
          continue
        }
        const path = row.path ?? row.folder ?? ''
        const key = `record|${row.path === null ? 'server' : 'file'}|${row.scopeId ?? ''}|${placeOf(path)}`
        const priv = row.scopeId !== null ? scopes.find(s => s.id === row.scopeId) ?? null : findPrivateScope(scopes, path)
        // A 非公開 案件・プロジェクト in its own private folder: 「『<title>』の参加者（N人）」 (records.md "Private
        // 案件・プロジェクト"), outside the per-place cache (its tasks there keep the folder's phrase).
        if (priv && row.path === null && row.folder !== null && pathKey(priv.path) === pathKey(row.folder) && bundleTypes.has(row.type)) {
          out.records[row.id] = viewersLabel({
            viewerId: member.userId, readers: readers.filter(r => r.reader.record(row)).map(r => r.userId), ownerOnly: false,
            companyMembers: members.length, privateFolder: priv.path, privateProject: row.title, department: null, fullAccess, nameOf,
          })
          continue
        }
        out.records[row.id] = label(key, path, priv, r => r.record(row))
      }
      for (const path of files) {
        if (!caller.file(path)) continue
        out.files[path] = label(`file|${placeOf(path)}`, path, findPrivateScope(scopes, path), r => r.file(path))
      }
      // 「〇人はこのファイルを開けません」: who reads the record but not a path linked to it — a number only,
      // for a record the caller reads and paths the caller reads (anything else is left out).
      if (linked) {
        const row = handle.records.byIds([linked.record])[0]
        if (row && callerOverAll.record(row)) {
          const recordReaders = row.personalOwner !== null ? [] : readers.filter(r => r.reader.record(row))
          const cannotOpen: Record<string, number> = {}
          for (const path of linked.paths) {
            if (!caller.file(path)) continue
            const n = recordReaders.filter(r => !r.reader.file(path)).length
            if (n > 0) cannotOpen[path] = n
          }
          out.cannotOpen = cannotOpen
        }
      }
      return ok(out)
    },
  }
}

export type ViewersService = ReturnType<typeof createViewersService>
