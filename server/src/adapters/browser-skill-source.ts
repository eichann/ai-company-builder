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
import { gitAsync, gitBufferAsync } from '../lib/git-exec'
import { BROWSER_SKILL_STEP_FILES, BROWSER_SKILL_STEPS_LIMITS, type BrowserSkillStepFile } from '../../shared/core/browser-skill-steps'
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

/** A step file at a Skill folder's tree: its text, too large, null when not there; throws when it cannot be read. */
async function stepFileAt(repo: string, tree: string, name: BrowserSkillStepFile['name']): Promise<BrowserSkillStepFile | null> {
  const blob = await entryOf(repo, tree, name, 'blob')
  if (!blob) return null
  const size = Number((await gitAsync(['-C', repo, 'cat-file', '-s', blob], GIT)).trim())
  if (!Number.isFinite(size)) throw new Error('unreadable size')
  if (size > BROWSER_SKILL_STEPS_LIMITS.fileBytes) return { name, tooLarge: true }
  // The bytes as stored (never a trimmed output), read as UTF-8 like the app reads the member's copy.
  return { name, text: (await gitBufferAsync(['-C', repo, 'cat-file', 'blob', blob])).toString('utf8') }
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
 * top-level folder's (one level only; a name that is no department folder name is not looked into). `complete` false when
 * a folder that could be a department's was left out: more than `MAX_FOLDERS`, or a name not in NFC (a Mac commit
 * without precomposed Unicode) — a name lookup then refuses rather than guesses.
 */
async function skillPathspecs(repo: string, treeishes: readonly string[]): Promise<{ specs: string[]; complete: boolean }> {
  const folders = new Set<string>()
  let skipped = false
  for (const treeish of treeishes) {
    const out = await gitAsync(['-C', repo, 'ls-tree', '-z', '-d', treeish], GIT)
    for (const entry of out.split('\0')) {
      const tab = entry.indexOf('\t')
      if (tab < 0) continue
      const name = entry.slice(tab + 1)
      if (isValidFolderName(name) && name.normalize('NFC') === name) folders.add(name)
      else if (isValidFolderName(name.normalize('NFC'))) skipped = true
    }
  }
  const sorted = [...folders].sort()
  return {
    specs: [`${SKILLS}/`, ...sorted.slice(0, MAX_FOLDERS).map(f => `${f}/${SKILLS}/`)],
    complete: !skipped && sorted.length <= MAX_FOLDERS,
  }
}

/**
 * The Skill places among paths (relative to the repository root): with `onlyWithDeclaration`, a `browser.yaml` directly
 * in a Skill folder; else any file in one, at any depth. Sorted, at most `limit` (`complete` false when cut).
 */
