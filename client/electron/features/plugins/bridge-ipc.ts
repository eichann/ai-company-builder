// The bridge of a plugin's screen, main's part (stage 4b, plan A5, plugin-frame.md):
//   plugins:bridge   one call a frame made, forwarded to the server with the member's session
//
// The renderer's bridge host (src/features/plugins) receives `{ id, op, args }` on the one port
// it handed the frame, and passes the call here with the plugin of the frame it created. Main
// reads the call again (`parseBridgeCall`: bridge 1's ops, exactly their keys), refuses a package
// the app does not keep for that company now, and sends B6's `PluginBridgeRequest`
// (`{ pluginId, version, op, args }`) to `POST /api/companies/:companyId/plugin-bridge`, which
// decides (the person × what the company allowed the plugin × the operation's `via`) and records
// `via: plugin`. Only the main window may call. Nothing of a call's arguments or answer is logged
// (only the op, the status and the code).

import { COMPANY_ID_RE } from '../../../../shared/core/plugin-declaration-rules'
import type { PluginBridgeRequest } from '../../../../shared/types/plugin-bridge'
import type { PluginPackageRef } from '../../../shared/plugin-bridge'
import { BRIDGE_ERROR, parseBridgeCall, type PluginBridgeAnswer } from '../../../shared/plugin-bridge-ops'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface PluginBridgeDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** The app keeps this package for this company now (store.ts `keptPackage`); the server checks the grant again. */
  keeps: (pluginId: string, version: string, companyId: string) => boolean
  /** Only the main window shows plugin screens. */
  isMainWindow: (senderId: number) => boolean
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

const OFFLINE_TEXT = 'サーバーにつながっていません。つながってから、もう一度お試しください。'
const NOT_AVAILABLE_TEXT = 'この画面は、いまは使えません。'

const refuse = (code: string, message: string): PluginBridgeAnswer => ({ ok: false, error: { code, message } })

export function createPluginBridgeApi(deps: PluginBridgeDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  return {
    async call(companyId: unknown, plugin: unknown, op: unknown, args: unknown): Promise<PluginBridgeAnswer> {
      if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) return refuse(BRIDGE_ERROR.badRequest, 'company')
      const ref = plugin as Partial<PluginPackageRef> | null
      if (!ref || typeof ref.id !== 'string' || typeof ref.version !== 'string') return refuse(BRIDGE_ERROR.badRequest, 'plugin')
      const parsed = parseBridgeCall(op, args)
      if (!parsed.ok) return refuse(parsed.error === 'unknown op' ? BRIDGE_ERROR.unknownOp : BRIDGE_ERROR.badRequest, parsed.error)
      // Opening something is the core app's screen's (it never reaches the server).
      const call = parsed.value
      if (call.op === 'ui.open') return refuse(BRIDGE_ERROR.unknownOp, 'not a server operation')
      if (!deps.keeps(ref.id, ref.version, companyId)) return refuse(BRIDGE_ERROR.notAvailable, NOT_AVAILABLE_TEXT)

      const base = deps.baseUrl().replace(/\/+$/, '')
      const cookies = deps.cookies()
      if (!base || cookies.length === 0) return refuse(BRIDGE_ERROR.offline, OFFLINE_TEXT)
      const body: PluginBridgeRequest = { pluginId: ref.id, version: ref.version, op: call.op, args: call.args }
      let res: Response
      try {
        res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/plugin-bridge`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
          headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch {
        log.warn(`[plugins] bridge ${body.op}: the server could not be reached`)
        return refuse(BRIDGE_ERROR.offline, OFFLINE_TEXT)
      }
      const json = (await res.json().catch(() => null)) as { data?: unknown; error?: unknown; code?: unknown } | null
      if (res.ok) return { ok: true, data: json?.data ?? null }
      const code = typeof json?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(json.code) ? json.code : null
      log.warn(`[plugins] bridge ${body.op}: answered ${res.status}${code ? ` ${code}` : ''}`)
      if (res.status >= 500) return refuse(BRIDGE_ERROR.failed, `サーバーでエラーが起きました（HTTP ${res.status}）。`)
      const message = typeof json?.error === 'string' ? json.error.slice(0, 500) : NOT_AVAILABLE_TEXT
      return refuse(code ?? (res.status === 404 ? BRIDGE_ERROR.notAvailable : `HTTP_${res.status}`), message)
    },
  }
}

export function registerPluginBridgeIpc(ipc: IpcRegistrar, deps: PluginBridgeDeps) {
  const api = createPluginBridgeApi(deps)
  ipc.handle('plugins:bridge', (event, companyId, plugin, op, args) => {
    if (!deps.isMainWindow(event.sender.id)) return refuse(BRIDGE_ERROR.notAvailable, NOT_AVAILABLE_TEXT)
    return api.call(companyId, plugin, op, args)
  })
}
