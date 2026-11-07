// Skills in the company folder: the scan behind the skills list (company
// root → 全社, each department and its nested folders → groups), cached for
// plain tab switches, and the three edits the UI makes (publish / keep
// private on this computer through .git/info/exclude — older apps used the
// shared root .gitignore, still honoured —, the 育成中 status in SKILL.md).
//   skills:list, skills:publish, skills:makePrivate, skills:toggleNurturing

import fs from 'fs'
import path from 'path'
import { parseFrontmatter } from '../../../shared/skill-frontmatter'
import { SkillsCache } from '../../../shared/skills-refresh'
import type { FileChange } from '../../company-watcher'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { SkillShelfMark } from '../../../shared/skill-shelf'
import type { PathGuard } from '../ports'
import { readLocalPrivateSkills, removeSharedLines, setLocalPrivateSkill } from '../../sync/local-ignores'

// Tool (Web app) info
interface ToolInfo {
  name: string           // Folder name
  displayName: string    // From package.json or folder name
  path: string           // Absolute path
  hasPackageJson: boolean
  startCommand?: string  // "dev" or "start"
}

// Skills listing handler
interface SkillInfo {
  id: string
  name: string
  description: string
  departmentId: string
  skillPath: string
  group: string
  isPrivate?: boolean
  isNurturing?: boolean
  shelf?: SkillShelfMark
  files: {
    skillMd: string
    rules?: string[]
    references?: string[]
    scripts?: string[]
    tools?: ToolInfo[]
  }
}

// The SKILL.md frontmatter (YAML; client/shared/skill-frontmatter.ts reads quoted and block values too).
function parseSkillFrontmatter(content: string): { name?: string; description?: string; status?: string } {
  const fields = parseFrontmatter(content)
  const text = (v: string | undefined) => (v === undefined ? undefined : v.trim() || undefined)
  return { name: text(fields.name), description: text(fields.description), status: text(fields.status) }
}

/**
 * Recursively find all directories containing `.claude/skills/` under a base directory.
 * Returns array of { skillsDir, relativePath } where relativePath is relative to baseDir.
 */
async function findSkillsDirs(baseDir: string, maxDepth = 5): Promise<{ skillsDir: string; relativePath: string }[]> {
  const results: { skillsDir: string; relativePath: string }[] = []
  const SKIP_DIRS = new Set(['.git', '.claude', '.backups', 'node_modules', '.next', 'dist', 'build', '__pycache__'])

  async function walk(dir: string, relPath: string, depth: number) {
    if (depth > maxDepth) return

    // Check if this directory has .claude/skills/
    const skillsDir = path.join(dir, '.claude', 'skills')
    if (fs.existsSync(skillsDir)) {
      results.push({ skillsDir, relativePath: relPath })
    }

    // Recurse into subdirectories
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name), relPath ? `${relPath}/${entry.name}` : entry.name, depth + 1)
      }
    } catch {
      // Ignore permission/readdir errors
    }
  }

  await walk(baseDir, '', 0)
  return results
}

export const INVALID_DEPARTMENT_FOLDER = 'Invalid department folder'

export interface SkillsDeps {
  paths: PathGuard
  /**
   * Whether anything under `relFolder` (company-relative, ends with '/') is
   * already shared: in the index or on the server's branch. A .gitignore line
   * does not stop git from sharing tracked files, so such a skill cannot be
   * made private. Unknown (no repository, git failed) → false.
   */
  isShared: (rootPath: string, relFolder: string) => Promise<boolean>
  /** The sentence when the member may not change this skill file (`sharing`: not even one they keep private); null to allow. */
  skillRefusal: (absPath: string, options?: { sharing?: boolean }) => Promise<string | null>
  /**
   * The working folder of a company without the shared folder (services/working-folders.ts):
   * every skill there is the member's own and nothing is shared, so making one private is
   * already true and publishing has nowhere to go.
   */
  isWorkingFolder?: (rootPath: string) => boolean
  /** In a working folder: what the Skill shelf says of the Skill folder at `rel` (client/shared/skill-shelf.ts). */
  shelfMark?: (rootPath: string, rel: string) => SkillShelfMark | undefined
}

/** skills:publish in a company without the shared folder. */
export const SKILL_NOT_SHARED_HERE = 'この会社では、スキルはこの PC の中だけで使われます（ほかの人には共有されません）。'

/** skills:makePrivate on a skill the company already has. */
export const SKILL_ALREADY_SHARED = 'このスキルはすでに会社で共有されているため、非公開にはできません。'

export interface SkillsFeature {
  /** A skill the AI (or anything else) created, changed or removed is scanned afresh by the next skills:list. */
  invalidateForChanges(changes: FileChange[]): void
  /** Every scan of this folder is stale (what the Skill shelf says of its Skills changed). */
  invalidateRoot(rootPath: string): void
}