function placesIn(paths: string[], onlyWithDeclaration: boolean, privatePaths: readonly string[], limit = MAX_SKILLS): { places: BrowserSkillPlace[]; complete: boolean } {
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
  const sorted = [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { places: sorted.slice(0, limit), complete: sorted.length <= limit }
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

  /**
   * The other Skill paths whose `browser.yaml` is exactly `blob` at `treeishes` (where a new declaration was moved or
   * copied from), and whether every place was looked into.
   */
  async function sameBlobAt(repo: string, treeishes: readonly string[], blob: string, self: string, privates: readonly string[]): Promise<{ paths: string[]; complete: boolean }> {
    const paths = new Set<string>()
    let complete = true
    for (const treeish of treeishes) {
      const specs = await skillPathspecs(repo, [treeish])
      complete &&= specs.complete
      // Object ids beside the names: `<mode> blob <id>\t<path>`.
      const out = await gitAsync(['-C', repo, 'ls-tree', '-r', '-z', treeish, '--', ...specs.specs], GIT)
      const same: string[] = []
      for (const entry of out.split('\0')) {
        const tab = entry.indexOf('\t')
        if (tab < 0) continue
        const [, kind, object] = entry.slice(0, tab).split(' ')
        if (kind === 'blob' && object === blob) same.push(entry.slice(tab + 1))
      }
      for (const place of placesIn(same, true, privates, Infinity).places) if (place.path !== self) paths.add(place.path)
    }
    return { paths: [...paths].sort(), complete }
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
          const out = await gitAsync(['-C', git.repo, 'ls-tree', '-r', '-z', '--name-only', git.ref, '--', ...specs.specs], GIT)
          const found = placesIn(out.split('\0'), true, privatePaths(companyId))
          return { paths: found.places.map(p => p.path), complete: specs.complete && found.complete }
        } catch {
          return { paths: [], complete: false }
        }
      }
      if (deps.hasCompanyFolder(companyId)) return { paths: [], complete: false }
      const all = deps.companyData.forCompany(companyId).skillShelf.items()
        .filter(i => i.kind === 'skill' && i.currentVersion !== null)
        .map(i => shelfRead(companyId, i)?.path ?? null)
        .filter((p): p is string => p !== null)
        .sort()
      return { paths: all.slice(0, MAX_SKILLS), complete: all.length <= MAX_SKILLS }
    },

    async withName(companyId, name) {
      const git = await repoOf(companyId)
      if (git) {
        try {
          // Every Skill folder of that name — with or without `browser.yaml`: the AI sees both, so both make a name
          // ambiguous — none left out by the list's bound.
          const specs = await skillPathspecs(git.repo, [git.ref])
          const out = await gitAsync(['-C', git.repo, 'ls-tree', '-r', '-z', '--name-only', git.ref, '--', ...specs.specs.map(s => `${s}${name}/`)], GIT)
          const found = placesIn(out.split('\0'), false, privatePaths(companyId), Infinity)
          return { paths: found.places.filter(p => p.name === name).map(p => p.path), complete: specs.complete }
        } catch {
          return { paths: [], complete: false }
        }
      }
      if (deps.hasCompanyFolder(companyId)) return { paths: [], complete: false }
      // The shelf: every Skill item of that name handed out now, with or without `browser.yaml`.
      const paths = deps.companyData.forCompany(companyId).skillShelf.items()
        .filter(i => i.kind === 'skill' && i.name === name && i.currentVersion !== null)
        .map(i => shelfPathOf(companyId, i))
        .filter((p): p is string => p !== null)
        .sort()
      return { paths, complete: true }
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
      const shelf = deps.companyData.forCompany(companyId).skillShelf
      const row = shelf.itemAt('skill', item.departmentId, item.name)
      const before = row && versions.before ? shelfDeclaration(companyId, row.id, versions.before) : null
      const after = row ? shelfDeclaration(companyId, row.id, versions.written) : null
      // A declaration new here: the other Skill items handing out exactly the same one (where it was copied from).
      const elsewhere = before === null && after !== null
        ? shelf.items()
          .filter(i => i.kind === 'skill' && i.id !== row?.id && i.currentVersion !== null && shelfDeclaration(companyId, i.id, i.currentVersion) === after)
          .map(i => shelfPathOf(companyId, i))
          .filter((p): p is string => p !== null)
          .sort()
        : []
      return {
        ...content, declarationChanged: before !== after, previousDeclaration: before === null ? null : declarationText(before),
        sameElsewhere: { paths: elsewhere, complete: true },
      }
    },

    async stepFiles(companyId, content) {
      const place = placeOf(companyId, content.path)
      if (!place) return null
      const files: BrowserSkillStepFile[] = []
      if (content.files.startsWith('git:')) {
        const tree = content.files.slice(4)
        const git = await repoOf(companyId)
        if (!git || !OBJECT_RE.test(tree)) return null
        try {
          for (const name of BROWSER_SKILL_STEP_FILES) {
            const f = await stepFileAt(git.repo, tree, name)
            if (f) files.push(f)
          }
        } catch {
          return null
        }
        return files
      }
      if (!content.files.startsWith('shelf:') || deps.hasCompanyFolder(companyId)) return null
      const department = shelfDepartment(companyId, place.department)
      if (department === undefined) return null
      const row = deps.companyData.forCompany(companyId).skillShelf.itemAt('skill', department?.id ?? null, place.name)
      const stored = row ? deps.companyData.forCompany(companyId).skillShelf.versionFiles(row.id, content.files.slice(6)) : null
      if (!stored) return null
      for (const name of BROWSER_SKILL_STEP_FILES) {
        const f = stored.find(x => x.path === name)
        if (!f) continue
        const bytes = Buffer.from(f.base64, 'base64')
        files.push(bytes.length > BROWSER_SKILL_STEPS_LIMITS.fileBytes ? { name, tooLarge: true } : { name, text: bytes.toString('utf8') })
      }
      return files
    },

    async pushed(companyId, refUpdates) {
      const git = await repoOf(companyId)
      if (!git) return []
      const out: BrowserSkillLanded[] = []
      const privates = privatePaths(companyId)
      for (const line of refUpdates.split('\n')) {
        const [oldId, newId, ref, ...rest] = line.trim().split(' ')
        if (rest.length > 0 || ref !== git.ref || !OBJECT_RE.test(oldId ?? '') || !OBJECT_RE.test(newId ?? '') || ZERO_RE.test(newId)) continue
        const created = ZERO_RE.test(oldId)
        let paths: string[]
        try {
          const specs = await skillPathspecs(git.repo, created ? [newId] : [oldId, newId])
          paths = created
            ? (await gitAsync(['-C', git.repo, 'ls-tree', '-r', '-z', '--name-only', newId, '--', ...specs.specs], GIT)).split('\0')
            : (await gitAsync(['-C', git.repo, 'diff-tree', '-r', '-z', '--no-renames', '--name-only', oldId, newId, '--', ...specs.specs], GIT)).split('\0')
        } catch {
          continue
        }
        for (const place of placesIn(paths, false, privates).places) {
          // Read at the pushed commit: what this pusher landed, whatever came after it.
          const content = await readAt(git.repo, newId, place)
          if (!content) continue
          // Did this push touch the declaration itself (an added file counts), or only the other files?
          const file = `${place.path}/${BROWSER_SKILL_FILE}`
          const before = created ? null : await entryOf(git.repo, oldId, file, 'blob')
          const after = await entryOf(git.repo, newId, file, 'blob')
          // What the declaration was before this push: an owner / admin's change counts as approval only on top of an
          // approved one (independent review M1: a pull --rebase carries a skill editor's pending lines along).
          const previousDeclaration = before === null ? null : await blobText(git.repo, before)
          if (before !== null && previousDeclaration === null) continue
          // New here: where else the very same declaration stood before or after this push (a move or a copy).
          let sameElsewhere = { paths: [] as string[], complete: true }
          if (before === null && after !== null) {
            try {
              sameElsewhere = await sameBlobAt(git.repo, created ? [newId] : [oldId, newId], after, place.path, privates)
            } catch {
              sameElsewhere = { paths: [], complete: false }
            }
          }
          out.push({ ...content, declarationChanged: before !== after, previousDeclaration, sameElsewhere })
        }
      }
      return out.slice(0, MAX_SKILLS)
    },
  }
}
