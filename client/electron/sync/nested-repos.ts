import fs from 'fs'
import path from 'path'

/**
 * Walk the repo tree and return relative paths of any nested Git repositories
 * (i.e. directories that contain their own .git/ — either a directory or a "gitdir" file for worktrees).
 * Excludes the root repo itself, common heavy/irrelevant dirs, and stops descending into a nested repo
 * once found (so deeply-nested external repos are reported only at their topmost level).
 */
export async function findNestedGitRepos(rootPath: string): Promise<string[]> {
  const SKIP_DIRS = new Set(['node_modules', '.backups', '.next', '.nuxt', 'dist', '__pycache__', '.venv', 'venv', '.workspace'])
  const results: string[] = []

  async function walk(dir: string, relativePath: string): Promise<void> {
    if (relativePath !== '') {
      const dotGitPath = path.join(dir, '.git')
      try {
        await fs.promises.access(dotGitPath)
        // Either a .git directory (real repo) or a .git file (worktree/submodule pointer).
        results.push(relativePath)
        return
      } catch {
        // not a nested repo, continue walking
      }
    }

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      // Skip the root repo's own .git
      if (relativePath === '' && entry.name === '.git') continue

      const childDir = path.join(dir, entry.name)
      const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name
      await walk(childDir, childRel)
    }
  }

  await walk(rootPath, '')
  return results
}
