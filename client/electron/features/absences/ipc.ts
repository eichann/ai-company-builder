// Settings → 「不在と代わりの人」 (stage 2 S4, records.md "Absence and the delegate"):
// the member's own absences, read and changed with the member's **session**.
//   absences:get      the member's view (absences, whom they cover today) + the members for the picker
//   absences:add      a new absence of the member { from, until, delegateId }
//   absences:remove   remove one of them

import { ABSENCES_OFFLINE_TEXT, type AbsenceAddInput, type AbsenceAddResult, type AbsenceFailure, type AbsenceMember, type AbsenceRemoveResult, type AbsencesResult } from '../../../shared/absences'
import { isAbsenceDate } from '../../../../shared/core/absences'
import type { AbsenceCreated, MemberAbsencesView } from '../../../../shared/types/absences'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface AbsencesDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

/** Ids that go into the server URL: no separators, dots or encoded characters. */
const ID = /^[A-Za-z0-9_-]{1,100}$/
const BAD_INPUT: AbsenceFailure = { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
const OFFLINE: AbsenceFailure = { success: false, offline: true, code: null, error: ABSENCES_OFFLINE_TEXT }

type Answer = { status: number; json: Record<string, unknown> | null }

export function createAbsencesApi(deps: AbsencesDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(companyId: string, path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
    } catch {
      return null
    }
  }

  function failure(what: string, r: Answer | null): AbsenceFailure {
    if (!r) {
      log.warn(`[absences] ${what}: the server could not be reached`)
      return OFFLINE
    }
    const code = typeof r.json?.code === 'string' ? r.json.code : null
    log.warn(`[absences] ${what}: answered ${r.status}${code ? ` ${code}` : ''}`)
    return {
      success: false, offline: r.status >= 500, code,
      error: typeof r.json?.error === 'string' && r.status < 500 ? r.json.error : `サーバーでエラーが起きました（HTTP ${r.status}）。`,
    }
  }

  const ok = (r: Answer | null): r is Answer => !!r && r.status >= 200 && r.status < 300 && !!r.json?.data && typeof r.json.data === 'object'

  /** The company's members by display name (never an id on screen). */
  async function members(companyId: string): Promise<AbsenceMember[]> {
    const r = await call(companyId, '/members', 'GET')
    const list = r && r.status === 200 && Array.isArray(r.json?.data) ? r.json.data as Array<{ userId?: unknown; name?: unknown; email?: unknown }> : []
    const out: AbsenceMember[] = []
    for (const m of list) {
      if (typeof m.userId !== 'string') continue
      const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : typeof m.email === 'string' ? m.email.split('@')[0] : ''
      if (name) out.push({ userId: m.userId, name })
    }
    return out
  }

  return {
    async get(companyId: unknown): Promise<AbsencesResult> {
      if (typeof companyId !== 'string' || !ID.test(companyId)) return BAD_INPUT
      const [r, list] = await Promise.all([call(companyId, '/absences', 'GET'), members(companyId)])
      if (!ok(r)) return failure('get', r)
      return { success: true, view: r.json!.data as MemberAbsencesView, members: list }
    },
    async add(companyId: unknown, input: unknown): Promise<AbsenceAddResult> {
      if (typeof companyId !== 'string' || !ID.test(companyId) || !input || typeof input !== 'object') return BAD_INPUT
      const { from, until, delegateId } = input as Partial<AbsenceAddInput>
      if (!isAbsenceDate(from) || !isAbsenceDate(until) || from > until || typeof delegateId !== 'string' || !ID.test(delegateId)) return BAD_INPUT
      const r = await call(companyId, '/absences', 'POST', { from, until, delegateId })
      if (!ok(r)) return failure('add', r)
      return { success: true, created: r.json!.data as AbsenceCreated }
    },
    async remove(companyId: unknown, absenceId: unknown): Promise<AbsenceRemoveResult> {
      if (typeof companyId !== 'string' || !ID.test(companyId) || typeof absenceId !== 'string' || !ID.test(absenceId)) return BAD_INPUT
      const r = await call(companyId, `/absences/${absenceId}`, 'DELETE')
      if (!ok(r)) return failure('remove', r)
      return { success: true }
    },
  }
}

export function registerAbsencesIpc(ipc: IpcRegistrar, deps: AbsencesDeps) {
  const api = createAbsencesApi(deps)
  ipc.handle('absences:get', (_event, companyId) => api.get(companyId))
  ipc.handle('absences:add', (_event, companyId, input) => api.add(companyId, input))
  ipc.handle('absences:remove', (_event, companyId, absenceId) => api.remove(companyId, absenceId))
}
