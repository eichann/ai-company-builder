/**
 * A company Skill's version on the shared branch: the git tree id of
 * `.claude/skills/<name>` (the same id #403 records for a Skill a consultation
 * used, `records.md` "Which Skill"; equal on every clone with that content).
 * Read from the bare repository, async (server.md "Async only").
 */
import { existsSync } from 'fs'
import { isValidFolderName, isValidSkillName } from '../../shared/core/names'
import { companyRepoPath } from './config'
import { gitAsync } from './git-exec'
import { resolveSharedBranch } from './repo-folders'

/** The tree id of the company Skill `name` on the shared branch, or null (no such folder, no repository, an invalid name). */
export async function companySkillTree(companyId: string, name: string): Promise<string | null> {
  if (!isValidSkillName(name)) return null
  const bareRepo = companyRepoPath(companyId)
  if (!existsSync(bareRepo)) return null
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return null
  return entryOf(bareRepo, ref, `.claude/skills/${name}`, 'tree')
}

const OBJECT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** The largest `decision.json` read (`parseJobDecisionFile` refuses more anyway). */
const DECISION_FILE_MAX = 16 * 1024

/** The object id of `path` at `treeish` when it is of `type`, or null. */
async function entryOf(bareRepo: string, treeish: string, path: string, type: 'tree' | 'blob'): Promise<string | null> {
  try {
    const out = (await gitAsync(['-C', bareRepo, 'ls-tree', '-z', treeish, '--', path], { timeoutMs: 30_000 })).split('\0')[0]
    // "<mode> <type> <object>\t<path>"
    const [meta, found] = out.split('\t')
    const [, kind, object] = (meta ?? '').split(' ')
    return kind === type && found === path && OBJECT_RE.test(object ?? '') ? object : null
  } catch {
    return null
  }
}

/**
 * A department's Skill (`<place>/.claude/skills/<name>`, 4b-4 PR1, jobs.md "The set watch (schema 5)"): its tree id on the
 * shared branch and the text of its `decision.json` (null when it has none, or one too large); null when there is no such Skill
 * (an invalid place or name, no repository, no folder). `place` is one department folder, as the caller's parser checked.
 */
export async function departmentSkill(companyId: string, place: string, name: string): Promise<{ tree: string; decision: string | null } | null> {
  if (!isValidSkillName(name) || !isValidFolderName(place)) return null
  const bareRepo = companyRepoPath(companyId)
  if (!existsSync(bareRepo)) return null
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return null
  const tree = await entryOf(bareRepo, ref, `${place}/.claude/skills/${name}`, 'tree')
  if (tree === null) return null
  const blob = await entryOf(bareRepo, tree, 'decision.json', 'blob')
  if (blob === null) return { tree, decision: null }
  try {
    const size = Number((await gitAsync(['-C', bareRepo, 'cat-file', '-s', blob], { timeoutMs: 30_000 })).trim())
    if (!Number.isFinite(size) || size > DECISION_FILE_MAX) return { tree, decision: null }
    return { tree, decision: await gitAsync(['-C', bareRepo, 'cat-file', 'blob', blob], { timeoutMs: 30_000 }) }
  } catch {
    return { tree, decision: null }
  }
}

/** The most Skills one department lists (a member's 「見張りを足す」 chooses among them). */
const DEPARTMENT_SKILLS_MAX = 100

/**
 * The Skills of one department (`<place>/.claude/skills/<name>`, 4b-4 PR6b) on the shared branch, by name, and whether each
 * has a `decision.json` (only such a Skill can be what a set watch runs; the server checks the file when it pins). Valid
 * Skill names only, sorted, at most `DEPARTMENT_SKILLS_MAX`; null when there is no repository or the place is not a
 * department folder name.
 */
export async function departmentSkills(companyId: string, place: string): Promise<Array<{ skill: string; runs: boolean }> | null> {
  if (!isValidFolderName(place)) return null
  const bareRepo = companyRepoPath(companyId)
  if (!existsSync(bareRepo)) return null
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return null
  const prefix = `${place}/.claude/skills/`
  let out: string
  try {
    out = await gitAsync(['-C', bareRepo, 'ls-tree', '-r', '-z', '--name-only', ref, '--', prefix], { timeoutMs: 30_000 })
  } catch {
    return []
  }
  const skills = new Map<string, boolean>()
  for (const path of out.split('\0')) {
    if (!path.startsWith(prefix)) continue
    const [name, ...rest] = path.slice(prefix.length).split('/')
    if (!name || !isValidSkillName(name) || rest.length === 0) continue
    skills.set(name, (skills.get(name) ?? false) || (rest.length === 1 && rest[0] === 'decision.json'))
  }
  return [...skills].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, DEPARTMENT_SKILLS_MAX).map(([skill, runs]) => ({ skill, runs }))
}
