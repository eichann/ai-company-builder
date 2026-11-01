// What the app shows of records (milestone 5 U8, records.md "The app's views"), read with
// the member's session (it stays here):
//   recordViews:search   検索: records whose title or summary holds the words
//   recordViews:card     the read-only card a record opens in (fields, 経緯, つながっているもの)
//   recordViews:forFile  「つながっているもの」 of an open file
// The server answers only what the member may read (counts included); nothing is added here.

import type { TypeDefinition } from '../../../../shared/core/record-types'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import { fileLinkPath, RECORD_ID_RE } from '../../../../shared/core/records'
import type { RecordDetail, RecordQueryResult, RecordTypeView } from '../../../../shared/types/records'
import {
  cardFields, historyLines, RECORD_VIEWS_OFFLINE_TEXT, summaryView,
  type RecordCardLink, type RecordCardResult, type RecordListResult,
} from '../../../shared/record-views'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface RecordViewsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const BAD_INPUT = { success: false as const, offline: false, error: '入力が正しくありません。' }

type Answer = { status: number; json: { data?: unknown; error?: unknown; code?: unknown } | null } | null

export function createRecordViewsApi(deps: RecordViewsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: await res.json().catch(() => null) as NonNullable<Answer>['json'] }
    } catch {
      log.warn(`[record-views] ${path.split('/').slice(0, 3).join('/')}: the server could not be reached`)
      return null
    }
  }

  const disabled = (a: NonNullable<Answer>) => a.status === 404 && a.json?.code === 'RECORDS_DISABLED'
  const failure = (a: Answer) => ({
    success: false as const, offline: a === null || a.status >= 500,
    error: a === null || a.status >= 500 ? RECORD_VIEWS_OFFLINE_TEXT : '表示できませんでした。',
  })

  async function types(companyId: string): Promise<Map<string, TypeDefinition>> {
    const a = await call(companyId, 'GET', '/records/types')
    const list = a?.status === 200 ? (a.json?.data as { types?: RecordTypeView[] } | undefined)?.types ?? [] : []
    return new Map(list.map(t => [t.definition.name, t.definition]))
  }

  async function list(companyId: string, query: Record<string, unknown>): Promise<RecordListResult> {
    const [a, defs] = await Promise.all([call(companyId, 'POST', '/records/query', { ...query, limit: 100 }), types(companyId)])
    if (a && disabled(a)) return { success: true, available: false, total: 0, records: [] }
    if (a?.status !== 200) return failure(a)
    const result = a.json?.data as RecordQueryResult
    return { success: true, available: true, total: result.total, records: result.records.map(r => summaryView(r, defs.get(r.type))) }
  }

  return {
    search(companyId: string, text: string): Promise<RecordListResult> | RecordListResult {
      const t = typeof text === 'string' ? text.normalize('NFC').trim() : ''
      if (!COMPANY.test(companyId) || t.length === 0 || t.length > 100) return BAD_INPUT
      return list(companyId, { text: t })
    },

    forFile(companyId: string, companyPath: string): Promise<RecordListResult> | RecordListResult {
      const p = typeof companyPath === 'string' ? fileLinkPath(companyPath) : null
      if (!COMPANY.test(companyId) || !p) return BAD_INPUT
      return list(companyId, { linkedToFile: p })
    },

    async card(companyId: string, recordId: string): Promise<RecordCardResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      const id = encodeURIComponent(recordId)
      const [item, history, defs, members] = await Promise.all([
        call(companyId, 'GET', `/records/item/${id}`),
        call(companyId, 'GET', `/records/item/${id}/history`),
        types(companyId),
        memberNames(companyId),
      ])
      if (item?.status === 404) return { success: false, offline: false, notFound: true, error: '見つかりません。消されたか、見られないものです。' }
      if (item?.status !== 200) return failure(item)
      const detail = item.json?.data as RecordDetail
      const def = defs.get(detail.record.type)
      const entries = history?.status === 200 ? (history.json?.data as { entries?: LedgerEntry[] } | undefined)?.entries ?? [] : []
      const links: RecordCardLink[] = detail.links.map(l => {
        const label = l.direction === 'out'
          ? def?.links[l.name]?.label ?? l.name
          : (l.record ? defs.get(l.record.type)?.label : undefined) ?? l.name
        return l.record
          ? { label, record: summaryView(l.record, defs.get(l.record.type)) }
          : { label, path: l.path, ...(l.broken !== undefined ? { broken: l.broken } : {}) }
      })
      return {
        success: true,
        card: {
          record: summaryView(detail.record, def),
          fields: cardFields(detail.record, def, members),
          history: historyLines(entries, def, members),
          links,
        },
      }
    },
  }

  /** Member ids → names (any member may list the company's members); empty when unreachable. */
  async function memberNames(companyId: string): Promise<Record<string, string>> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return {}
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/members`, {
        redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000), headers: { Cookie: cookies.join('; ') },
      })
      const json = await res.json().catch(() => null) as { data?: Array<{ userId?: unknown; id?: unknown; name?: unknown; email?: unknown }> } | null
      const out: Record<string, string> = {}
      for (const m of json?.data ?? []) {
        const id = typeof m.userId === 'string' ? m.userId : typeof m.id === 'string' ? m.id : null
        const name = typeof m.name === 'string' && m.name ? m.name : null
        if (id && name) out[id] = name
      }
      return out
    } catch {
      return {}
    }
  }
}

export function registerRecordViewsIpc(ipc: IpcRegistrar, deps: RecordViewsDeps): void {
  const api = createRecordViewsApi(deps)
  ipc.handle('recordViews:search', (_event, companyId, text) => api.search(companyId, text))
  ipc.handle('recordViews:card', (_event, companyId, recordId) => api.card(companyId, recordId))
  ipc.handle('recordViews:forFile', (_event, companyId, companyPath) => api.forFile(companyId, companyPath))
}
