/**
 * What running a skill leaves in its own folder: Python's bytecode, virtual
 * environments, an `npm install` of a skill's tool (tools:start) and what the
 * tool builds, the desktop's own files. None of it
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

const LEFTOVER_FOLDERS: ReadonlySet<string> = new Set(['__pycache__', 'node_modules', '.venv', 'venv', '.next', '.nuxt', '.vite', '.cache'])
/** Only inside a skill's `tools/`: a tool builds from its source, and `dist/` may mean something else elsewhere. */
const TOOL_BUILD_FOLDERS: ReadonlySet<string> = new Set(['dist', 'build'])
const LEFTOVER_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'package-lock.json'])

/** .git/info/exclude lines (gitignore syntax; `**` also matches the company root and no folder at all). */
export const SKILL_LEFTOVER_PATTERNS: readonly string[] = SKILL_FOLDER_NAMES.flatMap(folder => [
  ...[...LEFTOVER_FOLDERS].map(name => `**/.claude/${folder}/**/${name}/`),
  ...[...LEFTOVER_FILES, '*.pyc'].map(name => `**/.claude/${folder}/**/${name}`),
  ...[...TOOL_BUILD_FOLDERS].map(name => `**/.claude/${folder}/**/tools/**/${name}/`),
])

export function isSkillLeftover(repoPath: string): boolean {
  if (!isSkillFile(repoPath)) return false
  const segments = repoPath.split('/')
  const name = segments[segments.length - 1]
  const folders = segments.slice(0, -1)
  const tools = folders.lastIndexOf('tools')
  return LEFTOVER_FILES.has(name) || name.endsWith('.pyc') || folders.some(s => LEFTOVER_FOLDERS.has(s))
    || (tools >= 0 && folders.slice(tools + 1).some(s => TOOL_BUILD_FOLDERS.has(s)))
}
