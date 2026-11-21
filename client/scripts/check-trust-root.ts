/**
 * The release build's plugin trust root (`.claude/rules/plugin-trust.md` "P2", design v3 decision
 * 8: a development build carries a test root; a release build is to carry the production one).
 *
 *   cd client && npx tsx scripts/check-trust-root.ts
 *
 * Run by `pnpm build` before anything is built and by electron-builder's `beforePack`
 * (`scripts/before-pack.mjs`). While `RELEASE_REQUIRES_PRODUCTION_ROOT` is false (until the
 * enforcement PR): a missing production root is a loud warning and the build goes on, carrying
 * the development root (the app reports `root: 'development'`, so nothing is enforced on it).
 * When it is true: exit 1, the build is not made.
 */
import { nodePluginTrustCrypto } from '../electron/features/plugins/trust-crypto'
import { RELEASE_REQUIRES_PRODUCTION_ROOT, bakedTrustRoot, releaseTrustRootProblem } from '../electron/features/plugins/trust-roots'

const problem = releaseTrustRootProblem(bakedTrustRoot('production'), bakedTrustRoot('development'), nodePluginTrustCrypto, Date.now())
if (!problem) {
  console.log('[check-trust-root] the production root is in place')
} else if (RELEASE_REQUIRES_PRODUCTION_ROOT) {
  console.error(`[check-trust-root] a release build is not made: ${problem}.`)
  console.error('[check-trust-root] see .claude/rules/plugin-trust.md "Owner steps" (client/electron/features/plugins/trust-roots/production.json).')
  process.exit(1)
} else {
  const line = '!'.repeat(78)
  console.warn(`${line}\n[check-trust-root] WARNING: ${problem}.\n[check-trust-root] This build carries the DEVELOPMENT plugin trust root (it reports root: development; nothing is enforced on it).\n${line}`)
}
