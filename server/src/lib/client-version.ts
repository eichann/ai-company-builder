/**
 * Desktop-app build identity: parsing and ordering live in
 * shared/core/client-version.ts (the admin console ranks builds with the same
 * copy); the server's feature gates on it are below.
 */
import { parseClientVersion } from '../../shared/core/client-version'

export {
  clientBuildOf,
  compareClientVersions,
  parseClientVersion,
  type ParsedClientVersion,
} from '../../shared/core/client-version'

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
 * Stage 3b (client sync) merged as b8c5a8e (#137); computed like
 * WRITE_DENIED_RECOVERY_COMMIT_DATE from that merge commit:
 *   TZ=UTC git log -1 --format=%cd --date=format-local:%Y%m%d%H%M%S b8c5a8e
 *
 * (null would mean no released app handles them: every create is refused.)
 */
export const PRIVATE_FOLDERS_CLIENT_COMMIT_DATE: string | null = '20261022085300'

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

/**
 * Committer date (UTC, YYYYMMDDHHmmss) of the first main commit whose desktop
 * app sends the AI action log (POST /agent-events, monitoring M1 PR 3).
 *
 * The committer date of #206's merge commit (50d34ce). The admin console's
 * log page lists the members whose app is older (supportsAgentEvents false),
 * since their AI's actions are not recorded.
 */
export const AGENT_EVENTS_CLIENT_COMMIT_DATE: string | null = '20261024181341'

/** Does this desktop-app build send the AI action log? Unknown = no; always no while the cutoff is null. */
export function supportsAgentEvents(
  version: string | null | undefined,
  cutoff: string | null = AGENT_EVENTS_CLIENT_COMMIT_DATE,
): boolean {
  if (cutoff === null) return false
  const parsed = parseClientVersion(version)
  if (!parsed || !parsed.commitDate) return false
  return parsed.commitDate >= cutoff
}
