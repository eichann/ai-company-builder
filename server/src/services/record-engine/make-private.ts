/**
 * 「非公開にする」 (records.md "Making a 案件・プロジェクト private", owner FB #35 2026-11-13): an existing,
 * public 案件・プロジェクト moves into **its own new private folder** — the same place a 非公開 one gets when
 * it is made (create.ts `ownPrivate`), with today's private-folder rights and no new permission.
 *
 * Only the record's place changes (`records.folder`, as 「部署に出す」 does); no file of the company folder
 * moves. Its やること follow "A task and its 案件・プロジェクト": those now seen by more people than the
 * 案件 are narrowed to its folder in the same transaction; one the person cannot narrow (one they do
 * not read, a members-only one whose list is wider) stops the whole move — nothing is left seen by
 * people who can no longer see the 案件. Never the reverse here, never undone (`place.*` changes).
 */
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import { FULL_ACCESS_ROLES, findPrivateScope, type ScopeWithRules } from '../../../shared/core/permissions'
import { normalizeRepoPath, pathKey } from '../../../shared/core/paths'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordAccessRow, RecordRepository, RecordRow } from '../../ports/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { listedUserIds, type RecordReader } from '../record-access'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import { BUNDLE_PLACED_TYPES, bundleLinkName, placeWithin } from './bundle-place'
import type { EngineContext } from './context'
import { bad, conflict, featureOffRefusal, FOLDER_NOT_PLACEABLE } from './refusals'
import type { ActorInput } from './types'
import { NOTE_MAX, provenance } from './values'

/** The ledger action of moving a まとまり (and its やること) into its own private folder. */
export const MAKE_PRIVATE_ACTION = 'make_private'

/** The planned private folder's stand-in (never a real path: a NUL cannot be in one). */
const PLANNED = '\u0000planned'

const STALE = 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください'

export const MAKE_PRIVATE_REFUSALS = {
  notBundle: { error: '非公開にできるのは、案件・プロジェクトだけです', code: 'NOT_A_BUNDLE' },
  notForType: { error: 'この種類の案件は、あとから非公開にはできません', code: 'MAKE_PRIVATE_NOT_FOR_TYPE' },
  notPublic: { error: 'この案件・プロジェクトは、もう見られる人がしぼられています', code: 'NOT_PUBLIC' },
  notAllowed: { error: 'あとから非公開にできるのは、この部署の管理役か管理者だけです', code: 'MAKE_PRIVATE_NOT_ALLOWED' },
  // Names no task, count or place: the person may not read some of them.
  linkedNotMovable: {
    error: 'つながっているやることの中に、あなたからは見える範囲を変えられないものがあるため、非公開にできません。管理者に相談してください',
    code: 'LINKED_NOT_MOVABLE',
  },
  namedCannotRead: {
    error: 'この案件・プロジェクトやそのやることにかかわる人（責任者・担当・頼んだ人など）が、参加者に入っていません。参加者に足してから、もう一度お試しください',
    code: 'NAMED_PERSON_CANNOT_READ',
  },
} as const

/** What 「非公開にする」 would do, for the window that asks first. */
export interface MakePrivatePlan {
  /** The folder the private folder is made in: the 案件's department ('' = the company root). */
  parent: string
  /** The linked やること the member reads that will be seen by the participants only (owner-only ones stay as they are). */
  tasks: number
  /** Members the 案件 and those やること name (責任者・担当・頼んだ人… and members-only lists), owners / admins aside: made participants. */
  people: string[]
  /** Some linked やること cannot be narrowed by this member: the move would be refused (`LINKED_NOT_MOVABLE`). */
  blocked: boolean
}

/** The department folder holding a place (its first segment; null = the whole company). */
const departmentOf = (folder: string | null): string | null => (folder === null ? null : folder.split('/')[0])

