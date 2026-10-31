// The Google connection (「Google で許可」, milestone 4; .claude/rules/google-connector.md):
//   google:status, google:connect, google:disconnect
// The server holds everything (the permission, sealed); the app holds no token
// at all. google:connect asks the server for the sign-in page's URL and opens
// it in the system browser itself — the URL (with its one-time state) never
// reaches the renderer, which learns the result by asking google:status.
// The session cookie stays here; the renderer gets the server's view or a
// sentence built from status codes only. Logged: the method and the status.

import { GOOGLE_OFFLINE_TEXT, googleErrorText, isGoogleSignInUrl, type GoogleConnectResult, type GoogleFeature, type GoogleStatusResult, type MyGoogle } from '../../../shared/google'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { DesktopShell } from '../ports'

export interface GoogleDeps {
  baseUrl: () => string
  cookies: () => string[]
  shell: Pick<DesktopShell, 'openExternal'>
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

const FEATURES: readonly GoogleFeature[] = ['minutes', 'mail']
const offline = { success: false, offline: true, error: GOOGLE_OFFLINE_TEXT } as const
const invalid = { success: false, offline: false, error: '入力が正しくありません。' } as const

const isMyGoogle = (v: unknown): v is MyGoogle =>
  !!v && typeof v === 'object' && typeof (v as MyGoogle).available === 'boolean' && Array.isArray((v as MyGoogle).features)

export function createGoogleApi(deps: GoogleDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function send(companyId: string, method: string, rest: string, body?: unknown): Promise<{ res: Response; json: unknown } | null> {
    const base = deps.baseUrl()
    if (!base) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/google${rest}`, {
        method,
        headers: { Cookie: deps.cookies().join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { res, json: await res.json().catch(() => null) }
    } catch {
      log.warn(`[google] ${method}: the server could not be reached`)
      return null
    }
  }

  async function view(companyId: string, method: 'GET' | 'DELETE'): Promise<GoogleStatusResult> {
    const r = await send(companyId, method, '')
    if (!r) return offline
    const data = (r.json as { data?: unknown } | null)?.data
    if (r.res.ok && isMyGoogle(data)) return { success: true, data }
    log.warn(`[google] ${method}: answered ${r.res.status}`)
    return { success: false, offline: false, error: googleErrorText(r.res.status, r.json) }
  }

  return {
    status: (companyId: string) => view(companyId, 'GET'),
    disconnect: (companyId: string) => view(companyId, 'DELETE'),
    async connect(companyId: string, features: GoogleFeature[]): Promise<GoogleConnectResult> {
      const r = await send(companyId, 'POST', '/connect', { features })
      if (!r) return offline
      const url = (r.json as { data?: { authorizeUrl?: unknown } } | null)?.data?.authorizeUrl
      if (!r.res.ok || !isGoogleSignInUrl(url)) {
        log.warn(`[google] POST connect: answered ${r.res.status}`)
        return { success: false, offline: false, error: r.res.ok ? 'Google の画面を開けませんでした。' : googleErrorText(r.res.status, r.json) }
      }
      try {
        await deps.shell.openExternal(url)
      } catch {
        log.warn('[google] POST connect: the browser could not be opened')
        return { success: false, offline: false, error: 'ブラウザを開けませんでした。' }
      }
      return { success: true }
    },
  }
}

export function registerGoogleIpc(ipc: IpcRegistrar, deps: GoogleDeps): void {
  const api = createGoogleApi(deps)
  ipc.handle('google:status', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.status(companyId)
  })
  ipc.handle('google:connect', async (_, companyId: string, features: GoogleFeature[]) => {
    if (typeof companyId !== 'string' || !companyId || !Array.isArray(features) || features.length === 0
      || !features.every(f => FEATURES.includes(f))) return invalid
    return api.connect(companyId, [...new Set(features)])
  })
  ipc.handle('google:disconnect', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.disconnect(companyId)
  })
}
