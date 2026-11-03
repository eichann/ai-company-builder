/**
 * The plugin shelf on disk (`PLUGINS_DIR`, ports/plugins.ts): one folder per
 * package, `<id>@<version>/` holding exactly `plugin.yaml`, optional
 * `mapping.yaml` and `types/<name>.md` and, from contract 2 on (whether the
 * declaration allows them is `validatePluginPackage`'s rule), `steps/<name>.md`,
 * `ui/…` (a frame's files: html, js, css, json, images, fonts) and
 * `signature.yaml`. `scripts/` is refused by name (no scripts in stage 4a).
 * Anything else in a package folder — another file, a sub-folder, a symbolic
 * link, a file over its size — makes the folder unusable (nothing in a package
 * runs on the server). The shelf is read only; nothing here writes.
 *
 * Fingerprints: v1 is the sha256 over the relative path and text of
 * `plugin.yaml`, `mapping.yaml` and `types/` (sorted) — unchanged, so a
 * contract-1 package keeps the fingerprint its installs recorded. v2 is
 * `shared/core/plugin-fingerprint.ts` over the bytes of every file (name
 * order, without `signature.yaml`). The service keeps the one of the
 * package's contract.
 *
 * Problems are reported with the folder name and a fixed reason; file
 * contents are never logged or returned.
 */
import { createHash } from 'crypto'
import { lstat, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { PLUGIN_SIGNATURE_FILE, pluginFingerprintV2 } from '../../shared/core/plugin-fingerprint'
import type { PluginPackageFiles, PluginShelfScan, PluginShelfSource } from '../ports/plugins'

const MAX_FILE_BYTES = 256 * 1024
const MAX_UI_FILE_BYTES = 2 * 1024 * 1024
const MAX_UI_BYTES = 10 * 1024 * 1024
const MAX_TYPES = 50
const MAX_STEPS = 100
const MAX_UI_FILES = 200
const MAX_UI_DEPTH = 3
const MAX_PACKAGES = 500
const TYPE_FILE_RE = /^([a-z][a-z0-9_]{0,39})\.md$/
const STEP_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.md$/
const UI_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const UI_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.(?:html|js|mjs|css|json|svg|png|jpg|jpeg|gif|webp|woff|woff2)$/
/** A shelf folder's name: `<id>@<version>` (also what collect-plugins writes). */
export const PACKAGE_DIR_RE = /^[a-z][a-z0-9-]{0,39}@\d{1,4}\.\d{1,5}\.\d{1,6}$/

class ShelfProblem extends Error {}

const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

async function readSmallBytes(path: string, max = MAX_FILE_BYTES): Promise<Buffer> {
  const st = await lstat(path)
  if (!st.isFile()) throw new ShelfProblem('a package holds only plain files (no links or folders)')
  if (st.size > max) throw new ShelfProblem(max === MAX_FILE_BYTES ? 'a file is over 256 KB' : 'a ui file is over 2 MB')
  return readFile(path)
}

async function readSmallFile(path: string): Promise<string> {
  return (await readSmallBytes(path)).toString('utf8')
}

async function folder(path: string, what: string): Promise<string[]> {
  const st = await lstat(path)
  if (!st.isDirectory()) throw new ShelfProblem(`${what} must be a folder`)
  return (await readdir(path)).sort()
}

/** A package folder read with every rule; `bytes` is every file read (`signature.yaml` included). */
async function readPackage(root: string, dir: string): Promise<{ package: PluginPackageFiles; bytes: Array<{ path: string; bytes: Uint8Array }> }> {
  const base = join(root, dir)
  /** v1's files (path, text), in the order v1 always hashed them. */
  const v1: Array<[string, string]> = []
  /** Every file's bytes, for v2. */
  const all: Array<{ path: string; bytes: Uint8Array }> = []
  let manifest: string | null = null
  let mapping: string | null = null
  let signature: string | null = null
  const types: Record<string, string> = {}
  const steps: Record<string, string> = {}
  const ui: string[] = []
  let uiBytes = 0
  const text = async (rel: string, inV1: boolean): Promise<string> => {
    const bytes = await readSmallBytes(join(base, rel))
    const t = bytes.toString('utf8')
    all.push({ path: rel, bytes })
    if (inV1) v1.push([rel, t])
    return t
  }
  const walkUi = async (rel: string, depth: number): Promise<void> => {
    for (const name of await folder(join(base, rel), 'ui')) {
      const path = `${rel}/${name}`
      const st = await lstat(join(base, path))
      if (st.isDirectory()) {
        if (depth >= MAX_UI_DEPTH || !UI_DIR_RE.test(name)) throw new ShelfProblem('ui/ holds plain folders, at most three deep')
        await walkUi(path, depth + 1)
        continue
      }
      if (!UI_FILE_RE.test(name)) throw new ShelfProblem('ui/ holds only html, js, css, json, image and font files')
      if (ui.length >= MAX_UI_FILES) throw new ShelfProblem('too many ui files')
      const bytes = await readSmallBytes(join(base, path), MAX_UI_FILE_BYTES)
      uiBytes += bytes.length
      if (uiBytes > MAX_UI_BYTES) throw new ShelfProblem('ui/ is over 10 MB')
      all.push({ path, bytes })
      ui.push(path)
    }
  }
  for (const name of (await readdir(base)).sort()) {
    if (name === 'plugin.yaml') { manifest = await text(name, true); continue }
    if (name === 'mapping.yaml') { mapping = await text(name, true); continue }
    if (name === PLUGIN_SIGNATURE_FILE) { signature = await text(name, false); continue }
    if (name === 'types') {
      const entries = await folder(join(base, name), 'types')
      if (entries.length > MAX_TYPES) throw new ShelfProblem('too many type files')
      for (const t of entries) {
        const m = TYPE_FILE_RE.exec(t)
        if (!m) throw new ShelfProblem('types/ holds only <name>.md files')
        types[m[1]] = await text(`types/${t}`, true)
      }
      continue
    }
    if (name === 'steps') {
      const entries = await folder(join(base, name), 'steps')
      if (entries.length > MAX_STEPS) throw new ShelfProblem('too many step files')
      for (const f of entries) {
        if (!STEP_FILE_RE.test(f)) throw new ShelfProblem('steps/ holds only <name>.md files')
        steps[`steps/${f}`] = await text(`steps/${f}`, false)
      }
      continue
    }
    if (name === 'ui') { await walkUi('ui', 0); continue }
    if (name === 'scripts') throw new ShelfProblem('scripts/ is not allowed: a package holds no scripts yet (stage 4a)')
    throw new ShelfProblem('unexpected file in the package (only plugin.yaml, mapping.yaml, types/, steps/, ui/ and signature.yaml)')
  }
  if (manifest === null) throw new ShelfProblem('plugin.yaml is missing')
  const hash = createHash('sha256')
  for (const [path, t] of v1) hash.update(path).update('\0').update(t).update('\0')
  return {
    package: {
      dir, manifest, types, mapping, steps, ui, signature,
      fingerprint: hash.digest('hex'), fingerprintV2: pluginFingerprintV2(all, sha256Hex),
    },
    bytes: all,
  }
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
          packages.push((await readPackage(root, dir)).package)
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
    async files(dir) {
      if (!root || !PACKAGE_DIR_RE.test(dir)) return null
      try {
        const st = await lstat(join(root, dir))
        if (!st.isDirectory()) return null
        const read = await readPackage(root, dir)
        return { files: read.bytes, fingerprintV2: read.package.fingerprintV2 }
      } catch {
        return null
      }
    },
  }
}
