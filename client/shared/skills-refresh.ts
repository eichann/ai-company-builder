/**
 * When the skills list must be re-read (main-process cache and renderer
 * refresh share these rules, see "Skills list freshness" in .claude/rules/files-and-editor.md).
 *
 * `skills:list` scans one of two things for a company root:
 *  - the company-wide view (department folder ''): `<root>/.claude/skills/`;
 *  - a department: every `.claude/skills/` at any depth (≤ 5) inside
 *    `<root>/<department>/`.
 * A skill's `isPrivate` comes from the root `.gitignore`.
 *
 * A watcher event affects the company-wide scan when it is at or under the
 * root `.claude/skills/` (or is the root `.claude` folder itself), and a
 * department scan when it is at or under any `.claude/skills/` inside that
 * department, or when a folder inside the department appeared or went away
 * (a folder moved in or out may carry skills; the watcher reports only the
 * folder). The root `.gitignore` affects every scan.
 */

export interface SkillsFileChange { type: string; path: string }

export interface SkillsScopes {
  /** Every scan of this root (the root .gitignore changed). */
  all: boolean
  /** The company-wide scan (`<root>/.claude/skills/`). */
  company: boolean
  /** Department scans, by the department's top-level folder (NFC). */
  folders: Set<string>
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').normalize('NFC').replace(/\/+$/, '')
}

/** The cache key of one scan: root + department folder ('' = company-wide). */
export function skillsCacheKey(rootPath: string, departmentFolder: string): string {
  return `${norm(rootPath)}::${norm(departmentFolder)}`
}

/** The top-level folder a department scan covers ('' for the company-wide scan). */
export function topFolderOf(departmentFolder: string): string {
  return norm(departmentFolder).split('/').filter(Boolean)[0] ?? ''
}

const STRUCTURAL = new Set(['addDir', 'unlinkDir', 'unlink'])

/** Which scans of `rootPath` these changes make stale; null when none. */
export function skillsScopesAffected(rootPath: string, changes: readonly SkillsFileChange[]): SkillsScopes | null {
  const root = norm(rootPath)
  const scopes: SkillsScopes = { all: false, company: false, folders: new Set() }
  let any = false
  for (const change of changes) {
    const p = norm(change.path)
    if (!p.startsWith(`${root}/`)) continue
    const segs = p.slice(root.length + 1).split('/').filter(Boolean)
    if (segs.length === 0) continue
    if (segs.length === 1 && segs[0] === '.gitignore') {
      scopes.all = true
      any = true
      continue
    }
    const i = segs.indexOf('.claude')
    if (i >= 0 && (segs.length === i + 1 || segs[i + 1] === 'skills')) {
      if (i === 0) scopes.company = true
      else scopes.folders.add(segs[0])
      any = true
      continue
    }
    // A folder (possibly holding skills) that appeared or went away inside a
    // department. `unlink` is ambiguous: a removed folder the watcher never
    // saw as one arrives as `unlink`.
    if (STRUCTURAL.has(change.type) && !segs[0].startsWith('.')) {
      scopes.folders.add(segs[0])
      any = true
    }
  }
  return any ? scopes : null
}

/** Does this change set make the scan of `departmentFolder` ('' = company-wide) stale? */
export function scanAffected(scopes: SkillsScopes | null, departmentFolder: string): boolean {
  if (!scopes) return false
  if (scopes.all) return true
  const top = topFolderOf(departmentFolder)
  return top === '' ? scopes.company : scopes.folders.has(top)
}

interface Entry<T> { root: string; folder: string; value: T; at: number }

/**
 * The main process's skills cache: a scan is reused for `ttlMs` (plain tab
 * switches), and dropped as soon as a watcher event makes it stale or the
 * renderer asks for a forced refresh.
 */
export class SkillsCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(rootPath: string, departmentFolder: string): T | undefined {
    const e = this.entries.get(skillsCacheKey(rootPath, departmentFolder))
    if (!e) return undefined
    if (this.now() - e.at >= this.ttlMs) return undefined
    return e.value
  }

  set(rootPath: string, departmentFolder: string, value: T): void {
    this.entries.set(skillsCacheKey(rootPath, departmentFolder), {
      root: norm(rootPath), folder: norm(departmentFolder), value, at: this.now(),
    })
  }

  /** Drop one scan, or every scan of the root when no folder is given. */
  invalidate(rootPath: string, departmentFolder?: string): void {
    if (departmentFolder !== undefined) {
      this.entries.delete(skillsCacheKey(rootPath, departmentFolder))
      return
    }
    const root = norm(rootPath)
    for (const [key, e] of this.entries) {
      if (e.root === root) this.entries.delete(key)
    }
  }

  /** Drop every scan these watcher events make stale. Returns how many were dropped. */
  invalidateForChanges(changes: readonly SkillsFileChange[]): number {
    let dropped = 0
    const roots = new Set([...this.entries.values()].map(e => e.root))
    for (const root of roots) {
      const scopes = skillsScopesAffected(root, changes)
      if (!scopes) continue
      for (const [key, e] of this.entries) {
        if (e.root === root && scanAffected(scopes, e.folder)) {
          this.entries.delete(key)
          dropped++
        }
      }
    }
    return dropped
  }

  get size(): number { return this.entries.size }
}
