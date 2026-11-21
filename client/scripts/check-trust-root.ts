/**
 * Refuses a release build without the production plugin trust root (`.claude/rules/plugin-trust.md`
 * "P2", design v3 decision 8: a development build carries a test root; a release build must carry
 * the production one, else it is not made).
 *
 *   cd client && npx tsx scripts/check-trust-root.ts
 *
 * Run by `pnpm build` before anything is built and by electron-builder's `beforePack`
 * (`scripts/before-pack.mjs`), so packaging cannot skip it. Exit 1 with the reason.
 */
import { nodePluginTrustCrypto } from '../electron/features/plugins/trust-crypto'
import { bakedTrustRoot, releaseTrustRootProblem } from '../electron/features/plugins/trust-roots'

const problem = releaseTrustRootProblem(bakedTrustRoot('production'), bakedTrustRoot('development'), nodePluginTrustCrypto, Date.now())
if (problem) {
  console.error(`[check-trust-root] a release build is not made: ${problem}.`)
  console.error('[check-trust-root] see .claude/rules/plugin-trust.md "Owner steps" (client/electron/features/plugins/trust-roots/production.json).')
  process.exit(1)
}
console.log('[check-trust-root] the production root is in place')
