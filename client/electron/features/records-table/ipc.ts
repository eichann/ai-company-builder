// 「記録の一覧」 (tasks-ui.md "The records table (B4)"): one page of one kind's records, read with
// the member's session through the existing `POST /records/query`. The server answers only what
// the member may read (owner-only, members-only and private-folder records are simply absent);
// this file adds no filter of its own and keeps nothing (no cache, nothing on disk).
//   recordsTable:page   (companyId, { kind, openOnly, offset }) → RecordsTablePage
// Built to be removed easily with `src/features/records-table/` (the rule lists every line).
import { ONTOLOGY_NAME_RE, type TypeDefinition } from '../../../../shared/core/record-types'
import type { RecordQueryResult, RecordTypeView } from '../../../../shared/types/records'
import { RECORD_VIEWS_OFFLINE_TEXT } from '../../../shared/record-views'
import { columnsOf, kindsOf, OPEN_ONLY_TOO_MANY_STATES, openStatesOf, RECORDS_TABLE_MAX_OFFSET, RECORDS_TABLE_PAGE, rowOf, type RecordsTablePage, type RecordsTableQuery } from '../../../shared/records-table'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface RecordsTableDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const BAD_INPUT = { success: false as const, offline: false, error: '入力が正しくありません。' }

type Answer = { status: number; json: { data?: unknown; code?: unknown } | null } | null

export function createRecordsTableApi(deps: RecordsTableDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Answer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: await res.json().catch(() => null) as NonNullable<Answer>['json'] }
    } catch {
      log.warn('[records-table] the server could not be reached')
      return null
    }
  }

  /** Member id → name for person columns; empty when unreachable (a cell then reads 「メンバー」). */
  async function people(companyId: string): Promise<Record<string, string>> {
    const a = await call(`/companies/${encodeURIComponent(companyId)}/members`, 'GET')
    const out: Record<string, string> = {}
    const list = a?.status === 200 && Array.isArray(a.json?.data) ? a.json.data as Array<{ userId?: unknown; id?: unknown; name?: unknown }> : []
    for (const m of list) {
      const id = typeof m.userId === 'string' ? m.userId : typeof m.id === 'string' ? m.id : null
      if (id && typeof m.name === 'string' && m.name) out[id] = m.name
    }
    return out
  }

  const failure = (a: Answer): RecordsTablePage => {
    const offline = a === null || a.status >= 500
    return { success: false, offline, error: offline ? RECORD_VIEWS_OFFLINE_TEXT : '表示できませんでした。' }
  }
  const disabled = (a: Answer) => a?.status === 404 && a.json?.code === 'RECORDS_DISABLED'
  const off = (kind: string): RecordsTablePage => ({ success: true, available: false, kinds: [], kind, columns: [], total: 0, offset: 0, rows: [] })

  async function page(companyId: string, query: RecordsTableQuery): Promise<RecordsTablePage> {
    const company = `/companies/${encodeURIComponent(companyId)}`
    const types = await call(`${company}/records/types`, 'GET')
    if (disabled(types)) return off(query.kind)
    if (types?.status !== 200) return failure(types)
    const defs = ((types.json?.data as { types?: RecordTypeView[] } | undefined)?.types ?? []).map(t => t.definition)
    const kinds = kindsOf(defs)
    // A kind gone since the member chose it (a plugin turned off): the first one there is.
    const def: TypeDefinition | undefined = defs.find(d => d.name === query.kind) ?? defs.find(d => d.name === kinds[0]?.name)
    if (!def) return { success: true, available: true, kinds, kind: query.kind, columns: [], total: 0, offset: 0, rows: [] }
    const open = query.openOnly ? openStatesOf(def) : { all: true as const }
    const columns = columnsOf(def)
    // Every state of the kind is final: no record is open, nothing to ask.
    if ('none' in open) return { success: true, available: true, kinds, kind: def.name, columns, total: 0, offset: query.offset, rows: [] }
    const [a, names] = await Promise.all([
      call(`${company}/records/query`, 'POST', { type: def.name, ...('states' in open ? { state: open.states } : {}), limit: RECORDS_TABLE_PAGE, offset: query.offset }),
      people(companyId),
    ])
    if (disabled(a)) return off(def.name)
    if (a?.status !== 200) return failure(a)
    const result = a.json?.data as RecordQueryResult
    return {
      success: true, available: true, kinds, kind: def.name, columns, total: result.total, offset: query.offset,
      rows: result.records.map(r => rowOf(r, def, columns, names)),
      ...('tooMany' in open ? { notice: OPEN_ONLY_TOO_MANY_STATES } : {}),
    }
  }

  return {
    page(companyId: unknown, query: unknown): Promise<RecordsTablePage> | RecordsTablePage {
      const q = query as Partial<RecordsTableQuery> | null
      if (typeof companyId !== 'string' || !COMPANY.test(companyId) || !q || typeof q !== 'object') return BAD_INPUT
      if (typeof q.kind !== 'string' || !ONTOLOGY_NAME_RE.test(q.kind) || typeof q.openOnly !== 'boolean') return BAD_INPUT
      if (typeof q.offset !== 'number' || !Number.isInteger(q.offset) || q.offset < 0 || q.offset > RECORDS_TABLE_MAX_OFFSET) return BAD_INPUT
      return page(companyId, { kind: q.kind, openOnly: q.openOnly, offset: q.offset })
    },
  }
}

export function registerRecordsTableIpc(ipc: IpcRegistrar, deps: RecordsTableDeps): void {
  const api = createRecordsTableApi(deps)
  ipc.handle('recordsTable:page', (_event, companyId, query) => api.page(companyId, query))
}
