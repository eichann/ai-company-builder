// The server address from an invitation's 「アプリを開く」 link (管理画面の見直し 2-2: the member
// never types it). The shell (main.ts) hands every link it receives to `offer`; nothing is
// used until the member has seen the address and pressed 「つなぐ」:
//   - only https server addresses (http on this computer) pass link.ts;
//   - only while the app has no server yet — a link never switches a configured app to
//     another server (that stays a deliberate change in 設定);
//   - the renderer never names the address it accepts: `appLink:acceptServer` saves the
//     one main holds, after that server answered as an ACB server.
//   appLink:serverOffer, appLink:acceptServer, appLink:dismissServer

import type { IpcRegistrar } from '../../ipc/registrar'
import { serverFromAppLink } from './link'

export interface AppLinkDeps {
  /** The configured server ('' when none). */
  currentServer: () => string
  /** Make `origin` the app's server (config.json). */
  saveServer: (origin: string) => void
  /** Whether `origin` answers as an ACB server (default: GET /api/config). */
  checkServer?: (origin: string) => Promise<boolean>
  log?: (message: string) => void
}

export interface AppLinks {
  /** A link the app was opened with (open-url, a second instance's or the first launch's arguments). */
  offer(raw: unknown): void
}

export const APP_LINK_NO_OFFER = '招待のリンクの情報がありません。招待のページの［アプリを開く］をもう一度押してください。'
export const APP_LINK_ALREADY_SET = 'このアプリには、すでにサーバーが設定されています。'
export const APP_LINK_NOT_ACB = 'このアドレスにつながらないか、AI Company Builder のサーバーではありません。インターネットにつながっているか確かめて、もう一度押してください。'

async function answersAsAcb(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
    if (!response.ok) return false
    const data = await response.json() as { success?: unknown; data?: { name?: unknown } } | null
    return data?.success === true && data.data?.name === 'AI Company Builder'
  } catch {
    return false
  }
}

export function registerAppLinkIpc(ipc: IpcRegistrar, deps: AppLinkDeps): AppLinks {
  const { currentServer, saveServer, checkServer = answersAsAcb, log = () => {} } = deps
  let pending: string | null = null

  ipc.handle('appLink:serverOffer', () => {
    if (currentServer()) pending = null
    return pending ? { server: pending } : null
  })

  ipc.handle('appLink:acceptServer', async () => {
    const origin = pending
    if (!origin) return { success: false, error: APP_LINK_NO_OFFER }
    if (currentServer()) {
      pending = null
      return { success: false, error: APP_LINK_ALREADY_SET }
    }
    if (!(await checkServer(origin))) return { success: false, error: APP_LINK_NOT_ACB }
    // A newer link may have replaced the offer while the check ran: use only what was shown and checked.
    if (pending !== origin || currentServer()) return { success: false, error: APP_LINK_NO_OFFER }
    saveServer(origin)
    pending = null
    return { success: true }
  })

  ipc.handle('appLink:dismissServer', () => { pending = null })

  return {
    offer(raw) {
      const server = serverFromAppLink(raw)
      if (!server) {
        log('App link: refused (not an https server address)')
        return
      }
      const current = currentServer()
      if (current) {
        if (current.replace(/\/+$/, '') !== server) log('App link: a server is already set; the link was ignored')
        return
      }
      pending = server
    },
  }
}
