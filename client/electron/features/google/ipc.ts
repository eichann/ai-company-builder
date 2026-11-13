// The Google connection (「Google で許可」, milestone 4; .claude/rules/google-connector.md):
//   google:status, google:connect, google:disconnect,
//   google:connectAll and google:markSeen (「仕事の道具をつなぐ」: one consent for what the company offers),
//   google:relay and google:setRelay (「スプレッドシートを中継で使う」: the member's view and own records,
//   and 「やめる」 / turning it back on without a new consent; google-connector.md "The relay"),
//   google:setArchive (「済んだメールを Gmail でもアーカイブする」: the member's own switch, sends only
//   `{ feature: 'inbox_archive', on }`; google-connector.md "Archiving in Gmail"),
//   google:decideDriveOverwrite (the card's 「上書きする」 / 「やめる」 for a Google document someone else edited:
//   the person's press with the session; google-drive.md "Continuing a document people edited")
// The server holds everything (the permission, sealed); the app holds no token
// at all. google:connect asks the server for the sign-in page's URL and opens
// it in the system browser itself — the URL (with its one-time state) never
// reaches the renderer, which learns the result by asking google:status.
// The session cookie stays here; the renderer gets the server's view or a
// sentence built from status codes only. Logged: the method and the status.

import { GOOGLE_OFFLINE_TEXT, googleErrorText, isGoogleSignInUrl, type GoogleConnectResult, type GoogleFeature, type GoogleRelayResult, type GoogleStatusResult, type MyGoogle, type MyGoogleRelay } from '../../../shared/google'
import { GOOGLE_FEATURES } from '../../../../shared/core/google'
import { DRIVE_OVERWRITE_REFUSALS, type DriveOverwriteDecisionResult } from '../../../shared/drive-overwrite'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { DesktopShell } from '../ports'

export interface GoogleDeps {
  baseUrl: () => string
  cookies: () => string[]
  shell: Pick<DesktopShell, 'openExternal'>
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

const FEATURES: readonly GoogleFeature[] = GOOGLE_FEATURES
const offline = { success: false, offline: true, error: GOOGLE_OFFLINE_TEXT } as const
const invalid = { success: false, offline: false, error: '入力が正しくありません。' } as const

const isMyGoogle = (v: unknown): v is MyGoogle =>
  !!v && typeof v === 'object' && typeof (v as MyGoogle).available === 'boolean' && Array.isArray((v as MyGoogle).features)

const isMyGoogleRelay = (v: unknown): v is MyGoogleRelay =>
  !!v && typeof v === 'object' && typeof (v as MyGoogleRelay).available === 'boolean' && Array.isArray((v as MyGoogleRelay).services)
  && Array.isArray((v as MyGoogleRelay).records)

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

  async function view(companyId: string, method: 'GET' | 'DELETE' | 'PUT', rest = ''): Promise<GoogleStatusResult> {
    const r = await send(companyId, method, rest)
    if (!r) return offline
    const data = (r.json as { data?: unknown } | null)?.data
    if (r.res.ok && isMyGoogle(data)) return { success: true, data }
    log.warn(`[google] ${method}${rest ? ` ${rest}` : ''}: answered ${r.res.status}`)
    return { success: false, offline: false, error: googleErrorText(r.res.status, r.json) }
  }

  async function relayView(companyId: string): Promise<GoogleRelayResult> {
    const r = await send(companyId, 'GET', '/relay')
    if (!r) return offline
    const data = (r.json as { data?: unknown } | null)?.data
    if (r.res.ok && isMyGoogleRelay(data)) return { success: true, data }
    log.warn(`[google] GET relay: answered ${r.res.status}`)
    return { success: false, offline: false, error: googleErrorText(r.res.status, r.json) }
  }

  /** 「やめる」 / back on: the member's own switch of the allowed feature (no consent), then the relay's view. */
  async function setRelay(companyId: string, on: boolean): Promise<GoogleRelayResult> {
    const r = await send(companyId, 'PUT', '/features', { feature: 'sheets', on })
    if (!r) return offline
    if (!r.res.ok) {
      log.warn(`[google] PUT features: answered ${r.res.status}`)
      return { success: false, offline: false, error: googleErrorText(r.res.status, r.json) }
    }
    return relayView(companyId)
  }

