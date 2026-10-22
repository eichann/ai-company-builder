/**
 * Desktop-app build identity, as sent in the X-ACB-Client-Version header.
 *
 * Format (built by client/scripts/build-info.ts):
 *
 *     <semver>+<sha>.<commitDate>
 *     0.0.1+95346af.20261021031200        release build
 *     0.0.1-dev+95346af.20261021031200    `pnpm dev` run
 *
 * - <semver> is client/package.json's version. A `-dev` pre-release tag marks
 *   a development run.
 * - <sha> is the short commit SHA the build was made from ("nogit" when the
 *   build had no git checkout).
 * - <commitDate> is that commit's committer date in UTC, YYYYMMDDHHmmss
 *   (00000000000000 when unknown). It is the commit date rather than the build
 *   time on purpose: rebuilding an old commit today must not look newer than a
 *   build of a later commit.
 *
 * Ordering (compareClientVersions):
 *   1. semver core (major.minor.patch), numerically;
 *   2. semver pre-release: a version without one is newer than the same core
 *      with one (0.0.1-dev < 0.0.1), identifiers compared per semver §11;
 *   3. commit date, as a tiebreak: a later commit is a newer build.
 *   The SHA never orders anything; two builds with the same core, pre-release
 *   and commit date compare equal.
 *
 * client/package.json has said 0.0.1 for every build so far, so in practice the
 * commit date is what orders builds until the version is bumped. Dev runs
 * always rank below a release with the same core, so a developer's dev build
 * never satisfies a "build >= X" gate set from a release.
 */

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export interface ParsedClientVersion {
  raw: string
  major: number
  minor: number
  patch: number
  /** Pre-release identifiers, e.g. ['dev']; empty for a release. */
  prerelease: string[]
  /** Short commit SHA, or null when the build metadata does not carry one. */
  sha: string | null
  /** Commit date YYYYMMDDHHmmss (UTC), or null when absent/unknown. */
  commitDate: string | null
  /** True for a `pnpm dev` run. */
  dev: boolean
}

export function parseClientVersion(raw: string | null | undefined): ParsedClientVersion | null {
  if (!raw) return null
  const m = VERSION_RE.exec(raw.trim())
  if (!m) return null
  const prerelease = m[4] ? m[4].split('.') : []
  const build = m[5] ? m[5].split('.') : []
  const sha = build[0] && build[0] !== 'nogit' ? build[0] : null
  const date = build[1] && /^\d{14}$/.test(build[1]) && !/^0+$/.test(build[1]) ? build[1] : null
  return {
    raw: raw.trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
    sha,
    commitDate: date,
    dev: prerelease.includes('dev'),
  }
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare two parsed build identities: negative when a is older than b,
 * positive when newer, 0 when they rank equal. See the module comment.
 */
export function compareClientVersions(a: ParsedClientVersion, b: ParsedClientVersion): number {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return Math.sign(a[k] - b[k])
  }
  const ap = a.prerelease
  const bp = b.prerelease
  if (ap.length === 0 && bp.length > 0) return 1
  if (ap.length > 0 && bp.length === 0) return -1
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    const c = comparePrereleaseIdentifier(ap[i], bp[i])
    if (c !== 0) return c
  }
  if (ap.length !== bp.length) return Math.sign(ap.length - bp.length)
  // Unknown commit date ranks below any known one.
  const ad = a.commitDate ?? ''
  const bd = b.commitDate ?? ''
  return ad < bd ? -1 : ad > bd ? 1 : 0
}

/** True when `version` is a parseable build at least as new as `minimum`. */
export function isClientVersionAtLeast(version: string | null | undefined, minimum: ParsedClientVersion): boolean {
  const parsed = parseClientVersion(version)
  if (!parsed) return false
  return compareClientVersions(parsed, minimum) >= 0
}

// ----------------------------------------------------------------------------
// Feature gates
// ----------------------------------------------------------------------------

/**
 * Committer date (UTC, YYYYMMDDHHmmss) of a031b73 — "feat(sync): recover from
 * WRITE_DENIED rejections like PROTECTED_CONFIG (#114)", the first main commit
 * whose desktop app understands a `[WRITE_DENIED]` push rejection. An older
 * app treats it as a generic push failure and retries the same rejected
 * commits on every sync, forever.
 *
 * Computed with
 *   TZ=UTC git log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S a031b73
 */
export const WRITE_DENIED_RECOVERY_COMMIT_DATE = '20261021182826'

/**
 * Does this desktop-app build recover from `[WRITE_DENIED]`?
 *
 * Decided by the build's commit date alone, compared with
 * WRITE_DENIED_RECOVERY_COMMIT_DATE: the semver has been 0.0.1 for every build
 * so far, and unlike compareClientVersions a `-dev` build counts by its commit
 * like any other — a developer running main from after #114 has the recovery.
 * Unknown means unsupported: no version (never connected, or an app older than
 * the X-ACB-Client-Version header), an unparsable one, or one without a commit
 * date (a build made without git). Fails closed on purpose: the cost of a
 * wrong "supported" is a member who can never sync again.
 *
 * (A build from a branch that forked before #114 but was committed later would
 * pass; release builds come from main, where the dates are monotonic enough.)
 */
export function supportsWriteDeniedRecovery(version: string | null | undefined): boolean {
  const parsed = parseClientVersion(version)
  if (!parsed || !parsed.commitDate) return false
  return parsed.commitDate >= WRITE_DENIED_RECOVERY_COMMIT_DATE
}

/**
 * Committer date (UTC, YYYYMMDDHHmmss) of the first main commit whose desktop
 * app handles private folders: several repositories per company (the
 * company repository plus one scope repository per readable private
 * folder), the `[RESERVED_PATH]` rejection, and GET /me/scopes.
 *
 * null while no released app does (stage 3b — client sync — has not been
 * merged). **Update this when stage 3b merges**, computed like
 * WRITE_DENIED_RECOVERY_COMMIT_DATE from that merge commit:
 *   TZ=UTC git log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S <sha>
 *
 * Until then every member counts as not ready, so creating a company's first
 * private folder needs an owner/admin's `force: true`.
 */
export const PRIVATE_FOLDERS_CLIENT_COMMIT_DATE: string | null = null

let privateFoldersCutoffOverride: { value: string | null } | null = null

/**
 * The cutoff in effect: PRIVATE_FOLDERS_CLIENT_COMMIT_DATE unless a test
 * overrode it. While it is null no released app can sync a private folder,
 * so POST /private-folders refuses to create one at all — `force` included
 * (a member's app would otherwise push the folder's contents into the
 * company repository's reserved path, or not see it at all).
 */
export function privateFoldersClientCutoff(): string | null {
  return privateFoldersCutoffOverride ? privateFoldersCutoffOverride.value : PRIVATE_FOLDERS_CLIENT_COMMIT_DATE
}

/** Tests only: pretend a released app supports private folders (undefined = back to the constant). */
export function setPrivateFoldersClientCutoffForTests(value: string | null | undefined): void {
  privateFoldersCutoffOverride = value === undefined ? null : { value }
}

/**
 * Can this desktop-app build work with private folders? Same rules as
 * supportsWriteDeniedRecovery: decided by the build's commit date alone,
 * unknown (no version, unparsable, no commit date) = not ready.
 */
export function supportsPrivateFolders(
  version: string | null | undefined,
  cutoff: string | null = privateFoldersClientCutoff(),
): boolean {
  if (cutoff === null) return false
  const parsed = parseClientVersion(version)
  if (!parsed || !parsed.commitDate) return false
  return parsed.commitDate >= cutoff
}
