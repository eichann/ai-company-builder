// Plugin trust P2 (`.claude/rules/plugin-trust.md` "P2"): the app's trust state under
// <userData>/trust (apart from the package store), started from the root this build carries — the
// development root unless the app is packaged — and refreshed by agent-control when the policy's
// `pluginTrust` marker changes. Nothing is enforced yet.
import path from 'node:path'
import type { Session } from '../../services/session'
import { createPluginTrust, createTrustFetcher } from './trust'
import { nodePluginTrustCrypto } from './trust-crypto'
import { bakedTrustRoot } from './trust-roots'
import { createTrustFiles } from './trust-store'

export function wirePluginTrust(deps: {
  userDataDir: () => string
  serverUrl: () => string
  session: Pick<Session, 'cookies'>
  /** `app.isPackaged`: a packaged app carries the production root. */
  packaged: boolean
}) {
  return createPluginTrust({
    files: createTrustFiles(() => path.join(deps.userDataDir(), 'trust')),
    bakedRoot: bakedTrustRoot(deps.packaged ? 'production' : 'development'),
    crypto: nodePluginTrustCrypto,
    serverUrl: deps.serverUrl,
    fetchDocuments: createTrustFetcher({ baseUrl: deps.serverUrl, cookies: deps.session.cookies }),
  })
}
