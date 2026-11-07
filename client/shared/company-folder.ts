// A company with or without the shared company folder, as the app reads the server's answer
// (shared/core/company-folder.ts; owner decision 2026-11-07). Pure.
//
// A company without one (`none`) is opened in a plain folder on this PC (its "working folder"):
// no clone, no sync, nothing in it is shared. Everything else about the company (records, tasks,
// approvals, connectors, plugins…) works as for any company.
import type { CompanyFolderKind } from '../../shared/core/company-folder'

export type { CompanyFolderKind }

/**
 * The kind of a company in a server answer. Only an exact `none` is a company without the
 * shared folder: an older server sends nothing (every company it has is a git company), and
 * anything else is read as `git`, so a git company is never treated as one without a folder.
 */
export function answeredCompanyFolderKind(value: unknown): CompanyFolderKind {
  return value === 'none' ? 'none' : 'git'
}

/** Whether a company opened in the app has the shared company folder (sync, download choices, private folders, history). */
export function companyHasSharedFolder(company: { folderKind?: unknown } | null | undefined): boolean {
  return answeredCompanyFolderKind(company?.folderKind) !== 'none'
}

/** The note a company without the shared folder shows where git companies have sync and history. */
export const WORKING_FOLDER_NOTE = 'この会社では、ファイルはこの PC の中だけに置かれます（ほかの人には共有されません）。'

/**
 * What a member of such a company must know (owner decision 2026-11-07): the working folder is
 * kept nowhere else, while records are on the server.
 */
export const WORKING_FOLDER_BACKUP_NOTE = '作業フォルダのファイルはこの PC の中だけにあり、サーバーには残りません。PC のバックアップ機能で守ってください。やること・決めたことなどの記録はサーバーに残ります。'
