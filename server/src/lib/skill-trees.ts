/**
 * A company Skill's version on the shared branch: the git tree id of
 * `.claude/skills/<name>` (the same id #403 records for a Skill a consultation
 * used, `records.md` "Which Skill"; equal on every clone with that content).
 * Read from the bare repository, async (server.md "Async only").
 */
import { existsSync } from 'fs'
import { isValidSkillName } from '../../shared/core/names'
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
  try {
    const out = (await gitAsync(['-C', bareRepo, 'ls-tree', '-z', ref, '--', `.claude/skills/${name}`], { timeoutMs: 30_000 })).split('\0')[0]
    // "<mode> <type> <object>\t<path>"
    const [meta] = out.split('\t')
    const [, type, object] = (meta ?? '').split(' ')
    return type === 'tree' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object ?? '') ? object : null
  } catch {
    return null
  }
}
