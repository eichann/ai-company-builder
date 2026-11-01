/**
 * Where the company map's indexer reads record files and type definitions
 * from: the shared branch of the company repository or of one private
 * folder's repository (adapters/record-files.ts, git only).
 */
export type RecordFileRepo = { kind: 'company' } | { kind: 'scope'; repoId: string }

export interface RecordFileChange {
  /** Path inside that repository. */
  path: string
  /** UTF-8 text; null when deleted (or too large to be a record). */
  text: string | null
}

export interface RecordRepoRead {
  /** The tip that was read; null when the repository has no shared branch. */
  tip: string | null
  /** true: `changes` lists every candidate file (anything not listed is gone). */
  full: boolean
  changes: RecordFileChange[]
}

/** The state engine's milestone line (4-3 duty 5), written as the server's own commit. */
export interface RecordFileWriter {
  /**
   * Append `line` to the 「経緯」 section of the file at `path` (inside `repo`)
   * on the shared branch, through the push checker. false: the file is gone.
   */
  appendHistoryLine(companyId: string, repo: RecordFileRepo, path: string, line: string): Promise<boolean>
  /** Whether `commit` exists in `repo` and holds a file at `path` (an attached version). */
  fileAtCommit(companyId: string, repo: RecordFileRepo, path: string, commit: string): Promise<boolean>
}

export interface RecordFileSource {
  /** Changes since `since` (a commit indexed before), or every candidate when null / unknown. */
  read(companyId: string, repo: RecordFileRepo, since: string | null): Promise<RecordRepoRead>
}
