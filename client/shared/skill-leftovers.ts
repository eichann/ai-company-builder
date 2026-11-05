/**
 * What running a skill leaves in its own folder. To the server all of it is a
 * change to a skill file, so a member who may not change skills would be refused
 * at every sync and automatic sync would stop and wait for them. It stays on each
 * computer through a managed block of `.git/info/exclude`, and is unstaged if a
 * shared negation re-included it. New files only: taking a tracked one out of the
 * index would delete it for everyone.
 *
 * Two kinds:
 * - leftovers, never part of a skill: Python's bytecode, dependencies, caches,
 *   the desktop's files, a tool's log (tools:start). Kept out for everyone.
 * - artifacts, part of a skill with a screen when someone who may share it says
 *   so: a lock file, a tool's `dist/` and `build/`. Kept out only for those who
 *   may not share that skill. For them they are ignored rather than left
 *   untracked, so a teammate's shared copy can still arrive.
 */
import { isSameOrAncestorPath, pathKey } from '../../shared/core/paths'
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { SKILL_FOLDER_NAMES, isSkillFile, type SkillEditing } from '../../shared/core/skill-files'

const LEFTOVER_FOLDERS: ReadonlySet<string> = new Set(['__pycache__', 'node_modules', '.venv', 'venv', '.next', '.nuxt', '.vite', '.cache'])
const LEFTOVER_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.tool-output.log'])
const ARTIFACT_FILES: ReadonlySet<string> = new Set(['package-lock.json'])
/** Only inside a skill's `tools/`: `dist/` may mean something else elsewhere. */
const TOOL_BUILD_FOLDERS: ReadonlySet<string> = new Set(['dist', 'build'])

/** Who may share what, as /me/capabilities says it. */
export interface SkillSharing {
  role: string
  managedFolders: readonly string[]
  skillEditing: SkillEditing
}

const inAnySkillFolder = (line: (folder: string) => string[]) => SKILL_FOLDER_NAMES.flatMap(line)

/** .git/info/exclude lines for everyone (gitignore syntax; `**` also matches no folder at all). */
export const SKILL_LEFTOVER_PATTERNS: readonly string[] = inAnySkillFolder(folder => [
  ...[...LEFTOVER_FOLDERS].map(name => `**/.claude/${folder}/**/${name}/`),
  ...[...LEFTOVER_FILES, '*.pyc'].map(name => `**/.claude/${folder}/**/${name}`),
])

function artifactLines(prefix: string): string[] {
  return inAnySkillFolder(folder => [
    ...[...ARTIFACT_FILES].map(name => `${prefix}.claude/${folder}/**/${name}`),
    ...[...TOOL_BUILD_FOLDERS].map(name => `${prefix}.claude/${folder}/**/tools/**/${name}/`),
  ])
}

/**
 * The block for this member, in a repository at `companyPath` of the company
 * ('' = the company repository; a private folder's clone otherwise).
 */
export function skillExcludeLines(sharing: SkillSharing, companyPath: string): string[] {
  const { role, managedFolders, skillEditing } = sharing
  if (FULL_ACCESS_ROLES.has(role) || skillEditing.everywhere) return [...SKILL_LEFTOVER_PATTERNS]
  const mine = [...managedFolders, ...skillEditing.folders]
  if (companyPath !== '' && mine.some(f => isSameOrAncestorPath(pathKey(f), pathKey(companyPath)))) return [...SKILL_LEFTOVER_PATTERNS]
  const artifacts = artifactLines('**/')
  // Later lines win: what is theirs to share is taken back out.
  const theirs = companyPath === '' ? mine.flatMap(f => artifactLines(`${f.replace(/[\\*?[\]!#]/g, '\\$&')}/**/`).map(l => `!${l}`)) : []
  return [...SKILL_LEFTOVER_PATTERNS, ...artifacts, ...theirs]
}

export function isSkillLeftover(repoPath: string): boolean {
  if (!isSkillFile(repoPath)) return false
  const segments = repoPath.split('/')
  const name = segments[segments.length - 1]
  return LEFTOVER_FILES.has(name) || name.endsWith('.pyc') || segments.slice(0, -1).some(s => LEFTOVER_FOLDERS.has(s))
}
