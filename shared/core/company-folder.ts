/**
 * A company's shared company folder (owner decision 2026-11-07, 「並べて残したい」):
 *
 *   git   the company repository + sync, as every company had until then (the default)
 *   none  no shared company folder: each member works in a folder of their own PC; records,
 *         approvals, connectors, mail, minutes, plugins and keys live in the server's database
 *
 * Chosen when the company is created and not changeable afterwards. What a `none` company
 * cannot do answers with `NO_COMPANY_FOLDER` (server.md "Companies without a shared folder").
 */

export const COMPANY_FOLDER_KINDS = ['git', 'none'] as const
export type CompanyFolderKind = (typeof COMPANY_FOLDER_KINDS)[number]

export const DEFAULT_COMPANY_FOLDER_KIND: CompanyFolderKind = 'git'

/** A kind given in a request: exactly one of the kinds, else null (the caller answers 400). */
export function parseCompanyFolderKind(value: unknown): CompanyFolderKind | null {
  return value === 'git' || value === 'none' ? value : null
}

/**
 * The kind of a stored company. Only an exact `git` has the company folder: anything else (a
 * kind a newer server wrote, a missing row) has none, so nothing ever runs git for a company
 * that was not made with a repository — a refusal, never a wrong git action.
 */
export function storedCompanyFolderKind(value: unknown): CompanyFolderKind {
  return value === 'git' ? 'git' : 'none'
}

export function hasCompanyFolder(kind: CompanyFolderKind): boolean {
  return kind === 'git'
}

/** The refusal of anything that needs the shared company folder, for a company without one. */
export const NO_COMPANY_FOLDER = {
  code: 'NO_COMPANY_FOLDER',
  error: 'この会社は全社フォルダを使わない設定のため、この操作はできません。',
} as const

/**
 * …the same refusal, said for a company path linked to a record (a path on one PC means nothing to
 * others). Such a company links a Google Drive file or a file of the member's own PC instead
 * (records.md "File links without the shared folder").
 */
export const NO_COMPANY_FOLDER_FILE_LINK = {
  code: NO_COMPANY_FOLDER.code,
  error: 'この会社は全社フォルダを使わない設定のため、全社フォルダのファイルはつなげません。Google Drive のファイルか、このパソコンのファイル（あなただけに見えます）をつないでください。',
} as const

/**
 * A company with the shared folder links a file of one member's PC never: it links company paths and
 * Google Drive files (records.md "File links without the shared folder", owner decision 2026-11-13).
 */
export const FILE_LINK_KIND_NOT_HERE = {
  code: 'FILE_LINK_KIND_NOT_HERE',
  error: 'この会社では、このパソコンだけにあるファイルはつなげません。全社フォルダのファイルか、Google Drive のファイルをつないでください。',
} as const

/** A file only on one member's PC cannot be what others check (decision materials, attached versions). */
export const LOCAL_FILE_NOT_SHARED = {
  code: 'LOCAL_FILE_NOT_SHARED',
  error: 'このパソコンだけにあるファイルは、ほかの人が確かめられないため、材料や添付にはできません。Google Drive のファイルをつないで使ってください。',
} as const

/** Only the member themself links a file of their PC or of Drive (never their AI). */
export const TYPED_LINK_PERSON_ONLY = {
  code: 'TYPED_LINK_PERSON_ONLY',
  error: 'このパソコンのファイルや Google Drive のファイルは、本人が画面からつないでください。',
} as const

/** A Drive file used as material or an attachment must have been read by ACB when it was linked. */
export const DRIVE_VERSION_NOT_FIXED = {
  code: 'DRIVE_VERSION_NOT_FIXED',
  error: 'この Google Drive のファイルは、つないだときに ACB が中身を読めなかったため、版を固定できません。読める形式（Google ドキュメント・スプレッドシート・スライド、PDF、テキスト）のファイルをつないでください。',
} as const
