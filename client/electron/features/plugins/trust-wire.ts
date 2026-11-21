// Plugin trust P2 (`.claude/rules/plugin-trust.md` "P2"): the app's trust state under
// <userData>/trust/<root kind> (apart from the package store, and apart per carried root, so a
// development app and a packaged one never share a record), started from the root this build
// carries (`carriedTrustRoot`) and refreshed by agent-control when the policy's `pluginTrust`
// marker changes. Nothing is enforced yet.
import path from 'node:path'
import type { Session } from '../../services/session'
import { createPluginTrust, createTrustFetcher } from './trust'
import { nodePluginTrustCrypto } from './trust-crypto'
import { carriedTrustRoot } from './trust-roots'
import { createTrustFiles } from './trust-store'

export function wirePluginTrust(deps: {
  userDataDir: () => string
  serverUrl: () => string
  session: Pick<Session, 'cookies'>
  /** `app.isPackaged`. */
  packaged: boolean
  log?: Pick<Console, 'warn' | 'info'>
  /** Tests: the server. */
  fetch?: typeof fetch
}) {
  const carried = carriedTrustRoot(deps.packaged, nodePluginTrustCrypto, Date.now())
  if (carried.warning) (deps.log ?? console).warn(`[plugin-trust] ${carried.warning}`)
  return createPluginTrust({
    files: createTrustFiles(() => path.join(deps.userDataDir(), 'trust', carried.kind)),
    bakedRoot: carried.envelope,
    rootKind: carried.kind,
    crypto: nodePluginTrustCrypto,
    serverUrl: deps.serverUrl,
    fetchDocuments: createTrustFetcher({ baseUrl: deps.serverUrl, cookies: deps.session.cookies, fetch: deps.fetch }),
    log: deps.log,
  })
}
