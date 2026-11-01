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

/** A file renamed or moved (git's rename detection), paths inside that repository. */
export interface RecordFileRename {
  from: string
  to: string
}

export interface RecordRepoRead {
  /** The tip that was read; null when the repository has no shared branch. */
  tip: string | null
  /** true: `changes` lists every candidate file (anything not listed is gone). */
  full: boolean
  changes: RecordFileChange[]
  /** Files renamed or moved since the commit read last (links follow them); none on a full read. */
  renames: RecordFileRename[]
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
  /**
   * Which of `paths` (inside `repo`) exist on its shared branch now, as a file
   * or a folder; null when that cannot be told (no repository, git failed).
   */
  existing(companyId: string, repo: RecordFileRepo, paths: string[]): Promise<Set<string> | null>
}

/** A record file the server itself writes (decisions, records.md), as its own commit through the push checker. */
export interface RecordFileCreator {
  /**
   * Add the file at `path` (company repository, shared branch) with `text`.
   * false: a file is already there (nothing written). Throws when the commit
   * is refused or times out.
   */
  createFile(companyId: string, path: string, text: string, message: string): Promise<boolean>
}
