/**
 * The server's own copy of a company's Skills for 「Skill の承認」 (ports/browser-skills.ts `BrowserSkillSource`,
 * agent-browser.md "A Skill's browser declaration and its approval", "Department Skills"): the shared branch of the
 * company repository for a company with the shared folder (git, async: server.md "Async only"), the Skill shelf's current
 * version for one without. Never what an app sent.
 *
 * Where (shared/core/browser-skill.ts `parseBrowserSkillPath`): the company's `.claude/skills/<name>` and each
 * department's `<department>/.claude/skills/<name>` (a shelf item with no department, or with one) — what Claude Code
 * reads for a consultation working in the company folder or a department's. **Never a private folder's**: its files live
 * in its own scope repository, which nothing here reads, and a path at or under a private folder's is left out even if
 * the company repository ever held one (its name must not leak).
 */
import { existsSync } from 'fs'
import { BROWSER_SKILL_FILE, BROWSER_SKILL_LIMITS, browserSkillPathOf, parseBrowserSkillPath, type BrowserSkillPlace } from '../../shared/core/browser-skill'
import { isValidFolderName } from '../../shared/core/names'
import { isSameOrAncestorPath, pathKey } from '../../shared/core/paths'
import { companyRepoPath } from '../lib/config'
import { gitAsync } from '../lib/git-exec'
import { resolveSharedBranch } from '../lib/repo-folders'
import type { BrowserSkillContent, BrowserSkillLanded, BrowserSkillSource } from '../ports/browser-skills'
import type { CompanyDataSource } from '../ports/company-data'

const SKILLS = '.claude/skills'
const OBJECT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ZERO_RE = /^0+$/
/** The most Skills one company lists, and one push is looked at for. */
const MAX_SKILLS = 100
/** The most top-level folders looked into for department Skills. */
const MAX_FOLDERS = 500
const GIT = { timeoutMs: 30_000 }

/** The object id of `path` at `treeish` when it is of `type`, or null. */
async function entryOf(repo: string, treeish: string, path: string, type: 'tree' | 'blob'): Promise<string | null> {
  try {
    const out = (await gitAsync(['-C', repo, 'ls-tree', '-z', treeish, '--', path], GIT)).split('\0')[0]
    const [meta, found] = out.split('\t')
    const [, kind, object] = (meta ?? '').split(' ')
    return kind === type && found === path && OBJECT_RE.test(object ?? '') ? object : null
  } catch {
    return null
  }
}

/** A blob's text when it is at most the declaration's limit, else `too-large` (null: no such blob or unreadable). */
async function blobText(repo: string, blob: string): Promise<string | null> {
  try {
    const size = Number((await gitAsync(['-C', repo, 'cat-file', '-s', blob], GIT)).trim())
    if (!Number.isFinite(size)) return null
    return size > BROWSER_SKILL_LIMITS.bytes ? 'too-large' : await gitAsync(['-C', repo, 'cat-file', 'blob', blob], GIT)
  } catch {
    return null
  }
}

/** Is `path` at or under one of the private folders (compared as the core names a place)? */
function insidePrivate(privatePaths: readonly string[], path: string): boolean {
  const key = pathKey(path)
  return privatePaths.some(p => isSameOrAncestorPath(pathKey(p), key))
}

/** One Skill at `treeish` (a commit or the shared branch), or null. */
async function readAt(repo: string, treeish: string, place: BrowserSkillPlace): Promise<BrowserSkillContent | null> {
  const tree = await entryOf(repo, treeish, place.path, 'tree')
  if (!tree) return null
  const blob = await entryOf(repo, tree, BROWSER_SKILL_FILE, 'blob')
  if (!blob) return null
  const declaration = await blobText(repo, blob)
  return declaration === null ? null : { path: place.path, declaration, files: `git:${tree}` }
}

/**
 * The pathspecs of every place a browser Skill may stand at `treeishes`: the company's `.claude/skills/` and each
 * top-level folder's (one level only; a name that is no department folder name is not looked into).
 */
