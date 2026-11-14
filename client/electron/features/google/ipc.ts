// The Google connection (「Google で許可」, milestone 4; .claude/rules/google-connector.md):
//   google:status, google:connect, google:disconnect,
//   google:connectAll and google:markSeen (「仕事の道具をつなぐ」: one consent for what the company offers),
//   google:relay and google:setRelay (「スプレッドシートを中継で使う」: the member's view and own records,
//   and 「やめる」 / turning it back on without a new consent; google-connector.md "The relay"),
//   google:setArchive (「済んだメールを Gmail でもアーカイブする」: the member's own switch, sends only
//   `{ feature: 'inbox_archive', on }`; google-connector.md "Archiving in Gmail"),
//   google:decideDriveOverwrite (the card's 「上書きする」 / 「置く」 / 「やめる」 — and 「このフォルダはもう聞かない」 — for a
//   Google document someone else edited or a place others see:
//   the person's press with the session; google-drive.md "Continuing a document people edited")
//   google:driveTrustedFolders / google:untrustDriveFolder (設定 → Google 「このフォルダはもう聞かない」 list and
//   ［聞くように戻す］, session only; google-drive.md "Asking before a put"),
//   google:setDrive (「Drive で選んだものを読む・置く」: the member's own switch, sends only `{ feature: 'drive', on }`;
//   member-oauth.md "Feature toggles inside a grant")
// The server holds everything (the permission, sealed); the app holds no token
// at all. google:connect asks the server for the sign-in page's URL and opens
// it in the system browser itself — the URL (with its one-time state) never
// reaches the renderer, which learns the result by asking google:status.
// The session cookie stays here; the renderer gets the server's view or a
// sentence built from status codes only. Logged: the method and the status.

import { GOOGLE_OFFLINE_TEXT, googleErrorText, isGoogleSignInUrl, type GoogleConnectResult, type GoogleFeature, type GoogleRelayResult, type GoogleStatusResult, type MyGoogle, type MyGoogleRelay } from '../../../shared/google'
import { GOOGLE_FEATURES } from '../../../../shared/core/google'
import { DRIVE_OVERWRITE_REFUSALS, type DriveOverwriteDecisionResult, type DriveTrustedFoldersResult, type DriveUntrustResult } from '../../../shared/drive-overwrite'
import type { DriveTrustedFolder } from '../../../../shared/types/google-drive'
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
  const setArchive = (companyId: string, on: boolean) => setFeature(companyId, 'inbox_archive', on)
  /** 「Drive で選んだものを読む・置く」 off / back on: the member's own switch only (no consent). */
  const setDrive = (companyId: string, on: boolean) => setFeature(companyId, 'drive', on)

  /** One of the member's own feature switches inside their grant, then their view. */
  async function setFeature(companyId: string, feature: 'inbox_archive' | 'drive', on: boolean): Promise<GoogleStatusResult> {
    const r = await send(companyId, 'PUT', '/features', { feature, on })
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
    setDrive,
    driveTrustedFolders,
    untrustDriveFolder,
  }

  /** 「このフォルダはもう聞かない」 folders: the member's own (session). */
  async function driveTrustedFolders(companyId: string): Promise<DriveTrustedFoldersResult> {
    const r = await send(companyId, 'GET', '/drive/trusted-folders')
    if (!r) return offline
    const folders = (r.json as { data?: { folders?: unknown } } | null)?.data?.folders
    if (r.res.ok && Array.isArray(folders)) {
      return {
        success: true,
        folders: folders.filter((f): f is DriveTrustedFolder => !!f && typeof f === 'object' && typeof (f as DriveTrustedFolder).folderId === 'string'
          && typeof (f as DriveTrustedFolder).folderName === 'string' && Array.isArray((f as DriveTrustedFolder).outsideDomains) && typeof (f as DriveTrustedFolder).createdAt === 'string'),
      }
    }
    log.warn(`[google] GET drive trusted folders: answered ${r.res.status}`)
    return { success: false, offline: false, error: googleErrorText(r.res.status, r.json) }
  }

  /** Asks again before every put into this folder. */
  async function untrustDriveFolder(companyId: string, folderId: string): Promise<DriveUntrustResult> {
    const r = await send(companyId, 'DELETE', `/drive/trusted-folders/${encodeURIComponent(folderId)}`)
    if (!r) return offline
    // Already gone counts as done: the folder asks again either way.
    if (r.res.ok || r.res.status === 404) return { success: true }
    log.warn(`[google] DELETE drive trusted folder: answered ${r.res.status}`)
    return { success: false, offline: false, error: googleErrorText(r.res.status, r.json) }
  }

  /**
   * The person's 「上書きする」 / 「置く」 / 「やめる」 (session only): the server writes exactly the content that waited, or
   * closes it. `trust`: 「このフォルダはもう聞かない」 ticked (the server keeps it only where the card offered it).
   */
  async function decideDriveOverwrite(companyId: string, confirmationId: string, action: 'confirm' | 'decline', trust = false): Promise<DriveOverwriteDecisionResult> {
    const r = await send(companyId, 'POST', `/drive/overwrite-confirmations/${encodeURIComponent(confirmationId)}`, { action, ...(trust && action === 'confirm' ? { trust: true } : {}) })
    if (!r) return { ...offline, code: null }
    const j = (r.json ?? {}) as { data?: { state?: unknown; drivePut?: { link?: unknown }; commentsMayMove?: unknown; notLinked?: unknown }; code?: unknown }
    if (r.res.ok && j.data?.state === 'written') {
      return { success: true, state: 'written', link: typeof j.data.drivePut?.link === 'string' ? j.data.drivePut.link : null, commentsMayMove: j.data.commentsMayMove === true, ...(j.data.notLinked ? { notLinked: true } : {}) }
    }
    if (r.res.ok && j.data?.state === 'declined') return { success: true, state: 'declined' }
    if (r.res.ok && j.data?.state === 'unknown') return { success: true, state: 'unknown' }
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
  ipc.handle('google:decideDriveOverwrite', async (_, companyId: string, confirmationId: string, action: 'confirm' | 'decline', trust?: boolean) => {
    if (typeof companyId !== 'string' || !companyId || typeof confirmationId !== 'string' || !/^drive-confirm-[A-Za-z0-9_-]{1,80}$/.test(confirmationId)
      || (action !== 'confirm' && action !== 'decline') || (trust !== undefined && typeof trust !== 'boolean')) return { ...invalid, code: null }
    return api.decideDriveOverwrite(companyId, confirmationId, action, trust === true)
  })
  ipc.handle('google:driveTrustedFolders', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.driveTrustedFolders(companyId)
  })
  ipc.handle('google:untrustDriveFolder', async (_, companyId: string, folderId: string) => {
    if (typeof companyId !== 'string' || !companyId || typeof folderId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(folderId)) return invalid
    return api.untrustDriveFolder(companyId, folderId)
  })
  ipc.handle('google:setDrive', async (_, companyId: string, on: boolean) => {
    if (typeof companyId !== 'string' || !companyId || typeof on !== 'boolean') return invalid
    return api.setDrive(companyId, on)
  })
  return api
}
