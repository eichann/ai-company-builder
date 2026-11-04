/**
 * What running a skill leaves in its own folder: Python's bytecode, an `npm
 * install` of a skill's tool (tools:start), the desktop's own files. None of it
 * is the skill, and to the server all of it is a change to a skill file: a
 * member who may not change skills would be refused at every sync, and automatic
 * sync would stop and wait for them. So it stays on each computer: a managed
 * block of `.git/info/exclude`, unstaged if a shared negation re-included it.
 *
 * Only new files. One the company already shares stays an ordinary tracked
 * file, also for someone who may change skills: sharing a lock file is then a
 * `git add -f` or the file already being tracked.
 */
import { SKILL_FOLDER_NAMES, isSkillFile } from '../../shared/core/skill-files'

const LEFTOVER_FOLDERS: ReadonlySet<string> = new Set(['__pycache__', 'node_modules'])
const LEFTOVER_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'package-lock.json'])

/** .git/info/exclude lines (gitignore syntax; `**` also matches the company root and no folder at all). */
export const SKILL_LEFTOVER_PATTERNS: readonly string[] = SKILL_FOLDER_NAMES.flatMap(folder => [
  ...[...LEFTOVER_FOLDERS].map(name => `**/.claude/${folder}/**/${name}/`),
  ...[...LEFTOVER_FILES, '*.pyc'].map(name => `**/.claude/${folder}/**/${name}`),
])

export function isSkillLeftover(repoPath: string): boolean {
  if (!isSkillFile(repoPath)) return false
  const segments = repoPath.split('/')
  const name = segments[segments.length - 1]
  return LEFTOVER_FILES.has(name) || name.endsWith('.pyc') || segments.slice(0, -1).some(s => LEFTOVER_FOLDERS.has(s))
}