async function skillPathspecs(repo: string, treeishes: readonly string[]): Promise<string[]> {
  const folders = new Set<string>()
  for (const treeish of treeishes) {
    const out = await gitAsync(['-C', repo, 'ls-tree', '-z', '-d', treeish], GIT)
    for (const entry of out.split('\0')) {
      const tab = entry.indexOf('\t')
      if (tab < 0) continue
      const name = entry.slice(tab + 1)
      if (isValidFolderName(name) && name.normalize('NFC') === name) folders.add(name)
    }
  }
  return [`${SKILLS}/`, ...[...folders].sort().slice(0, MAX_FOLDERS).map(f => `${f}/${SKILLS}/`)]
}

/** The Skill places among paths (relative to the repository root): a file directly in a Skill folder, or deeper. */
function placesIn(paths: string[], onlyWithDeclaration: boolean, privatePaths: readonly string[]): BrowserSkillPlace[] {
  const out = new Map<string, BrowserSkillPlace>()
  for (const p of paths) {
    const at = p.indexOf(`${SKILLS}/`)
    if (at !== 0 && (at < 0 || p[at - 1] !== '/')) continue
    const rest = p.slice(at + SKILLS.length + 1).split('/')
    if (rest.length < 2) continue
    if (onlyWithDeclaration && !(rest.length === 2 && rest[1] === BROWSER_SKILL_FILE)) continue
    const place = parseBrowserSkillPath(`${p.slice(0, at)}${SKILLS}/${rest[0]}`)
    if (!place || insidePrivate(privatePaths, place.path)) continue
    out.set(place.path, place)
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, MAX_SKILLS)
}

