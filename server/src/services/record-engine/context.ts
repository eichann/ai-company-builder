/**
 * What every operation of the member-facing engine shares: the company's
 * records (when the feature is on) with the member's reader, where a record's
 * file is, who can read a place, the current state, the history line and the
 * push-channel notice.
 */
import { findPrivateScope } from '../../../shared/core/permissions'
import { normalizeRepoPath } from '../../../shared/core/paths'
import type { TypeDefinition } from '../../../shared/core/record-types'
import type { LedgerValue } from '../../../shared/core/record-ledger'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordFileRepo } from '../../ports/record-files'
import type { RecordAccessRow, RecordRepository, RecordRow } from '../../ports/records'
import { logError } from '../../lib/error-log'
import type { Member } from '../access'
import { refuse, type Outcome } from '../outcome'
import { recordReader, type RecordReader } from '../record-access'
import { recordSummaries } from '../records'
import { bad } from './refusals'
import type { ActorInput, RecordChange, RecordEngineDeps } from './types'

export function engineContext(deps: RecordEngineDeps) {
  const { companyData, transactions, clock } = deps

  function open(member: Member): { records: RecordRepository; reader: RecordReader } | null {
    const handle = companyData.forCompany(member.companyId)
    if (!handle.records.settings().enabled) return null
    return { records: handle.records, reader: recordReader(member, handle.scopes.listWithRules()) }
  }

  /** The repository and repository-relative path of a record's file. */
  function fileOf(member: Member, row: RecordRow): { repo: RecordFileRepo; path: string } | null {
    if (row.path === null) return null
    const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
    const priv = findPrivateScope(scopes, row.path)
    if (priv && priv.repoId) return { repo: { kind: 'scope', repoId: priv.repoId }, path: row.path.slice(priv.path.length + 1) }
    return { repo: { kind: 'company' }, path: row.path }
  }

  /**
   * May `userId` read a record at this place (their own read access: private
   * folder, scope rules)? An assignee who cannot would be handed work they
   * cannot see.
   */
  function canRead(companyId: string, userId: string, place: RecordAccessRow): boolean {
    const role = deps.roleOf(companyId, userId)
    if (role === null) return false
    return recordReader({ companyId, userId, role }, companyData.forCompany(companyId).scopes.listWithRules()).record(place)
  }

  /**
   * A folder a server-only record may be placed in (its readers' place): a
   * company path outside every private folder that the member reads.
   */
  function placeFolder(member: Member, type: string, raw: unknown, reader: RecordReader): string | Outcome<never> {
    const f = typeof raw === 'string' ? normalizeRepoPath(raw) : null
    if (!f) return bad('folder must be a company path')
    const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
    // Server-only records outside private folders for now (their links and reads assume a public place).
    if (findPrivateScope(scopes, f)) return bad('A server-only record cannot be placed in a private folder yet', 'PRIVATE_PLACE')
    if (!reader.record({ id: '', type, scopeId: null, path: null, folder: f, personalOwner: null })) return refuse('forbidden', 'You cannot read that folder')
    return f
  }

  function stateOf(records: RecordRepository, row: RecordRow, def: TypeDefinition) {
    const s = records.states([row.id])[0]
    let fields: Record<string, LedgerValue> = {}
    try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
    return { version: s?.version ?? 0, state: s ? s.state : def.initial, fields }
  }

  function historyLine(member: Member, row: RecordRow, label: string, actor: ActorInput, note: string, at: string) {
    const file = fileOf(member, row)
    if (!file) return
    // Facts by the machine, a few words by a person: no names in files (13.10) — the member's id.
    const line = `${at.slice(0, 10)} ${label}（${member.userId}${actor.kind === 'ai' ? '・AI 経由' : ''}）${note ? `：${note.slice(0, 200)}` : ''}`
    deps.files.appendHistoryLine(member.companyId, file.repo, file.path, line)
      .catch(err => logError('records', 'Writing the history line failed', err, { company: member.companyId }))
  }

  function tell(member: Member, userIds: Array<LedgerValue | undefined>, change: RecordChange) {
    const to = [...new Set(userIds.filter((u): u is string => typeof u === 'string' && u !== member.userId))]
    if (to.length > 0) {
      try { deps.notify(member.companyId, to, change) } catch { /* the 60 s check catches up */ }
    }
  }

  const summaryOf = (records: RecordRepository, id: string) => recordSummaries(records, records.byIds([id])).get(id) as RecordSummary

  return { deps, companyData, transactions, clock, open, fileOf, canRead, placeFolder, stateOf, historyLine, tell, summaryOf }
}

export type EngineContext = ReturnType<typeof engineContext>
