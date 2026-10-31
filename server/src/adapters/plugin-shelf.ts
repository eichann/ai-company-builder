/**
 * The plugin shelf on disk (`PLUGINS_DIR`, ports/plugins.ts): one folder per
 * package, `<id>@<version>/` holding exactly `plugin.yaml`, optional
 * `mapping.yaml` and `types/<name>.md`. Anything else in a package folder —
 * another file, a sub-folder, a symbolic link, a file over 256 KB — makes the
 * folder unusable (a package is data only; nothing else belongs there). The
 * shelf is read only; nothing here writes.
 *
 * The fingerprint is the sha256 over every file's relative path and content
 * (sorted), so any change to a package changes it.
 *
 * Problems are reported with the folder name and a fixed reason; file
 * contents are never logged or returned.
 */
import { createHash } from 'crypto'
import { lstat, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { PluginPackageFiles, PluginShelfScan, PluginShelfSource } from '../ports/plugins'

const MAX_FILE_BYTES = 256 * 1024
const MAX_TYPES = 50
const MAX_PACKAGES = 500
const TYPE_FILE_RE = /^([a-z][a-z0-9_]{0,39})\.md$/
const PACKAGE_DIR_RE = /^[a-z][a-z0-9-]{0,39}@\d{1,4}\.\d{1,5}\.\d{1,6}$/

class ShelfProblem extends Error {}

async function readSmallFile(path: string): Promise<string> {
  const st = await lstat(path)
  if (!st.isFile()) throw new ShelfProblem('a package holds only plain files (no links or folders)')
  if (st.size > MAX_FILE_BYTES) throw new ShelfProblem('a file is over 256 KB')
  return readFile(path, 'utf8')
}

async function readPackage(root: string, dir: string): Promise<PluginPackageFiles> {
  const base = join(root, dir)
  const files: Array<[string, string]> = []
  let manifest: string | null = null
  let mapping: string | null = null
  const types: Record<string, string> = {}
  for (const name of (await readdir(base)).sort()) {
    if (name === 'plugin.yaml') { manifest = await readSmallFile(join(base, name)); files.push([name, manifest]); continue }
    if (name === 'mapping.yaml') { mapping = await readSmallFile(join(base, name)); files.push([name, mapping]); continue }
    if (name === 'types') {
      const st = await lstat(join(base, name))
      if (!st.isDirectory()) throw new ShelfProblem('types must be a folder')
      const entries = (await readdir(join(base, name))).sort()
      if (entries.length > MAX_TYPES) throw new ShelfProblem('too many type files')
      for (const t of entries) {
        const m = TYPE_FILE_RE.exec(t)
        if (!m) throw new ShelfProblem('types/ holds only <name>.md files')
        const text = await readSmallFile(join(base, name, t))
        types[m[1]] = text
        files.push([`types/${t}`, text])
      }
      continue
    }
    throw new ShelfProblem('unexpected file in the package (only plugin.yaml, mapping.yaml and types/)')
  }
  if (manifest === null) throw new ShelfProblem('plugin.yaml is missing')
  const hash = createHash('sha256')
  for (const [path, text] of files) hash.update(path).update('\0').update(text).update('\0')
  return { dir, manifest, types, mapping, fingerprint: hash.digest('hex') }
}

export function diskPluginShelf(root: string | null): PluginShelfSource {
  return {
    async scan(): Promise<PluginShelfScan> {
      if (!root) return { packages: [], problems: [] }
      let names: string[]
      try { names = (await readdir(root)).sort() } catch { return { packages: [], problems: [{ dir: '.', reason: 'the shelf folder cannot be read' }] } }
      const packages: PluginPackageFiles[] = []
      const problems: PluginShelfScan['problems'] = []
      for (const dir of names) {
        if (dir === 'stopped' || dir.startsWith('.')) continue
        if (packages.length >= MAX_PACKAGES) { problems.push({ dir, reason: 'too many packages on the shelf' }); continue }
        try {
          const st = await lstat(join(root, dir))
          if (!st.isDirectory()) throw new ShelfProblem('not a package folder')
          if (!PACKAGE_DIR_RE.test(dir)) throw new ShelfProblem('the folder name must be <id>@<version>')
          packages.push(await readPackage(root, dir))
        } catch (err) {
          problems.push({ dir, reason: err instanceof ShelfProblem ? err.message : 'the package cannot be read' })
        }
      }
      return { packages, problems }
    },
    async stopped() {
      if (!root) return []
      try {
        const text = await readSmallFile(join(root, 'stopped'))
        return text.split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)
      } catch (err) {
        // No file: nothing stopped. A file that exists but cannot be read stops everything (fail closed).
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['*']
      }
    },
  }
}