export function makingPrivate(ctx: EngineContext) {
  const { deps, companyData, transactions, clock, open, canRead, placeFolder, stateOf, summaryOf, changed } = ctx

  /** The まとまり as this member may make it private, with its linked やること; else the refusal. */
  function load(member: Member, recordId: string): Outcome<never> | {
    records: RecordRepository; reader: RecordReader; row: RecordRow; parent: string; tasks: RecordRow[]
  } {
    const opened = open(member)
    if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
    const { records, reader } = opened
    const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => r.removedAt === null && reader.record(r)) : undefined
    if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
    const off = featureOffRefusal(deps.featureOff, member.companyId, row.type)
    if (off) return off
    const types = currentTypes(records)
    const def = types.get(row.type)?.definition
    if (!def || !def.implements.includes('bundle')) return bad(MAKE_PRIVATE_REFUSALS.notBundle.error, MAKE_PRIVATE_REFUSALS.notBundle.code)
    // A business plugin's type (a deal): other records copy its place when they are made (approvals,
    // sent mail) and would not follow — only the company's own kinds for now.
    if (records.typeVersions().some(t => t.name === row.type && t.source === 'plugin')) {
      return bad(MAKE_PRIVATE_REFUSALS.notForType.error, MAKE_PRIVATE_REFUSALS.notForType.code)
    }
    const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
    if (row.path !== null || row.personalOwner !== null || row.members !== null || (row.folder !== null && findPrivateScope(scopes, row.folder))) {
      return conflict(MAKE_PRIVATE_REFUSALS.notPublic.error, MAKE_PRIVATE_REFUSALS.notPublic.code)
    }
    // Exactly who may make a 非公開 one in its department today: owners / admins, that department's
    // managers (a company-wide one: owners / admins only — no department holds it).
    const dept = departmentOf(row.folder)
    const may = FULL_ACCESS_ROLES.has(member.role)
      || (dept !== null && deps.managedFolders(member.companyId, member.userId).some(d => pathKey(d) === pathKey(dept)))
    if (!may) return refuse('forbidden', MAKE_PRIVATE_REFUSALS.notAllowed.error, { code: MAKE_PRIVATE_REFUSALS.notAllowed.code })
    // Its やること: live records of the placed types whose まとまり link names it.
    const sources = records.linksTo([row.id]).filter(l => l.targetId === row.id)
    const candidates = records.byIds([...new Set(sources.map(l => l.sourceId))])
    const tasks = candidates.filter(t => {
      if (t.removedAt !== null || !BUNDLE_PLACED_TYPES.includes(t.type)) return false
      const tdef = types.get(t.type)?.definition
      const name = tdef ? bundleLinkName(tdef) : null
      return name !== null && sources.some(l => l.sourceId === t.id && l.name === name)
    })
    return { records, reader, row, parent: dept ?? '', tasks }
  }

  /** The person fields' values of a record (責任者・担当・頼んだ人・確かめる人…). */
  function namedPeople(records: RecordRepository, row: RecordRow): string[] {
    const def = currentTypes(records).get(row.type)?.definition
    if (!def) return []
    const fields = stateOf(records, row, def).fields
    return Object.entries(fields).flatMap(([f, v]) => (def.fields[f]?.kind === 'person' && typeof v === 'string' && v !== '' ? [v] : []))
  }

  /**
   * May this member change this やること's place to the まとまり's folder (else the whole move stops)? Only a
   * true narrowing: the member reads it, it is placed by a folder (a members-only list is never turned into a
   * folder), and everyone who will read it there already reads it (`within`: no participant gains a やること
   * they could not see before — one in another private folder, say).
   */
  const narrowable = (reader: RecordReader, t: RecordRow, within: (t: RecordRow) => boolean) =>
    t.path === null && t.members === null && reader.record(t) && within(t)

  return {
    /**
     * `GET /records/item/:recordId/make-private`: whether the member may make it private, and what
     * that would do — the department the private folder is made in, how many of its やること (that the
     * member reads) will be seen by the participants only, who they name (to make them participants),
     * and whether some linked やること would stop it. Refused like the move itself (not a まとまり, not
     * public, not allowed) so the app offers 「非公開にする」 only where it would be taken.
     */
    makePrivatePlan(member: Member, recordId: string): Outcome<MakePrivatePlan> {
      const found = load(member, recordId)
      if (!('row' in found)) return found
      const { records, reader, row, parent, tasks } = found
      const people = new Set(namedPeople(records, row))
      let count = 0
      const shown: RecordRow[] = []
      for (const t of tasks) {
        if (t.personalOwner !== null || !reader.record(t)) continue
        shown.push(t)
        count++
        for (const u of [...namedPeople(records, t), ...listedUserIds(t)]) people.add(u)
      }
      const named = [...people].filter(u => { const role = deps.roleOf(member.companyId, u); return role !== null && !FULL_ACCESS_ROLES.has(role) })
      // The participants it will have (the member, the department's managers, those named), as a
      // planned private folder: the move's own checks run against it, so the window refuses up
      // front exactly what the move would (a やること already narrower than that is left alone).
      const handle = companyData.forCompany(member.companyId)
      const deptId = parent === '' ? null : handle.departments.folders().find(d => pathKey(d.folder) === pathKey(parent))?.id ?? null
      const participants = [...new Set([member.userId, ...named, ...(deptId ? handle.scopes.departmentManagerIds(deptId) : [])])]
      const plannedPath = parent === '' ? PLANNED : `${parent}/${PLANNED}`
      const scopes: ScopeWithRules[] = [...handle.scopes.listWithRules(), {
        id: PLANNED, path: plannedPath, kind: 'folder', departmentId: null, repoId: PLANNED,
        rules: [
          { id: `${PLANNED}e`, subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false },
          ...participants.map(u => ({ id: `${PLANNED}${u}`, subjectType: 'user' as const, subjectId: u, canRead: true, canWrite: true })),
        ],
      }]
      const planned: RecordAccessRow = { ...row, scopeId: null, path: null, folder: plannedPath, personalOwner: null, members: null, memberSets: [] }
      const roleOf = (id: string) => deps.roleOf(member.companyId, id)
      const within = (t: RecordRow) => placeWithin(member.companyId, scopes, roleOf, planned, t)
      const blocked = tasks.some(t => !placeWithin(member.companyId, scopes, roleOf, t, planned) && !narrowable(reader, t, within))
      return ok({ parent, tasks: count, people: named.sort(), blocked })
    },

    /**
     * `POST /records/item/:recordId/make-private { folder, expectedVersion, note? }` (session only, a
     * person): the public まとまり moves into `folder` — a private folder directly inside its department
     * (the company root for a company-wide one), that the member reads and in which no record is yet
     * (the app has just made it, as 「新しい〇〇にする」 does). Any other folder → the one answer
     * `FOLDER_NOT_PLACEABLE`, so a private folder's name is never confirmed. Each linked やること now
     * seen by more people than the まとまり takes its folder in the same transaction (a ledger entry
     * each); one the member cannot narrow → 409 `LINKED_NOT_MOVABLE`, nothing written. Everyone the
     * まとまり or a narrowed やること names must read the folder (400 `NAMED_PERSON_CANNOT_READ`).
     * Ledger action `make_private` with `place.folder` before / after; never undone.
     */
    makePrivate(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry; narrowed: number }> {
      if (actor.kind !== 'human') return refuse('forbidden', 'この操作は本人が画面から行ってください', { code: 'NOT_ALLOWED' })
      const found = load(member, recordId)
      if (!('row' in found)) return found
      const { records, reader, row, parent, tasks } = found
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)
      const expected = b.expectedVersion as number

      // The folder: exactly a private folder, directly inside the department, read by the member, empty.
      const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
      const raw = typeof b.folder === 'string' ? normalizeRepoPath(b.folder) : null
      const notPlaceable = bad(FOLDER_NOT_PLACEABLE.error, FOLDER_NOT_PLACEABLE.code)
      if (!raw) return notPlaceable
      const slash = raw.lastIndexOf('/')
      const parentOfRaw = slash < 0 ? '' : raw.slice(0, slash)
      const ownFolder = (f: string) => pathKey(parentOfRaw) === pathKey(parent)
        && scopes.some(s => s.repoId !== null && pathKey(s.path) === pathKey(f))
      const folder = placeFolder(member, row.type, raw, reader, ownFolder)
      if (typeof folder !== 'string') return folder
      if (!ownFolder(folder)) return notPlaceable
      if (records.placedIn(folder).some(id => id !== row.id)) return notPlaceable

      const place = (r: RecordRow): RecordAccessRow => ({ ...r, scopeId: null, path: null, folder, personalOwner: null, members: null, memberSets: [] })
      const newPlace = place(row)
      const roleOf = (id: string) => deps.roleOf(member.companyId, id)
      // Its やること that would be seen by more people than the まとまり there.
      const wider = tasks.filter(t => !placeWithin(member.companyId, scopes, roleOf, t, newPlace))
      const within = (t: RecordRow) => placeWithin(member.companyId, scopes, roleOf, newPlace, t)
      if (wider.some(t => !narrowable(reader, t, within))) {
        return conflict(MAKE_PRIVATE_REFUSALS.linkedNotMovable.error, MAKE_PRIVATE_REFUSALS.linkedNotMovable.code)
      }
      const named = [...namedPeople(records, row), ...wider.flatMap(t => namedPeople(records, t))]
      if (named.some(u => deps.roleOf(member.companyId, u) !== null && !canRead(member.companyId, u, newPlace))) {
        return bad(MAKE_PRIVATE_REFUSALS.namedCannotRead.error, MAKE_PRIVATE_REFUSALS.namedCannotRead.code)
      }
      const def = currentTypes(records).get(row.type)!.definition
      const current = stateOf(records, row, def)
      if (expected !== current.version) return conflict(STALE, 'VERSION_CONFLICT', { version: current.version })

      const at = clock.now()
      const entryOf = (r: RecordRow, version: number, state: string | null, typeVersion: number | null): LedgerEntry => ({
        recordId: r.id, version, action: MAKE_PRIVATE_ACTION, fromState: state, toState: state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note: r.id === row.id ? note : '',
        changes: [{ field: 'place.folder', before: r.folder, after: folder }],
        attachments: [], decision: null, isDecision: false, typeVersion, reversesVersion: null, ...provenance(actor),
      })
      const entry = entryOf(row, current.version + 1, current.state, row.typeVersion)
      const STOP = new Error('stale')
      try {
        transactions.run(() => {
          if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) throw STOP
          records.setPlace(row.id, { folder, personalOwner: null }, at)
          records.appendLedger(entry)
          for (const t of wider) {
            const tdef = currentTypes(records).get(t.type)?.definition
            if (!tdef) throw STOP
            const s = stateOf(records, t, tdef)
            const e = entryOf(t, s.version + 1, s.state, t.typeVersion)
            if (!records.writeState({ recordId: t.id, state: s.state, fields: JSON.stringify(s.fields), version: e.version, updatedAt: at }, s.version)) throw STOP
            records.setPlace(t.id, { folder, personalOwner: null }, at)
            records.appendLedger(e)
          }
        })
      } catch (err) {
        if (err === STOP) return conflict(STALE, 'VERSION_CONFLICT')
        throw err
      }
      changed(member.companyId, row.id)
      for (const t of wider) changed(member.companyId, t.id)
      return ok({ record: summaryOf(records, row.id), entry, narrowed: wider.length })
    },
  }
}
