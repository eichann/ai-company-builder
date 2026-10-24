/**
 * An open text file against the file on disk (TabbedEditorPanel; see
 * "External changes to open files" in .claude/rules/files-and-editor.md).
 *
 * `originalContent` is the disk version the tab last loaded or saved. A tab
 * with no edits follows the disk (the AI's edit, a sync pull). A tab with
 * edits never silently loses either side: a disk change shows a banner and
 * pauses autosave, and a save whose disk version is no longer the one the tab
 * loaded asks first — and backs the disk version up before overwriting it.
 */

export type ExternalChange =
  | { kind: 'changed'; diskContent: string }
  | { kind: 'deleted' }

export interface EditorFileState {
  content: string
  originalContent: string
  /** The file is gone on disk (shown read from memory). */
  missing?: boolean
  /** Set only while the tab has edits: what happened on disk meanwhile. */
  external?: ExternalChange
}

export function isDirty(file: Pick<EditorFileState, 'content' | 'originalContent'>): boolean {
  return file.content !== file.originalContent
}

export type DiskEventDecision =
  /** Nothing to do. */
  | { action: 'none' }
  /** No edits: show the disk version. */
  | { action: 'reload'; content: string }
  /** No edits, file gone: keep showing it, marked deleted. */
  | { action: 'mark-missing' }
  /** Edits + a different disk version (or the file is gone): banner, autosave paused. */
  | { action: 'conflict'; external: ExternalChange }
  /** Edits, and the disk is back at the version the tab loaded: no conflict any more. */
  | { action: 'clear' }
  /** The disk now holds exactly the tab's edits: they are saved. */
  | { action: 'adopt'; content: string }

/** What a watcher event means for an open tab; `disk` = the file now (null = gone). */
export function decideOnDiskEvent(file: EditorFileState, disk: string | null): DiskEventDecision {
  if (!isDirty(file)) {
    if (disk === null) return file.missing ? { action: 'none' } : { action: 'mark-missing' }
    if (disk === file.originalContent && !file.missing) return { action: 'none' }
    return { action: 'reload', content: disk }
  }
  if (disk === null) {
    return file.external?.kind === 'deleted' ? { action: 'none' } : { action: 'conflict', external: { kind: 'deleted' } }
  }
  if (disk === file.content) return { action: 'adopt', content: disk }
  if (disk === file.originalContent) {
    return file.external || file.missing ? { action: 'clear' } : { action: 'none' }
  }
  if (file.external?.kind === 'changed' && file.external.diskContent === disk) return { action: 'none' }
  return { action: 'conflict', external: { kind: 'changed', diskContent: disk } }
}

/** Apply a decision to the tab state (pure). */
export function applyDiskDecision<T extends EditorFileState>(file: T, decision: DiskEventDecision): T {
  switch (decision.action) {
    case 'none': return file
    case 'reload': return { ...file, content: decision.content, originalContent: decision.content, missing: false, external: undefined }
    case 'mark-missing': return { ...file, missing: true }
    case 'conflict': return { ...file, external: decision.external, missing: decision.external.kind === 'deleted' }
    case 'clear': return { ...file, external: undefined, missing: false }
    case 'adopt': return { ...file, originalContent: decision.content, missing: false, external: undefined }
  }
}

export type SaveDecision =
  /** The disk is still the version the tab loaded (or gone: saving recreates it). */
  | { action: 'write'; recreate: boolean }
  /** The disk already holds the tab's edits. */
  | { action: 'already-saved' }
  /** Someone else changed the file since the tab loaded it: ask, back up, then overwrite. */
  | { action: 'ask'; diskContent: string }

/** Before writing: compare the disk (`disk`, null = gone) with what the tab loaded. */
export function decideSave(file: EditorFileState, disk: string | null): SaveDecision {
  if (disk === null) return { action: 'write', recreate: true }
  if (disk === file.content) return { action: 'already-saved' }
  if (disk === file.originalContent) return { action: 'write', recreate: false }
  return { action: 'ask', diskContent: disk }
}

/** Autosave runs only for a tab with edits and nothing unresolved on disk. */
export function canAutosave(file: EditorFileState): boolean {
  return isDirty(file) && !file.external
}

// ---------------------------------------------------------------------------
// Backup of the disk version before the member overwrites it
// ---------------------------------------------------------------------------

export const EDITOR_OVERWRITE_REASON = 'editor_overwrite'

export interface EditorOverwriteBackupMetadata {
  timestamp: string
  reason: typeof EDITOR_OVERWRITE_REASON
  /** Company-relative path of the file that was overwritten. */
  files: string[]
  /** True when kept in .git/acb-private-backups (the file is in a private folder). */
  privateFolder: boolean
}

export type EditorOverwriteBackupPlan =
  | {
      /** Where the backup folder lives, relative to the company root. */
      base: '.backups' | '.git/acb-private-backups'
      /** `<timestamp>_editor_overwrite` */
      folder: string
      /** Company-relative path (forward slashes), also the path inside the backup folder. */
      rel: string
      privateFolder: boolean
    }
  | { skip: 'outside-company' | 'internal' }

function cleanRel(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.').join('/')
}

function atOrUnder(folder: string, rel: string): boolean {
  const f = cleanRel(folder).normalize('NFC').toLowerCase()
  const r = rel.normalize('NFC').toLowerCase()
  return f !== '' && (r === f || r.startsWith(`${f}/`))
}

/** The backup folder name: same timestamp style as sync's backups. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 23)
}

/**
 * Where to keep the disk version of `filePath` before the member overwrites
 * it. Never inside a private folder's working tree (it would be committed to
 * that folder's repository, or, at .backups/, reach the company): files in a
 * readable private folder — known from the cached /me/scopes answer, or by a
 * nested repository between the file and the company root — go to
 * `.git/acb-private-backups/`, like sync's private backups.
 */
export function editorOverwriteBackupPlan(args: {
  rootPath: string
  filePath: string
  /** Company-relative paths of the member's readable private folders. */
  privateFolders: readonly string[]
  /** A folder between the file and the root holds its own `.git`. */
  insideNestedRepo: boolean
  now: Date
}): EditorOverwriteBackupPlan {
  const root = args.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = args.filePath.replace(/\\/g, '/')
  if (!file.startsWith(`${root}/`)) return { skip: 'outside-company' }
  const rel = cleanRel(file.slice(root.length + 1))
  if (!rel || rel.split('/').includes('..')) return { skip: 'outside-company' }
  const first = rel.split('/')[0].toLowerCase()
  if (first === '.git' || first === '.backups') return { skip: 'internal' }
  const privateFolder = args.insideNestedRepo || args.privateFolders.some(f => atOrUnder(f, rel))
  return {
    base: privateFolder ? '.git/acb-private-backups' : '.backups',
    folder: `${backupStamp(args.now)}_${EDITOR_OVERWRITE_REASON}`,
    rel,
    privateFolder,
  }
}
