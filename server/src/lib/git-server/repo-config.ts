/**
 * The git config every company bare repository carries (configureBareRepo).
 * Kept free of imports so the client's sync harness (client/tests/sync-harness)
 * configures its simulated server with exactly these values.
 */
export const BARE_REPO_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  // Enable HTTP push (required for git-http-backend)
  ['http.receivepack', 'true'],
  // The repo is the whole team's shared history: a force push or branch
  // deletion from one member's broken clone must never be able to erase
  // everyone else's work.
  ['receive.denyNonFastForwards', 'true'],
  ['receive.denyDeletes', 'true'],
  // Partial clone. A member setting up a company for the first time picks
  // their departments and the app clones with --filter=blob:none, so only
  // the blobs inside that sparse cone are downloaded; the rest are fetched
  // lazily (by object id) when git needs them later.
  //  - allowFilter: honour --filter (advertises the `filter` capability).
  //  - allowReachableSHA1InWant: git-http does not forward Git-Protocol, so
  //    upload-pack speaks protocol v0, where a want for an object that is not
  //    a ref tip — every lazy fetch — is refused ("Server does not allow
  //    request for unadvertised object") unless this is set. "Reachable" is
  //    the narrowest setting that works: objects reachable from a ref, i.e.
  //    what a full clone already gives every member. allowAnySHA1InWant would
  //    also serve unreachable objects (e.g. ones left by an aborted push
  //    before gc) and is not needed.
  ['uploadpack.allowFilter', 'true'],
  ['uploadpack.allowReachableSHA1InWant', 'true'],
]
