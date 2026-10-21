/**
 * Identity of a desktop-app build, embedded at build time (see
 * scripts/build-info.ts) and sent to the server as X-ACB-Client-Version.
 *
 * version = `<semver>+<sha>.<commitDate>`, e.g. `0.0.1+95346af.20261021031200`
 *   - semver: client/package.json `version`; dev runs (`pnpm dev`) append the
 *     pre-release tag `-dev`: `0.0.1-dev+95346af.20261021031200`
 *   - sha: short commit SHA ("nogit" when built outside a git checkout)
 *   - commitDate: committer date of that commit, UTC, YYYYMMDDHHmmss
 *     ("00000000000000" when unknown). The server orders builds by semver,
 *     then commit date (server/src/lib/client-version.ts). The commit date,
 *     not the build time, so a rebuild of an old commit never looks newer.
 */
export interface BuildInfo {
  /** Full identity string sent in X-ACB-Client-Version. */
  version: string
  /** package.json version, plus `-dev` for dev runs. */
  semver: string
  sha: string
  commitDate: string
  /** When the bundle was built (ISO 8601). Informational, never compared. */
  builtAt: string
  dev: boolean
}