export function registerSkillsIpc(ipc: IpcRegistrar, { paths, isShared, skillRefusal, isWorkingFolder, shelfMark }: SkillsDeps): SkillsFeature {
  // Skills scans (skills:list), reused for plain tab switches (5 s) and dropped
  // as soon as a watcher event makes them stale (invalidateForChanges) or the
  // renderer forces a refresh. Keys and staleness rules: shared/skills-refresh.ts.
  const skillsCache = new SkillsCache<SkillInfo[]>(5000)

  // Gitignore cache per rootPath to avoid repeated file reads
  const gitignoreCache = new Map<string, { lines: string[]; mtime: number }>()

  function getSharedGitignoreLines(rootPath: string): string[] {
    const gitignorePath = path.join(rootPath, '.gitignore')
    try {
      if (!fs.existsSync(gitignorePath)) return []
      const stat = fs.statSync(gitignorePath)
      const cached = gitignoreCache.get(rootPath)
      if (cached && cached.mtime === stat.mtimeMs) return cached.lines
      const content = fs.readFileSync(gitignorePath, 'utf-8')
      const lines = content.split('\n').map(l => l.trim())
      gitignoreCache.set(rootPath, { lines, mtime: stat.mtimeMs })
      return lines
    } catch {
      return []
    }
  }

  /** Private-skill lines: this computer's (.git/info/exclude) and those older apps put in the shared .gitignore. */
  function getGitignoreLines(rootPath: string): string[] {
    return [...readLocalPrivateSkills(rootPath), ...getSharedGitignoreLines(rootPath)]
  }

  /** The company folder's .git/info/exclude, refused when .git is not a folder in it (or links out). */
  function localExcludeOf(rootPath: string): void {
    const gitDir = path.join(rootPath, '.git')
    let isDir = false
    try { isDir = fs.lstatSync(gitDir).isDirectory() } catch { /* missing */ }
    if (!isDir) throw new Error('Not a company folder')
    const infoDir = path.join(gitDir, 'info')
    if (fs.existsSync(infoDir)) paths.validate(infoDir)
    const exclude = path.join(infoDir, 'exclude')
    if (fs.existsSync(exclude)) paths.validate(exclude)
  }

  function invalidateGitignoreCache(rootPath: string): void {
    gitignoreCache.delete(rootPath)
  }

  function invalidateSkillsCache(rootPath: string, departmentFolder?: string): void {
    skillsCache.invalidate(rootPath, departmentFolder)
  }

  /** Scan a single .claude/skills/ directory and return SkillInfo[] */
  async function scanSkillsInDir(
    skillsDir: string,
    rootPath: string,
    departmentId: string,
    group: string,
    gitignoreRelativePrefix: string,
  ): Promise<SkillInfo[]> {
    if (!fs.existsSync(skillsDir)) return []

    const gitignoreLines = getGitignoreLines(rootPath)
    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    const skills: SkillInfo[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue

      const skillPath = path.join(skillsDir, entry.name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')

      if (!fs.existsSync(skillMdPath)) continue

      try {
        const skillMdContent = await fs.promises.readFile(skillMdPath, 'utf-8')
        const frontmatter = parseSkillFrontmatter(skillMdContent)

        const rulesDir = path.join(skillPath, 'rules')
        const scriptsDir = path.join(skillPath, 'scripts')
        const referencesDir = path.join(skillPath, 'references')

        const files: SkillInfo['files'] = { skillMd: skillMdPath }

        if (fs.existsSync(rulesDir)) {
          const rulesEntries = await fs.promises.readdir(rulesDir)
          files.rules = rulesEntries.filter(f => f.endsWith('.md')).map(f => path.join(rulesDir, f))
        }

        if (fs.existsSync(scriptsDir)) {
          const scriptsEntries = await fs.promises.readdir(scriptsDir)
          files.scripts = scriptsEntries.filter(f => !f.startsWith('.')).map(f => path.join(scriptsDir, f))
        }

        if (fs.existsSync(referencesDir)) {
          const refsEntries = await fs.promises.readdir(referencesDir)
          files.references = refsEntries.filter(f => !f.startsWith('.')).map(f => path.join(referencesDir, f))
        }

        const toolsDir = path.join(skillPath, 'tools')
        if (fs.existsSync(toolsDir)) {
          const toolsEntries = await fs.promises.readdir(toolsDir, { withFileTypes: true })
          const tools: ToolInfo[] = []

          for (const toolEntry of toolsEntries) {
            if (!toolEntry.isDirectory()) continue
            if (toolEntry.name.startsWith('.')) continue
            if (toolEntry.name === 'node_modules') continue

            const toolEntryPath = path.join(toolsDir, toolEntry.name)
            const packageJsonPath = path.join(toolEntryPath, 'package.json')
            const hasPackageJson = fs.existsSync(packageJsonPath)

            let displayName = toolEntry.name
            let startCommand: string | undefined

            if (hasPackageJson) {
              try {
                const pkgContent = await fs.promises.readFile(packageJsonPath, 'utf-8')
                const pkg = JSON.parse(pkgContent)
                displayName = pkg.name || toolEntry.name
                if (pkg.scripts?.dev) {
                  startCommand = 'dev'
                } else if (pkg.scripts?.start) {
                  startCommand = 'start'
                }
              } catch {
                // Ignore package.json parse errors
              }
            }

            tools.push({
              name: toolEntry.name,
              displayName,
              path: toolEntryPath,
              hasPackageJson,
              startCommand,
            })
          }

          if (tools.length > 0) files.tools = tools
        }

        const skillRelativePath = `${gitignoreRelativePrefix}.claude/skills/${entry.name}/`
        const isPrivate = gitignoreLines.some(line => line === skillRelativePath)
        const shelf = shelfMark?.(rootPath, skillRelativePath.slice(0, -1))

        skills.push({
          id: `${departmentId}-${group.replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-').toLowerCase()}-${entry.name}`,
          name: frontmatter.name || entry.name,
          description: frontmatter.description || '',
          departmentId,
          skillPath,
          group,
          isPrivate,
          isNurturing: frontmatter.status === 'nurturing',
          ...(shelf ? { shelf } : {}),
          files,
        })
      } catch (err) {
        console.error(`Failed to parse skill ${entry.name}:`, err)
      }
    }

    return skills
  }

  /**
   * Scan skills across hierarchy:
   * 1. Company root: {rootPath}/.claude/skills/ → group "全社"
   * 2. Department + nested: {rootPath}/{dept}/**\/.claude/skills/ → group "{deptName}" or "{deptName} / {path}"
   */
  async function scanSkills(rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string): Promise<SkillInfo[]> {
    const deptDisplayName = departmentName || departmentFolder
    const allSkills: SkillInfo[] = []

    // Level 1: Company root (.claude/skills/) — only when company-wide tab
    if (!departmentFolder) {
      const rootSkillsDir = path.join(rootPath, '.claude', 'skills')
      const rootSkills = await scanSkillsInDir(rootSkillsDir, rootPath, departmentId, '全社', '')
      allSkills.push(...rootSkills)
    }

    // Level 2+: Department and all nested subdirectories (skip when company-wide)
    if (departmentFolder) {
      const deptDir = path.join(rootPath, departmentFolder)
      if (fs.existsSync(deptDir)) {
        const found = await findSkillsDirs(deptDir)
        for (const { skillsDir, relativePath } of found) {
          const groupName = relativePath
            ? `${deptDisplayName} / ${relativePath.split('/').pop()}`
            : deptDisplayName
          const gitignorePrefix = relativePath
            ? `${departmentFolder}/${relativePath}/`
            : `${departmentFolder}/`
          const skills = await scanSkillsInDir(skillsDir, rootPath, departmentId, groupName, gitignorePrefix)
          allSkills.push(...skills)
        }
      }
    }

    return allSkills
  }

  // List skills for a department (scans 3 hierarchy levels)
  /**
   * The department folder the scan walks: a relative path inside the (already
   * checked) company root — no absolute path, no `..`, no NUL — whose joined
   * path also passes the allowed-roots check (real location) and stays under
   * this root (not a sibling company that happens to be registered too).
   */
  function checkedDepartmentDir(root: string, departmentFolder: unknown): string {
    if (typeof departmentFolder !== 'string' || departmentFolder.includes('\0') || path.isAbsolute(departmentFolder)
      || path.win32.isAbsolute(departmentFolder) || departmentFolder.split(/[\\/]/).includes('..')) {
      throw new Error(INVALID_DEPARTMENT_FOLDER)
    }
    const dir = paths.validate(path.join(root, departmentFolder))
    if (!dir.startsWith(root + path.sep)) throw new Error(INVALID_DEPARTMENT_FOLDER)
    return dir
  }

  ipc.handle('skills:list', async (_, rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string, options?: { force?: boolean }) => {
    try {
      rootPath = paths.validate(rootPath)
      if (departmentFolder) checkedDepartmentDir(rootPath, departmentFolder)
      // A forced refresh (watcher event, sync, the member's own change) rescans.
      if (options?.force) invalidateSkillsCache(rootPath, departmentFolder)
      const cached = skillsCache.get(rootPath, departmentFolder)
      if (cached) return { success: true, skills: cached }

      const skills = await scanSkills(rootPath, departmentFolder, departmentId, departmentName)
      skillsCache.set(rootPath, departmentFolder, skills)

      return { success: true, skills }
    } catch (error) {
      console.error('Skills list error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error', skills: [] }
    }
  })

  /** A skill folder as a .gitignore line: one line, never a way to add others. */
  function skillGitignoreEntry(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error('Invalid skill path')
    return value
  }

  // Publish a skill (one-way / irreversible): its line leaves this computer's
  // .git/info/exclude and, when an older app put it there, the shared .gitignore.
  ipc.handle('skills:publish', async (_, rootPath: string, skillRelativePath: string) => {
    try {
      rootPath = paths.validate(rootPath)
      skillGitignoreEntry(skillRelativePath)
      if (isWorkingFolder?.(rootPath)) return { success: false, error: SKILL_NOT_SHARED_HERE, code: 'refused' as const }
      // Asked before the line goes: refused at sync, the skill would move to .backups/.
      const refused = await skillRefusal(path.join(rootPath, skillRelativePath), { sharing: true })
      if (refused) return { success: false, error: refused, code: 'refused' as const }
      if (fs.existsSync(path.join(rootPath, '.git'))) {
        localExcludeOf(rootPath)
        setLocalPrivateSkill(rootPath, skillRelativePath, false)
      }
      const gitignorePath = paths.validate(path.join(rootPath, '.gitignore'))
      if (fs.existsSync(gitignorePath)) {
        const lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n')
        if (lines.some(l => l.trim() === skillRelativePath)) {
          fs.writeFileSync(gitignorePath, removeSharedLines(lines.map(l => (l.trim() === skillRelativePath ? skillRelativePath : l)), new Set([skillRelativePath])).join('\n'))
        }
      }
      invalidateGitignoreCache(rootPath)
      invalidateSkillsCache(rootPath)
      return { success: true }
    } catch (error) {
      console.error('Publish skill error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Keep a new skill on this computer (used when creating one): a line in
  // .git/info/exclude, never the shared .gitignore (every teammate's skill of
  // that name would stop syncing, and only admins should change that file).
  // Never for a skill the company already has: the line would not stop sync
  // from sharing it, and the app would show 「非公開」 for something everyone gets.
  ipc.handle('skills:makePrivate', async (_, rootPath: string, skillRelativePath: string) => {
    try {
      rootPath = paths.validate(rootPath)
      skillGitignoreEntry(skillRelativePath)
      // Nothing in a working folder is shared: the skill is the member's own already (no .git to write).
      if (isWorkingFolder?.(rootPath)) return { success: true }
      if (await isShared(rootPath, skillRelativePath)) return { success: false, error: SKILL_ALREADY_SHARED, code: 'already_shared' as const }
      localExcludeOf(rootPath)
      if (setLocalPrivateSkill(rootPath, skillRelativePath, true)) invalidateSkillsCache(rootPath)
      return { success: true }
    } catch (error) {
      console.error('Make private error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Toggle nurturing status in SKILL.md frontmatter
  ipc.handle('skills:toggleNurturing', async (_, unsafeSkillMdPath: string, makeNurturing: boolean) => {
    try {
      const skillMdPath = paths.validate(unsafeSkillMdPath)
      if (path.basename(skillMdPath) !== 'SKILL.md') return { success: false, error: 'Not a SKILL.md' }
      if (!fs.existsSync(skillMdPath)) {
        return { success: false, error: 'SKILL.md not found' }
      }
      const refused = await skillRefusal(skillMdPath)
      if (refused) return { success: false, error: refused, code: 'refused' as const }

      let content = fs.readFileSync(skillMdPath, 'utf-8')
      const frontmatterMatch = content.match(/^(---\n)([\s\S]*?)\n(---)/)
      if (!frontmatterMatch) {
        return { success: false, error: 'No frontmatter found' }
      }

      const [fullMatch, opening, body, closing] = frontmatterMatch
      const lines = body.split('\n')

      if (makeNurturing) {
        // Add status: nurturing if not present
        const statusIndex = lines.findIndex(l => /^status:/.test(l))
        if (statusIndex >= 0) {
          lines[statusIndex] = 'status: nurturing'
        } else {
          lines.push('status: nurturing')
        }
      } else {
        // Remove status line
        const filtered = lines.filter(l => !/^status:/.test(l))
        lines.length = 0
        lines.push(...filtered)
      }

      const newFrontmatter = `${opening}${lines.join('\n')}\n${closing}`
      content = content.replace(fullMatch, newFrontmatter)
      fs.writeFileSync(skillMdPath, content)
      return { success: true }
    } catch (error) {
      console.error('Toggle nurturing error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  return { invalidateForChanges: changes => skillsCache.invalidateForChanges(changes), invalidateRoot: rootPath => invalidateSkillsCache(rootPath) }
}
