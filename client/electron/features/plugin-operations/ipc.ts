// The chat card of an outside system's write (milestone 3 P7, plugins.md
// "The app"): the person's own actions on an operation the AI made, sent with
// the member's session — never the AI's record token — so the server records
// them as the person's (actor kind human).
//   pluginOperations:undo       「変更前の値を書き戻す」, with the consultation as informational provenance
//   pluginOperations:reconcile  read the outside system again for a write whose answer was lost
//   pluginOperations:recreate   「もう一度作る」 a create the outside system did not show; without
//                               `confirm` the server answers its warning (RECREATE_NEEDS_CONFIRMATION)

import { PLUGIN_OPERATIONS_OFFLINE_TEXT, type PluginOperationResult } from '../../../shared/plugin-operations'
import type { PluginFieldValue, PluginOperationRecordView } from '../../../../shared/types/plugins'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface PluginOperationsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  /** Per request (default 30 s: an undo reads and writes the outside system). */
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const PLUGIN = /^[a-z][a-z0-9_-]{0,39}$/
const OPERATION = /^[A-Za-z0-9_-]{1,100}$/

export function createPluginOperationsApi(deps: PluginOperationsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function request(companyId: string, pluginId: string, operationId: string, suffix: '/undo' | '/reconcile' | '/recreate', body?: unknown): Promise<PluginOperationResult> {
    if (!COMPANY.test(companyId) || !PLUGIN.test(pluginId) || !OPERATION.test(operationId)) {
      return { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
    }
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return { success: false, offline: true, code: null, error: PLUGIN_OPERATIONS_OFFLINE_TEXT }

    let res: Response
    try {
      res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/plugins/${pluginId}/operations/${encodeURIComponent(operationId)}${suffix}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      // An undo whose answer is lost is not known to have failed: the card asks the server again.
      log.warn(`[plugin-operations] ${suffix}: the server could not be reached`)
      return { success: false, offline: true, code: null, error: PLUGIN_OPERATIONS_OFFLINE_TEXT }
    }
    const json = (await res.json().catch(() => null)) as { data?: { operation?: PluginOperationRecordView | null }; error?: unknown; code?: unknown; current?: unknown; warning?: unknown } | null
    if (res.ok && json?.data?.operation) return { success: true, operation: json.data.operation }
    const code = typeof json?.code === 'string' ? json.code : null
    log.warn(`[plugin-operations] ${suffix}: answered ${res.status}${code ? ` ${code}` : ''}`)
    // 「もう一度作る」 before the person confirmed: the server's own warning is what they confirm.
    if (code === 'RECREATE_NEEDS_CONFIRMATION' && typeof json?.warning === 'string') return { success: false, offline: false, code, error: json.warning }
    const current = json?.current && typeof json.current === 'object' ? json.current as Record<string, PluginFieldValue> : undefined
    return {
      success: false, offline: res.status >= 500, code,
      error: typeof json?.error === 'string' && res.status < 500 ? json.error : `サーバーでエラーが起きました（HTTP ${res.status}）。`,
      ...(current ? { current } : {}),
    }
  }

  return {
    undo: (companyId: string, pluginId: string, operationId: string, conversationId?: string) =>
      request(companyId, pluginId, operationId, '/undo', typeof conversationId === 'string' && conversationId.length > 0 && conversationId.length <= 200 ? { conversationId } : {}),
    reconcile: (companyId: string, pluginId: string, operationId: string) => request(companyId, pluginId, operationId, '/reconcile'),
    recreate: (companyId: string, pluginId: string, operationId: string, confirm: boolean, conversationId?: string) =>
      request(companyId, pluginId, operationId, '/recreate', {
        confirm: confirm === true,
        ...(typeof conversationId === 'string' && conversationId.length > 0 && conversationId.length <= 200 ? { conversationId } : {}),
      }),
  }
}

export function registerPluginOperationsIpc(ipc: IpcRegistrar, deps: PluginOperationsDeps) {
  const api = createPluginOperationsApi(deps)
  ipc.handle('pluginOperations:undo', (_event, companyId, pluginId, operationId, conversationId) => api.undo(companyId, pluginId, operationId, conversationId))
  ipc.handle('pluginOperations:reconcile', (_event, companyId, pluginId, operationId) => api.reconcile(companyId, pluginId, operationId))
  ipc.handle('pluginOperations:recreate', (_event, companyId, pluginId, operationId, confirm, conversationId) => api.recreate(companyId, pluginId, operationId, confirm, conversationId))
}
