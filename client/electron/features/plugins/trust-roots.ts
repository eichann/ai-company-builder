/**
 * The root this app carries (`.claude/rules/plugin-trust.md` "P2", design v3 §7 / decision 8):
 * a **development** build (`vite` / an unpackaged app) carries the development root
 * (`trust-roots/development.json`, made by `scripts/plugin-trust-dev-root.ts`); a **packaged**
 * build carries the production root (`trust-roots/production.json`) — while that file is still the
 * placeholder (the owner has not made the root keys), a packaged build carries the development
 * root too, says so loudly at build time (`scripts/check-trust-root.ts`) and at start, and reports
 * `root: 'development'` (`trust.ts` `health`), so enforcement can never act on it.
 *
 * `RELEASE_REQUIRES_PRODUCTION_ROOT` is the one switch: true → a release build without a real
 * production root is refused (check-trust-root exits 1, `pnpm build` / `beforePack` stop) and a
 * packaged app never falls back. The enforcement PR (P4) turns it on (owner decision pending).
 */
import { bakedRoot } from '../../../../shared/core/plugin-trust'
import type { PluginTrustCrypto } from '../../../../shared/core/plugin-trust-sshsig'
import developmentRoot from './trust-roots/development.json'
import productionRoot from './trust-roots/production.json'

export type TrustRootKind = 'development' | 'production'

/** Turned on by the enforcement PR: then a release build must carry a real production root. */
export const RELEASE_REQUIRES_PRODUCTION_ROOT = false

/** The envelope of one of the two roots in this build (unchecked: `startTrust` checks it). */
export function bakedTrustRoot(kind: TrustRootKind): unknown {
  return kind === 'production' ? productionRoot : developmentRoot
}

/** A release build must carry a production root that stands on its own for at least this long. */
export const RELEASE_ROOT_MIN_LIFE_MS = 30 * 86_400_000

/**
 * Why `production` is not a real production root (null = it is): a placeholder or anything that
 * is not a root carrying its own root threshold; a root that shares a key with the development
 * root (or is it); a root expiring within 30 days of `now`.
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

/**
 * What a build carries: unpackaged → development; packaged → production when it is a real root,
 * else (only while `required` is false) development, with the reason. `required` true and no real
 * production root → the production file as it is (the app then keeps no trust: `no-trust`).
 */
export function carriedTrustRoot(
  packaged: boolean, crypto: PluginTrustCrypto, now: number,
  roots: { production: unknown; development: unknown } = { production: productionRoot, development: developmentRoot },
  required: boolean = RELEASE_REQUIRES_PRODUCTION_ROOT,
): { kind: TrustRootKind; envelope: unknown; warning: string | null } {
  if (!packaged) return { kind: 'development', envelope: roots.development, warning: null }
  const problem = releaseTrustRootProblem(roots.production, roots.development, crypto, now)
  if (!problem || required) return { kind: 'production', envelope: roots.production, warning: problem }
  return { kind: 'development', envelope: roots.development, warning: `this packaged build carries the DEVELOPMENT plugin trust root (${problem})` }
}
