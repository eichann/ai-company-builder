/**
 * `<PLUGINS_DIR>/trust/` on disk (ports/plugin-trust.ts, `.claude/rules/plugin-trust.md` "P2"):
 * `root/<version>.json`, `targets/company-<id>.json`, `freshness/company-<id>.json`, put there by
 * the operator's tool (`cli/plugin-trust.ts install`), which swaps `trust` (a symbolic link to a
 * dot folder) in one rename. Read again on every call, like `stopped`; nothing here writes.
 *
 * - A company's file name is built only by `companyTrustFiles` (a company id the core accepts):
 *   no other company's file can be named from a request.
 * - Only plain files (`lstat`, no link inside `trust/`), at most 1 MiB each, at most
 *   `MAX_TRUST_ROOTS` roots. A file that cannot be read is left out and its path reported.
 */
import { lstat, readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { MAX_TRUST_ROOTS, TRUST_ROOT_FILE_RE, companyTrustFiles } from '../../shared/core/plugin-trust-distribution'
import type { PluginTrustFiles } from '../ports/plugin-trust'

const MAX_TRUST_FILE_BYTES = 1024 * 1024

/** null = no such file; throws when it exists but is not a plain readable file within the size. */
async function readPlain(path: string): Promise<string | null> {
  let st
  try { st = await lstat(path) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  if (!st.isFile() || st.size > MAX_TRUST_FILE_BYTES) throw new Error('not a plain file within the size')
  return readFile(path, 'utf8')
}

export function diskPluginTrustFiles(pluginsDir: string | null): PluginTrustFiles {
  return {
    async read(companyId) {
      if (!pluginsDir) return null
      const base = join(pluginsDir, 'trust')
      // `trust` itself may be the operator's link to the current dot folder; everything inside is plain.
      const top = await stat(base).catch(() => null)
      if (!top?.isDirectory()) return null
      const problems: string[] = []
      const roots: string[] = []
      let names: string[] = []
      try { names = (await readdir(join(base, 'root'))).filter(n => TRUST_ROOT_FILE_RE.test(n)).sort() } catch { problems.push('root/') }
      for (const name of names.slice(0, MAX_TRUST_ROOTS)) {
        try {
          const text = await readPlain(join(base, 'root', name))
          if (text !== null) roots.push(text)
        } catch { problems.push(`root/${name}`) }
      }
      const files = companyTrustFiles(companyId)
      if (!files) return { roots, targets: null, freshness: null, problems }
      const one = async (rel: string): Promise<string | null> => {
        try { return await readPlain(join(base, ...rel.split('/'))) } catch { problems.push(rel); return null }
      }
      const targets = await one(files.targets)
      const freshness = await one(files.freshness)
      return { roots, targets, freshness, problems }
    },
  }
}
