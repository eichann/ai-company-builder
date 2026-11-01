// The Slack connection (「Slack で許可」, stage 3 A3; .claude/rules/slack-connector.md):
//   slack:status, slack:connect, slack:disconnect, slack:setFeature
// The server holds everything (the permission, sealed); the app holds no token
// at all. slack:connect asks the server for the sign-in page's URL and opens
// it in the system browser itself — the URL (with its one-time state) never
// reaches the renderer, which learns the result by asking slack:status.
// The session cookie stays here; the renderer gets the server's view or a
// sentence built from status codes only. Logged: the method and the status.

import { SLACK_OFFLINE_TEXT, isSlackSignInUrl, slackErrorText, type MySlack, type SlackConnectResult, type SlackFeature, type SlackStatusResult } from '../../../shared/slack'
import { SLACK_FEATURES } from '../../../../shared/core/slack'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { DesktopShell } from '../ports'

export interface SlackDeps {
  baseUrl: () => string
  cookies: () => string[]
  shell: Pick<DesktopShell, 'openExternal'>
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

const FEATURES: readonly SlackFeature[] = SLACK_FEATURES
const offline = { success: false, offline: true, error: SLACK_OFFLINE_TEXT } as const
const invalid = { success: false, offline: false, error: '入力が正しくありません。' } as const

const isMySlack = (v: unknown): v is MySlack =>
  !!v && typeof v === 'object' && typeof (v as MySlack).available === 'boolean' && Array.isArray((v as MySlack).features)

export function createSlackApi(deps: SlackDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function send(companyId: string, method: string, rest: string, body?: unknown): Promise<{ res: Response; json: unknown } | null> {
    const base = deps.baseUrl()
    if (!base) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/slack${rest}`, {
        method,
        headers: { Cookie: deps.cookies().join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { res, json: await res.json().catch(() => null) }
    } catch {
      log.warn(`[slack] ${method}: the server could not be reached`)
      return null
    }
  }

  async function view(companyId: string, method: 'GET' | 'DELETE' | 'PUT', rest = '', body?: unknown): Promise<SlackStatusResult> {
    const r = await send(companyId, method, rest, body)
    if (!r) return offline
    const data = (r.json as { data?: unknown } | null)?.data
    if (r.res.ok && isMySlack(data)) return { success: true, data }
    log.warn(`[slack] ${method}${rest ? ` ${rest}` : ''}: answered ${r.res.status}`)
    return { success: false, offline: false, error: slackErrorText(r.res.status, r.json) }
  }

  return {
    status: (companyId: string) => view(companyId, 'GET'),
    disconnect: (companyId: string) => view(companyId, 'DELETE'),
    /** The member turns an allowed feature off / on (知らせの DM). */
    setFeature: (companyId: string, feature: SlackFeature, on: boolean) => view(companyId, 'PUT', '/features', { feature, on }),
    /** 「仕事の道具をつなぐ」 showed Slack (「Slack でつなぐ」 or 「あとで」): not offered there again. */
    markSeen: (companyId: string) => view(companyId, 'PUT', '/seen'),
    async connect(companyId: string, features: SlackFeature[]): Promise<SlackConnectResult> {
      const r = await send(companyId, 'POST', '/connect', { features })
      if (!r) return offline
      const url = (r.json as { data?: { authorizeUrl?: unknown } } | null)?.data?.authorizeUrl
      if (!r.res.ok || !isSlackSignInUrl(url)) {
        log.warn(`[slack] POST connect: answered ${r.res.status}`)
        return { success: false, offline: false, error: r.res.ok ? 'Slack の画面を開けませんでした。' : slackErrorText(r.res.status, r.json) }
      }
      try {
        await deps.shell.openExternal(url)
      } catch {
        log.warn('[slack] POST connect: the browser could not be opened')
        return { success: false, offline: false, error: 'ブラウザを開けませんでした。' }
      }
      return { success: true }
    },
  }
}

const validFeatures = (features: unknown): features is SlackFeature[] =>
  Array.isArray(features) && features.length > 0 && features.every(f => FEATURES.includes(f as SlackFeature))

export function registerSlackIpc(ipc: IpcRegistrar, deps: SlackDeps): ReturnType<typeof createSlackApi> {
  const api = createSlackApi(deps)
  ipc.handle('slack:status', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.status(companyId)
  })
  ipc.handle('slack:connect', async (_, companyId: string, features: SlackFeature[]) => {
    if (typeof companyId !== 'string' || !companyId || !validFeatures(features)) return invalid
    return api.connect(companyId, [...new Set(features)])
  })
  ipc.handle('slack:disconnect', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.disconnect(companyId)
  })
  ipc.handle('slack:markSeen', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.markSeen(companyId)
  })
  ipc.handle('slack:setFeature', async (_, companyId: string, feature: SlackFeature, on: boolean) => {
    if (typeof companyId !== 'string' || !companyId || !FEATURES.includes(feature) || typeof on !== 'boolean') return invalid
    return api.setFeature(companyId, feature, on)
  })
  return api
}
