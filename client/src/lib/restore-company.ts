// Whether the company remembered from the last session can be opened directly
// after login (App.tsx), without going through the company selector.
//
// The main process answers file questions (fs:exists, …) only for folders
// registered as allowed roots, and a fresh launch has none: the company's
// folder is registered when it is opened. Asking `exists` first therefore
// always answered "no" — the remembered company was forgotten and every login
// went through the selector and the setup screen again. The folder is
// registered first, exactly as opening the company would.

export interface RestoreDeps {
  /** Ids of the companies the signed-in member can access; null when the server cannot be asked. */
  accessibleCompanyIds: () => Promise<string[] | null>
  registerAllowedRoot: (folder: string) => Promise<unknown>
  exists: (target: string) => Promise<boolean>
}

/**
 * 'open'   — open the remembered company directly.
 * 'forget' — access was revoked or the folder is gone: forget it, show the selector.
 * 'keep'   — could not tell (offline, IPC error): show the selector this time,
 *            remember the company for the next login.
 */
export type RestoreOutcome = 'open' | 'forget' | 'keep'

export async function checkRememberedCompany(
  remembered: { id: string; rootPath: string },
  deps: RestoreDeps,
): Promise<RestoreOutcome> {
  try {
    const ids = await deps.accessibleCompanyIds()
    if (!ids) return 'keep'
    if (!ids.includes(remembered.id)) return 'forget'
    await deps.registerAllowedRoot(remembered.rootPath)
    // The folder may have been deleted or moved since the last session:
    // opening it anyway leaves no files, no git and no way back.
    return (await deps.exists(remembered.rootPath)) ? 'open' : 'forget'
  } catch {
    return 'keep'
  }
}
