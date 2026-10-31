// What CompanySelector does with a chosen company folder, from main's answer
// to git:inspectCompanyFolder (electron/sync/company-folder.ts). Both the
// 「既存のフォルダを開く」 and the 「新しく作成」 path go through here, so an
// empty folder gets the department picker whichever way it was chosen.

export type InspectedFolder = {
  success: boolean
  decision?:
    | { action: 'firstSetup' | 'existingClone' | 'uploadExisting' }
    | { action: 'refuse'; reason: string; message: string }
  error?: string
}

export type FolderSetupPlan =
  /** Nothing downloaded yet and the company has content: pick departments (when it has any), then partial first setup. */
  | { kind: 'firstSetup' }
  /** An existing clone of this company: open it as before (no conversion, no first-time screen). */
  | { kind: 'reopen' }
  /** The company has no content yet: the folder becomes its first commit (owner). */
  | { kind: 'upload' }
  /** The folder cannot be used; nothing in it was changed. */
  | { kind: 'error'; message: string }

export const INSPECT_FAILED_MESSAGE = 'サーバーに接続できませんでした。インターネット接続を確認して、もう一度お試しください。'

/**
 * Main answers offline too, for a clone of this company (it opens, so work
 * goes on without the server); any other folder needs the server first.
 */
export function planFolderSetup(inspected: InspectedFolder | null): FolderSetupPlan {
  const decision = inspected?.success ? inspected.decision : undefined
  if (!decision) return { kind: 'error', message: inspected?.error || INSPECT_FAILED_MESSAGE }
  switch (decision.action) {
    case 'refuse': return { kind: 'error', message: decision.message }
    case 'firstSetup': return { kind: 'firstSetup' }
    case 'existingClone': return { kind: 'reopen' }
    case 'uploadExisting': return { kind: 'upload' }
  }
}
