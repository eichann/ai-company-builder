/**
 * AI instruction files — CLAUDE.md, CLAUDE.local.md, AGENTS.md at any depth,
 * A–Z case-insensitive. Claude Code / Codex load them into every chat in or
 * below their folder, so whoever writes one steers every teammate's AI there.
 * Owner/admin may change them anywhere; a department manager inside a
 * department folder they manage (any depth; root-level ones owner/admin
 * only — owner decision 案B). Anyone else is refused: by the push check
 * ([PROTECTED_CONFIG]) and, ahead of time, by the desktop app's chat guard.
 *
 * The push checker matches git's raw bytes (read as latin1) with a regex
 * built from INSTRUCTION_FILE_NAMES (server/src/lib/push-check/rules.ts); the
 * names are ASCII, so that bytewise match and isInstructionFile agree.
 *
 * Pure: no Node, Electron, React, Hono, database or git.
 */
import { FULL_ACCESS_ROLES } from './permissions'
import { foldAsciiCase, pathKey } from './paths'

/** CLAUDE.local.md is personal by convention, but once shared it is loaded like CLAUDE.md for everyone. */
export const INSTRUCTION_FILE_NAMES: readonly string[] = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']

const FOLDED_NAMES = new Set(INSTRUCTION_FILE_NAMES.map(foldAsciiCase))

/** CLAUDE.md / CLAUDE.local.md / AGENTS.md at any depth, A–Z case-insensitive. */
export function isInstructionFile(repoPath: string): boolean {
  const name = repoPath.normalize('NFC').split('/').pop() ?? ''
  return FOLDED_NAMES.has(foldAsciiCase(name))
}

/**
 * Does the instruction file at `path` lie inside one of `managedFolders`
 * (company paths of the department folders the member manages)? Any depth,
 * compared as pathKey()s; a root-level file never.
 */
export function instructionFileInManagedFolder(path: string, managedFolders: readonly string[]): boolean {
  if (managedFolders.length === 0) return false
  const key = pathKey(path)
  return managedFolders.some((f) => {
    const folder = pathKey(f)
    return folder !== '' && key.startsWith(`${folder}/`)
  })
}

/** May a member with `role` who manages `managedFolders` change the instruction file at `path`? */
export function mayChangeInstructionFile(authority: { role: string; managedFolders: readonly string[] }, path: string): boolean {
  if (FULL_ACCESS_ROLES.has(authority.role)) return true
  return instructionFileInManagedFolder(path, authority.managedFolders)
}
