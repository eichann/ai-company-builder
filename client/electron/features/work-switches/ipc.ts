// 自分の設定 → 「受信を読む」「AI が自動で進める」 (shared/core/work-switches.ts): the member's own
// two switches, read and changed with the member's **session**.
//   workSwitches:get   the member's switches (+ the company's 使ってよいか / 初めの値)
//   workSwitches:set   turn one of them on / off { switch, on }

import { isWorkSwitch } from '../../../../shared/core/work-switches'
import type { MyWorkSwitches } from '../../../../shared/types/work-switches'
import { WORK_SWITCHES_OFFLINE_TEXT, type WorkSwitchesFailure, type WorkSwitchesResult } from '../../../shared/work-switches'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface WorkSwitchesDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

/** Ids that go into the server URL: no separators, dots or encoded characters. */
const ID = /^[A-Za-z0-9_-]{1,100}$/
const BAD_INPUT: WorkSwitchesFailure = { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
const OFFLINE: WorkSwitchesFailure = { success: false, offline: true, code: null, error: WORK_SWITCHES_OFFLINE_TEXT }

type Answer = { status: number; json: Record<string, unknown> | null }

export function createWorkSwitchesApi(deps: WorkSwitchesDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(companyId: string, method: 'GET' | 'PUT', body?: unknown): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/work-switches`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
    } catch {
      return null
    }
  }

  function answer(what: string, r: Answer | null): WorkSwitchesResult {
    if (r && r.status === 200 && r.json?.data && typeof r.json.data === 'object') return { success: true, switches: r.json.data as MyWorkSwitches }
    if (!r) {
      log.warn(`[work-switches] ${what}: the server could not be reached`)
      return OFFLINE
    }
    const code = typeof r.json?.code === 'string' ? r.json.code : null
    log.warn(`[work-switches] ${what}: answered ${r.status}${code ? ` ${code}` : ''}`)
    return {
      success: false, offline: r.status >= 500, code,
      error: typeof r.json?.error === 'string' && r.status < 500 ? r.json.error : `サーバーでエラーが起きました（HTTP ${r.status}）。`,
    }
  }

  return {
    async get(companyId: unknown): Promise<WorkSwitchesResult> {
      if (typeof companyId !== 'string' || !ID.test(companyId)) return BAD_INPUT
      return answer('get', await call(companyId, 'GET'))
    },
    async set(companyId: unknown, which: unknown, on: unknown): Promise<WorkSwitchesResult> {
      if (typeof companyId !== 'string' || !ID.test(companyId) || !isWorkSwitch(which) || typeof on !== 'boolean') return BAD_INPUT
      return answer('set', await call(companyId, 'PUT', { switch: which, on }))
    },
  }
}

export function registerWorkSwitchesIpc(ipc: IpcRegistrar, deps: WorkSwitchesDeps) {
  const api = createWorkSwitchesApi(deps)
  ipc.handle('workSwitches:get', (_event, companyId) => api.get(companyId))
  ipc.handle('workSwitches:set', (_event, companyId, which, on) => api.set(companyId, which, on))
}
