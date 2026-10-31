// The key broker in the app (key-broker.md): its short-lived tokens (memory
// only, K6), the member's own API keys (「自分の鍵」), and skills' web-app
// tools, which get the broker's variables like the chat.
import { createBrokerTokenStore } from '../../services/broker-token-store'
import type { Session } from '../../services/session'
import type { ShellEnvironment } from '../../services/shell-env'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { AppLifecycle, DesktopShell, PathGuard } from '../ports'
import { registerToolsIpc } from '../tools/ipc'
import { registerBrokerIpc } from './ipc'

export interface KeyBrokerWiring {
  serverUrl: () => string
  session: Pick<Session, 'cookies'>
  paths: PathGuard
  shellEnv: ShellEnvironment
  shell: Pick<DesktopShell, 'openExternal'>
  lifecycle: AppLifecycle
}

export function wireKeyBroker(ipc: IpcRegistrar, { serverUrl, session, paths, shellEnv, shell, lifecycle }: KeyBrokerWiring) {
  const tokens = createBrokerTokenStore({ baseUrl: serverUrl, cookies: session.cookies })
  const tools = registerToolsIpc(ipc, { paths, shellEnv, shell, brokerEnv: request => tokens.envFor(request) })
  lifecycle.beforeQuit(() => tools.stopAll())
  registerBrokerIpc(ipc, { baseUrl: serverUrl, cookies: session.cookies, paths })
  return { tokens }
}
