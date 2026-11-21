/**
 * The root this app carries (`.claude/rules/plugin-trust.md` "P2", design v3 §7 / decision 8):
 * a **development** build (`vite` / an unpackaged app) carries the development root
 * (`trust-roots/development.json`, made by `scripts/plugin-trust-dev-root.ts`); a **packaged**
 * build carries the production root (`trust-roots/production.json`). `main.ts` chooses by
 * `app.isPackaged`; a release build cannot be made unless `releaseTrustRootProblem` says the
 * production root is real (`scripts/check-trust-root.ts`, run by `pnpm build` and electron-builder's
 * `beforePack`). The production file is a placeholder until the owner makes the root keys.
 */
import { bakedRoot } from '../../../../shared/core/plugin-trust'
import type { PluginTrustCrypto } from '../../../../shared/core/plugin-trust-sshsig'
import developmentRoot from './trust-roots/development.json'
import productionRoot from './trust-roots/production.json'

export type TrustRootKind = 'development' | 'production'

/** The envelope of the root this build carries (unchecked: `startTrust` checks it). */
export function bakedTrustRoot(kind: TrustRootKind): unknown {
  return kind === 'production' ? productionRoot : developmentRoot
}

/** A release build must carry a production root that stands on its own for at least this long. */
export const RELEASE_ROOT_MIN_LIFE_MS = 30 * 86_400_000

/**
 * Why a release build must not be made with `production` (null = it may): a placeholder or
 * anything that is not a root carrying its own root threshold; a root that shares a key with the
 * development root (or is it); a root expiring within 30 days of `now`.
 */
export function releaseTrustRootProblem(production: unknown, development: unknown, crypto: PluginTrustCrypto, now: number): string | null {
  if (typeof production === 'object' && production !== null && 'placeholder' in production) {
    return 'the production root is still the placeholder: the owner has not made the root keys yet'
  }
  let root
  try { root = bakedRoot(production, crypto) } catch (e) {
    return `the production root is not a valid root (${e instanceof Error ? e.message : 'unknown'})`
  }
  let dev
  try { dev = bakedRoot(development, crypto) } catch {
    return 'the development root cannot be read, so the production root cannot be told apart from it'
  }
  const devKeys = new Set([...dev.keys.values()].map(k => k.identity))
  if ([...root.keys.values()].some(k => devKeys.has(k.identity))) return 'the production root shares a key with the development root'
  if (Date.parse(root.document.expires) - now < RELEASE_ROOT_MIN_LIFE_MS) return 'the production root expires within 30 days: make the next root first'
  return null
}