  /** 「済んだメールを Gmail でもアーカイブする」 off / back on: the member's own switch only (no consent). */
  async function setArchive(companyId: string, on: boolean): Promise<GoogleStatusResult> {
    const r = await send(companyId, 'PUT', '/features', { feature: 'inbox_archive', on })
    if (!r) return offline
    const data = (r.json as { data?: unknown } | null)?.data
    if (r.res.ok && isMyGoogle(data)) return { success: true, data }
    log.warn(`[google] PUT features: answered ${r.res.status}`)
    return { success: false, offline: false, error: googleErrorText(r.res.status, r.json) }
  }

  async function openSignIn(companyId: string, body: { features: GoogleFeature[] } | { all: true }): Promise<GoogleConnectResult> {
    const r = await send(companyId, 'POST', '/connect', body)
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
  }

  return {
    status: (companyId: string) => view(companyId, 'GET'),
    disconnect: (companyId: string) => view(companyId, 'DELETE'),
    /** 「あとで」: what the company offers now is marked shown (the screen comes back only for new ones). */
    markSeen: (companyId: string) => view(companyId, 'PUT', '/seen'),
    /** 「Google でつなぐ」: one consent for every feature the company offers. */
    connectAll: (companyId: string) => openSignIn(companyId, { all: true }),
    connect: (companyId: string, features: GoogleFeature[]) => openSignIn(companyId, { features }),
    relay: relayView,
    setRelay,
    setArchive,
    decideDriveOverwrite,
  }

  /** The person's 「上書きする」 / 「やめる」 (session only): the server writes exactly the content that waited, or closes it. */
  async function decideDriveOverwrite(companyId: string, confirmationId: string, action: 'confirm' | 'decline'): Promise<DriveOverwriteDecisionResult> {
    const r = await send(companyId, 'POST', `/drive/overwrite-confirmations/${encodeURIComponent(confirmationId)}`, { action })
    if (!r) return { ...offline, code: null }
    const j = (r.json ?? {}) as { data?: { state?: unknown; drivePut?: { link?: unknown }; commentsMayMove?: unknown }; code?: unknown }
    if (r.res.ok && j.data?.state === 'written') {
      return { success: true, state: 'written', link: typeof j.data.drivePut?.link === 'string' ? j.data.drivePut.link : null, commentsMayMove: j.data.commentsMayMove === true }
    }
    if (r.res.ok && j.data?.state === 'declined') return { success: true, state: 'declined' }
    log.warn(`[google] POST drive overwrite: answered ${r.res.status}`)
    const code = typeof j.code === 'string' ? j.code : null
    return { success: false, offline: false, code, error: (code && DRIVE_OVERWRITE_REFUSALS[code]) || googleErrorText(r.res.status, r.json) }
  }
}

export function registerGoogleIpc(ipc: IpcRegistrar, deps: GoogleDeps): ReturnType<typeof createGoogleApi> {
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
  ipc.handle('google:connectAll', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.connectAll(companyId)
  })
  ipc.handle('google:markSeen', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.markSeen(companyId)
  })
  ipc.handle('google:relay', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.relay(companyId)
  })
  ipc.handle('google:setRelay', async (_, companyId: string, on: boolean) => {
    if (typeof companyId !== 'string' || !companyId || typeof on !== 'boolean') return invalid
    return api.setRelay(companyId, on)
  })
  ipc.handle('google:setArchive', async (_, companyId: string, on: boolean) => {
    if (typeof companyId !== 'string' || !companyId || typeof on !== 'boolean') return invalid
    return api.setArchive(companyId, on)
  })
  ipc.handle('google:decideDriveOverwrite', async (_, companyId: string, confirmationId: string, action: 'confirm' | 'decline') => {
    if (typeof companyId !== 'string' || !companyId || typeof confirmationId !== 'string' || !/^drive-confirm-[A-Za-z0-9_-]{1,80}$/.test(confirmationId)
      || (action !== 'confirm' && action !== 'decline')) return { ...invalid, code: null }
    return api.decideDriveOverwrite(companyId, confirmationId, action)
  })
  return api
}
