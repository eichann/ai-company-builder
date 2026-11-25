/**
 * The server's own copy of a company's Skills for 「Skill の承認」 (ports/browser-skills.ts `BrowserSkillSource`,
 * agent-browser.md "A Skill's browser declaration and its approval"): the shared branch of the company repository for a
 * company with the shared folder (git, async: server.md "Async only"), the Skill shelf's current version for one
 * without. Only company-wide Skills (`.claude/skills/<name>`; a shelf item with no department). Never what an app sent.
 */
import { existsSync } from 'fs'
import { BROWSER_SKILL_FILE, BROWSER_SKILL_LIMITS } from '../../shared/core/browser-skill'
import { isValidSkillName } from '../../shared/core/names'
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

/** One Skill at `treeish` (a commit or the shared branch), or null. */
async function readAt(repo: string, treeish: string, name: string): Promise<BrowserSkillContent | null> {
  if (!isValidSkillName(name)) return null
  const tree = await entryOf(repo, treeish, `${SKILLS}/${name}`, 'tree')
  if (!tree) return null
  const blob = await entryOf(repo, tree, BROWSER_SKILL_FILE, 'blob')
  if (!blob) return null
  try {
    const size = Number((await gitAsync(['-C', repo, 'cat-file', '-s', blob], GIT)).trim())
    if (!Number.isFinite(size)) return null
    const declaration = size > BROWSER_SKILL_LIMITS.bytes ? 'too-large' : await gitAsync(['-C', repo, 'cat-file', 'blob', blob], GIT)
    return { name, declaration, files: `git:${tree}` }
  } catch {
    return null
  }
}

/** Skill names under `.claude/skills/` among paths (relative to the repository root). */
function skillNamesIn(paths: string[], onlyWithDeclaration: boolean): string[] {
  const names = new Set<string>()
  for (const p of paths) {
    if (!p.startsWith(`${SKILLS}/`)) continue
    const rest = p.slice(SKILLS.length + 1).split('/')
    if (rest.length < 2 || !isValidSkillName(rest[0])) continue
    if (onlyWithDeclaration && !(rest.length === 2 && rest[1] === BROWSER_SKILL_FILE)) continue
    names.add(rest[0])
  }
  return [...names].sort().slice(0, MAX_SKILLS)
}

export function browserSkillSource(deps: { companyData: CompanyDataSource; hasCompanyFolder(companyId: string): boolean }): BrowserSkillSource {
  async function repoOf(companyId: string): Promise<{ repo: string; ref: string } | null> {
    if (!deps.hasCompanyFolder(companyId)) return null
    const repo = companyRepoPath(companyId)
    if (!existsSync(repo)) return null
    const ref = await resolveSharedBranch(repo)
    return ref ? { repo, ref } : null
  }

  /** A shelf item's `browser.yaml` at one version (base64 as stored), or null. */
  function shelfDeclaration(companyId: string, itemId: string, version: string): string | null {
    return deps.companyData.forCompany(companyId).skillShelf.versionFiles(itemId, version)?.find(f => f.path === BROWSER_SKILL_FILE)?.base64 ?? null
  }

  /** A shelf Skill at one version (the current one when none is named), or null. */
  function shelfRead(companyId: string, name: string, version?: string): BrowserSkillContent | null {
    if (!isValidSkillName(name)) return null
    const shelf = deps.companyData.forCompany(companyId).skillShelf
    const item = shelf.itemAt('skill', null, name)
    const at = version ?? item?.currentVersion
    if (!item || !at) return null
    const base64 = shelfDeclaration(companyId, item.id, at)
    if (base64 === null) return null
    const bytes = Buffer.from(base64, 'base64')
    const declaration = bytes.length > BROWSER_SKILL_LIMITS.bytes ? 'too-large' : bytes.toString('utf8')
    return { name, declaration, files: `shelf:${at}` }
  }

  return {
    async list(companyId) {
      const git = await repoOf(companyId)
      if (git) {
        try {
          const out = await gitAsync(['-C', git.repo, 'ls-tree', '-r', '-z', '--name-only', git.ref, '--', `${SKILLS}/`], GIT)
          return skillNamesIn(out.split('\0'), true)
        } catch {
          return []
        }
      }
      if (deps.hasCompanyFolder(companyId)) return []
      const shelf = deps.companyData.forCompany(companyId).skillShelf
      return shelf.items()
        .filter(i => i.kind === 'skill' && i.departmentId === null && i.currentVersion !== null)
        .map(i => i.name)
        .filter(name => shelfRead(companyId, name) !== null)
        .sort()
        .slice(0, MAX_SKILLS)
    },

    async read(companyId, name) {
      const git = await repoOf(companyId)
      if (git) return readAt(git.repo, git.ref, name)
      if (deps.hasCompanyFolder(companyId)) return null
      return shelfRead(companyId, name)
    },

    async shelfLanded(companyId, name, versions) {
      if (deps.hasCompanyFolder(companyId)) return null
      // Exactly the version this publish wrote, whatever is current by now.
      const content = shelfRead(companyId, name, versions.written)
      if (!content) return null
      const item = deps.companyData.forCompany(companyId).skillShelf.itemAt('skill', null, name)
      const before = item && versions.before ? shelfDeclaration(companyId, item.id, versions.before) : null
      const after = item ? shelfDeclaration(companyId, item.id, versions.written) : null
      return { ...content, declarationChanged: before !== after }
    },

    async pushed(companyId, refUpdates) {
      const git = await repoOf(companyId)
      if (!git) return []
      const out: BrowserSkillLanded[] = []
      for (const line of refUpdates.split('\n')) {
        const [oldId, newId, ref, ...rest] = line.trim().split(' ')
        if (rest.length > 0 || ref !== git.ref || !OBJECT_RE.test(oldId ?? '') || !OBJECT_RE.test(newId ?? '') || ZERO_RE.test(newId)) continue
        let paths: string[]
        try {
          paths = ZERO_RE.test(oldId)
            ? (await gitAsync(['-C', git.repo, 'ls-tree', '-r', '-z', '--name-only', newId, '--', `${SKILLS}/`], GIT)).split('\0')
            : (await gitAsync(['-C', git.repo, 'diff-tree', '-r', '-z', '--no-renames', '--name-only', oldId, newId, '--', `${SKILLS}/`], GIT)).split('\0')
        } catch {
          continue
        }
        for (const name of skillNamesIn(paths, false)) {
          // Read at the pushed commit: what this pusher landed, whatever came after it.
          const content = await readAt(git.repo, newId, name)
          if (!content) continue
          // Did this push touch the declaration itself (an added file counts), or only the other files?
          const file = `${SKILLS}/${name}/${BROWSER_SKILL_FILE}`
          const before = ZERO_RE.test(oldId) ? null : await entryOf(git.repo, oldId, file, 'blob')
          const after = await entryOf(git.repo, newId, file, 'blob')
          out.push({ ...content, declarationChanged: before !== after })
        }
      }
      return out.slice(0, MAX_SKILLS)
    },
  }
}