export function browserSkillSource(deps: { companyData: CompanyDataSource; hasCompanyFolder(companyId: string): boolean }): BrowserSkillSource {
  async function repoOf(companyId: string): Promise<{ repo: string; ref: string } | null> {
    if (!deps.hasCompanyFolder(companyId)) return null
    const repo = companyRepoPath(companyId)
    if (!existsSync(repo)) return null
    const ref = await resolveSharedBranch(repo)
    return ref ? { repo, ref } : null
  }
  const privatePaths = (companyId: string) => deps.companyData.forCompany(companyId).privateFolders.paths()

  /** A Skill path's place, or null when it is none or lies in a private folder. */
  function placeOf(companyId: string, path: string): BrowserSkillPlace | null {
    const place = parseBrowserSkillPath(path)
    return place && !insidePrivate(privatePaths(companyId), place.path) ? place : null
  }

  /** A shelf place's department: null for the company's, its row for a department's (undefined: none such). */
  function shelfDepartment(companyId: string, department: string | null): { id: string; folder: string } | null | undefined {
    if (department === null) return null
    const key = pathKey(department)
    return deps.companyData.forCompany(companyId).departments.folders()
      .map(d => ({ id: d.id, folder: d.folder.normalize('NFC') }))
      .find(d => pathKey(d.folder) === key)
  }
  /** The path a shelf item stands at (its department's folder as stored), or null when its department is gone. */
  function shelfPathOf(companyId: string, item: { departmentId: string | null; name: string }): string | null {
    if (item.departmentId === null) return browserSkillPathOf(null, item.name)
    const folder = deps.companyData.forCompany(companyId).departments.folders().find(d => d.id === item.departmentId)?.folder.normalize('NFC')
    const place = folder === undefined ? null : parseBrowserSkillPath(browserSkillPathOf(folder, item.name))
    return place?.path ?? null
  }

  /** A shelf item's `browser.yaml` at one version (base64 as stored), or null. */
  function shelfDeclaration(companyId: string, itemId: string, version: string): string | null {
    return deps.companyData.forCompany(companyId).skillShelf.versionFiles(itemId, version)?.find(f => f.path === BROWSER_SKILL_FILE)?.base64 ?? null
  }
  const declarationText = (base64: string) => {
    const bytes = Buffer.from(base64, 'base64')
    return bytes.length > BROWSER_SKILL_LIMITS.bytes ? 'too-large' : bytes.toString('utf8')
  }

  /** A shelf Skill at one version (the current one when none is named), or null. */
  function shelfRead(companyId: string, item: { departmentId: string | null; name: string }, version?: string): BrowserSkillContent | null {
    const path = shelfPathOf(companyId, item)
    if (!path) return null
    const row = deps.companyData.forCompany(companyId).skillShelf.itemAt('skill', item.departmentId, item.name)
    const at = version ?? row?.currentVersion
    if (!row || !at) return null
    const base64 = shelfDeclaration(companyId, row.id, at)
    if (base64 === null) return null
    return { path, declaration: declarationText(base64), files: `shelf:${at}` }
  }

  return {
    async list(companyId) {
      const git = await repoOf(companyId)
      if (git) {
        try {
          const specs = await skillPathspecs(git.repo, [git.ref])
          const out = await gitAsync(['-C', git.repo, 'ls-tree', '-r', '-z', '--name-only', git.ref, '--', ...specs], GIT)
          return placesIn(out.split('\0'), true, privatePaths(companyId)).map(p => p.path)
        } catch {
          return []
        }
      }
      if (deps.hasCompanyFolder(companyId)) return []
      const shelf = deps.companyData.forCompany(companyId).skillShelf
      return shelf.items()
        .filter(i => i.kind === 'skill' && i.currentVersion !== null)
        .map(i => shelfRead(companyId, i)?.path ?? null)
        .filter((p): p is string => p !== null)
        .sort()
        .slice(0, MAX_SKILLS)
    },

    async read(companyId, path) {
      const place = placeOf(companyId, path)
      if (!place) return null
      const git = await repoOf(companyId)
      if (git) return readAt(git.repo, git.ref, place)
      if (deps.hasCompanyFolder(companyId)) return null
      const department = shelfDepartment(companyId, place.department)
      if (department === undefined) return null
      return shelfRead(companyId, { departmentId: department?.id ?? null, name: place.name })
    },

    async shelfLanded(companyId, item, versions) {
      if (deps.hasCompanyFolder(companyId)) return null
      // Exactly the version this publish wrote, whatever is current by now.
      const content = shelfRead(companyId, item, versions.written)
      if (!content) return null
      const row = deps.companyData.forCompany(companyId).skillShelf.itemAt('skill', item.departmentId, item.name)
      const before = row && versions.before ? shelfDeclaration(companyId, row.id, versions.before) : null
      const after = row ? shelfDeclaration(companyId, row.id, versions.written) : null
      return { ...content, declarationChanged: before !== after, previousDeclaration: before === null ? null : declarationText(before) }
    },

    async pushed(companyId, refUpdates) {
      const git = await repoOf(companyId)
      if (!git) return []
      const out: BrowserSkillLanded[] = []
      const privates = privatePaths(companyId)
      for (const line of refUpdates.split('\n')) {
        const [oldId, newId, ref, ...rest] = line.trim().split(' ')
        if (rest.length > 0 || ref !== git.ref || !OBJECT_RE.test(oldId ?? '') || !OBJECT_RE.test(newId ?? '') || ZERO_RE.test(newId)) continue
        let paths: string[]
        try {
          const created = ZERO_RE.test(oldId)
          const specs = await skillPathspecs(git.repo, created ? [newId] : [oldId, newId])
          paths = created
            ? (await gitAsync(['-C', git.repo, 'ls-tree', '-r', '-z', '--name-only', newId, '--', ...specs], GIT)).split('\0')
            : (await gitAsync(['-C', git.repo, 'diff-tree', '-r', '-z', '--no-renames', '--name-only', oldId, newId, '--', ...specs], GIT)).split('\0')
        } catch {
          continue
        }
        for (const place of placesIn(paths, false, privates)) {
          // Read at the pushed commit: what this pusher landed, whatever came after it.
          const content = await readAt(git.repo, newId, place)
          if (!content) continue
          // Did this push touch the declaration itself (an added file counts), or only the other files?
          const file = `${place.path}/${BROWSER_SKILL_FILE}`
          const before = ZERO_RE.test(oldId) ? null : await entryOf(git.repo, oldId, file, 'blob')
          const after = await entryOf(git.repo, newId, file, 'blob')
          // What the declaration was before this push: an owner / admin's change counts as approval only on top of an
          // approved one (independent review M1: a pull --rebase carries a skill editor's pending lines along).
          const previousDeclaration = before === null ? null : await blobText(git.repo, before)
          if (before !== null && previousDeclaration === null) continue
          out.push({ ...content, declarationChanged: before !== after, previousDeclaration })
        }
      }
      return out.slice(0, MAX_SKILLS)
    },
  }
}
