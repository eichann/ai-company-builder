/**
 * Read-only company files for the chat AI (permission plan §11).
 *
 * The desktop app's chat can search, list and read files of the company that
 * the member has NOT downloaded (folder-level exclusions, partial clone) —
 * read-only, straight from the shared branch on the server:
 *
 *   GET /api/companies/:companyId/files/tree?path=&depth=
 *   GET /api/companies/:companyId/files/content?path=&offset=&limit=&maxBytes=
 *   GET /api/companies/:companyId/files/search?q=&path=&regex=&caseSensitive=&limit=
 *
 * Paths are company-relative ('' = the root), '/'-separated, matched in NFC
 * with A–Z folded (a Mac commits Japanese names in NFD). Responses spell
 * paths as the repository stores them. Private folders are served from their
 * own repositories to members who may read them; for everyone else they do
 * not exist (same 404 / empty result as a path that was never there).
 *
 * Every response carries the commit of `main` it was read from, so the AI
 * can cite what it saw.
 */

export interface CompanyFileEntry {
  name: string
  /** Company-relative path as stored. */
  path: string
  type: 'file' | 'folder'
  /** Bytes (files only). */
  size?: number
  /** Set on a private folder itself (only members who may read it ever see it). */
  private?: true
}

export interface CompanyFilesTree {
  /** Commit of the company repository's main. */
  commit: string
  /** The folder listed, as stored ('' = root). */
  path: string
  depth: number
  entries: CompanyFileEntry[]
  /** More entries existed than the response may carry. */
  truncated: boolean
  /** Set when `path` is (inside) a private folder: that folder's repository commit. */
  privateFolder?: { path: string; commit: string }
}

export interface CompanyFileContent {
  /** Commit of the repository the file was read from (company main, or the private folder's). */
  commit: string
  path: string
  /** Size of the whole file in bytes. */
  size: number
  /** First line returned (1-based) and the last one; endLine < startLine when nothing was returned. */
  startLine: number
  endLine: number
  /** Number of lines of the whole file, when the read reached its end. */
  totalLines?: number
  /** Lines remain after endLine; continue with offset = nextOffset. */
  hasMore: boolean
  nextOffset?: number
  /** The byte cap cut the requested range short (a long line may be cut). */
  truncated: boolean
  content: string
  /** Set when the file is inside a private folder. */
  privateFolder?: string
}

export interface CompanyFileMatch {
  path: string
  line: number
  /** The matching line (a window around the match for long lines). */
  text: string
}

export interface CompanyFilesSearch {
  commit: string
  /** Folder (or file) searched, as stored ('' = root). */
  path: string
  query: string
  regex: boolean
  caseSensitive: boolean
  matches: CompanyFileMatch[]
  /** Distinct files among the matches. */
  files: number
  /** Stopped at the match / file limit: more matches exist. */
  truncated: boolean
  /** Stopped by the time limit: the search is incomplete. */
  timedOut: boolean
  /** Commits of the private folders searched (path → commit). */
  privateFolders?: Record<string, string>
}

/** Error codes of the files API (`{ error, code }`). */
export type CompanyFilesErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_QUERY'
  | 'NOT_FOUND'
  | 'NOT_A_FOLDER'
  | 'IS_A_FOLDER'
  | 'NOT_A_REGULAR_FILE'
  | 'BINARY_FILE'
  | 'BUSY'
  | 'TIMEOUT'

export const COMPANY_FILES_LIMITS = {
  /** Largest `maxBytes` of one content read (default too). */
  contentMaxBytes: 1024 * 1024,
  contentDefaultLines: 2000,
  contentMaxLines: 20000,
  treeMaxDepth: 10,
  treeMaxEntries: 2000,
  searchDefaultMatches: 50,
  searchMaxMatches: 200,
  searchMaxFiles: 100,
  searchMaxMatchesPerFile: 20,
  searchTimeoutMs: 10_000,
  searchMaxQueryLength: 500,
  snippetMaxChars: 300,
} as const
