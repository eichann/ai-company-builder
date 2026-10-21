// Universal (arm64 + x86_64) build of dugite's bundled git for the mac app.
//
// dugite's postinstall downloads dugite-native for the machine that runs
// `pnpm install` only, so a universal app built on Apple Silicon shipped an
// arm64-only git (bin/git, git-lfs, libexec/git-core/*). On an Intel Mac that
// git cannot exec, main.ts falls back to the system /usr/bin/git (Apple Git
// 2.39), whose chunked HTTP push is broken and which carries known CVEs — the
// Intel push failure of 2026-10-21. @electron/universal cannot fix this for
// us: it treats everything under app.asar.unpacked as app code and simply
// keeps the x64 slice's copy without lipo-ing it.
//
// So for darwin builds we download BOTH darwin-arm64 and darwin-x64
// dugite-native archives (the exact URLs and sha256 checksums dugite pins in
// script/embedded-git.json), and merge them into one tree:
//   - every Mach-O file becomes `lipo -create` of the two slices;
//   - every other file must be byte-identical in both (else: fail);
//   - symlinks, hard links and permissions are kept as in the archives;
//   - a path present in only one archive fails the build;
//   - Git Credential Manager (unused by the app, see isCredentialManagerPath)
//     is left out.
// The tree then replaces node_modules/dugite/git (idempotent: a tree that is
// already universal is left alone), which electron-builder packs into both
// arch slices of the universal app as before. Universal slices are the
// upstream bytes, so arm64 runs exactly the binary it ran before.
//
// Usage:
//   node scripts/universal-git.mjs                # install into node_modules/dugite/git (darwin only)
//   node scripts/universal-git.mjs --out <dir>    # only build the merged tree at <dir> (CI)
//   node scripts/universal-git.mjs --verify <dir> # check every Mach-O under <dir> is universal
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ARCHES = [
  { key: 'darwin-arm64', lipo: 'arm64' },
  { key: 'darwin-x64', lipo: 'x86_64' },
]

// What the app runs; the merge must never lose these.
const REQUIRED = ['bin/git', 'libexec/git-core/git', 'libexec/git-core/git-remote-https', 'libexec/git-core/git-lfs']

function fail(message) {
  throw new Error(`[universal-git] ${message}`)
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.error}`)
  }
  return result.stdout
}

export function dugitePackageDir() {
  const require = createRequire(import.meta.url)
  return path.dirname(require.resolve('dugite/package.json'))
}

function embeddedGit(dugiteDir) {
  return JSON.parse(fs.readFileSync(path.join(dugiteDir, 'script', 'embedded-git.json'), 'utf8'))
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Same cache location and file name as dugite's own download-git.js, so the
// host-arch archive left by `pnpm install` is reused.
async function download(entry, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = path.join(cacheDir, path.basename(new URL(entry.url).pathname))
  if (fs.existsSync(file)) {
    if (sha256(file) === entry.checksum) return file
    console.log(`[universal-git] cached ${path.basename(file)} has the wrong checksum, downloading again`)
    fs.rmSync(file)
  }
  console.log(`[universal-git] downloading ${entry.url}`)
  const res = await fetch(entry.url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'dugite' } })
  if (!res.ok) fail(`GET ${entry.url} -> ${res.status}`)
  const tmp = `${file}.${process.pid}.part`
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  const got = sha256(tmp)
  if (got !== entry.checksum) {
    fs.rmSync(tmp)
    fail(`checksum mismatch for ${entry.url}: expected ${entry.checksum}, got ${got}`)
  }
  fs.renameSync(tmp, file)
  return file
}

// Mach-O: thin 32/64-bit (either byte order) or fat. 0xcafebabe is also the
// Java class magic; a fat header's arch count is tiny, a class file's version
// is >= 45.
function machOKind(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(8)
  const n = fs.readSync(fd, buf, 0, 8, 0)
  fs.closeSync(fd)
  if (n < 8) return null
  const magic = buf.readUInt32BE(0)
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return 'thin'
  if ((magic === 0xcafebabe || magic === 0xcafebabf) && buf.readUInt32BE(4) < 20) return 'fat'
  return null
}

function lipoArchs(file) {
  return run('xcrun', ['lipo', '-archs', file]).trim().split(/\s+/).sort()
}

// Git Credential Manager is a self-contained .NET app that dugite-native puts
// next to git in libexec/git-core (~110MB of the ~140MB tree). Its managed
// assemblies are compiled ahead of time per CPU, so ~90 of them differ between
// the two archives and cannot be merged into one universal tree. The app
// never runs it: every git invocation clears the helper list with
// `-c credential.helper=` and authenticates through its own askpass
// (electron/sync/git-factory.ts). So it is left out of the merged tree. The
// rule is narrow on purpose: everything else must still pass the strict
// identical-or-lipo checks, so a new arch-specific file fails the build.
const GCM_DIR = path.join('libexec', 'git-core')
export function isCredentialManagerPath(root, rel) {
  if (path.dirname(rel) !== GCM_DIR) return false
  const name = path.basename(rel)
  if (name.startsWith('git-credential-manager')) return true
  if (/\.(dll|dylib)$/.test(name) || ['createdump', 'NOTICE', 'uninstall.sh'].includes(name)) return true
  // Satellite resource folders (cs/, ja/, zh-Hant/, ...).
  const p = path.join(root, rel)
  if (!fs.lstatSync(p).isDirectory()) return false
  const entries = fs.readdirSync(p)
  return entries.length > 0 && entries.every(e => e.endsWith('.resources.dll'))
}

// Relative paths of a tree in a stable order (parents before children).
function walk(root, exclude = () => false) {
  const out = []
  const visit = rel => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? path.join(rel, name) : name
      if (exclude(root, r)) continue
      out.push(r)
      const st = fs.lstatSync(path.join(root, r))
      if (st.isDirectory()) visit(r)
    }
  }
  visit('')
  return out
}

// Regular files that share an inode, as path -> first path of its group.
function hardLinkGroups(root, paths) {
  const byInode = new Map()
  for (const rel of paths) {
    const st = fs.lstatSync(path.join(root, rel))
    if (!st.isFile() || st.nlink < 2) continue
    const key = `${st.dev}:${st.ino}`
    if (!byInode.has(key)) byInode.set(key, [])
    byInode.get(key).push(rel)
  }
  const first = new Map()
  for (const group of byInode.values()) {
    if (group.length < 2) continue
    for (const rel of group.slice(1)) first.set(rel, group[0])
  }
  return first
}

function sameBytes(a, b) {
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

/**
 * Merge two extracted dugite-native trees into a universal one at outDir.
 * Throws (listing every problem) if the trees do not correspond.
 */
export function mergeTrees(armDir, x64Dir, outDir, { exclude = isCredentialManagerPath } = {}) {
  const armPaths = walk(armDir, exclude)
  const x64Paths = walk(x64Dir, exclude)
  const x64Set = new Set(x64Paths)
  const armSet = new Set(armPaths)
  const problems = []
  for (const p of armPaths) if (!x64Set.has(p)) problems.push(`only in arm64: ${p}`)
  for (const p of x64Paths) if (!armSet.has(p)) problems.push(`only in x64: ${p}`)
  if (problems.length) fail(`the two archives do not have the same files:\n  ${problems.join('\n  ')}`)

  const armLinks = hardLinkGroups(armDir, armPaths)
  const x64Links = hardLinkGroups(x64Dir, x64Paths)
  for (const p of new Set([...armLinks.keys(), ...x64Links.keys()])) {
    if (armLinks.get(p) !== x64Links.get(p)) problems.push(`hard links differ: ${p}`)
  }

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const stats = { machO: 0, plain: 0, symlinks: 0, hardLinks: 0, dirs: 0 }
  const dirModes = []
  for (const rel of armPaths) {
    const a = path.join(armDir, rel)
    const x = path.join(x64Dir, rel)
    const o = path.join(outDir, rel)
    const sa = fs.lstatSync(a)
    const sx = fs.lstatSync(x)
    const mode = sa.mode & 0o7777
    const kind = st => (st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other')
    if (kind(sa) !== kind(sx)) { problems.push(`type differs (${kind(sa)} vs ${kind(sx)}): ${rel}`); continue }
    if (kind(sa) === 'other') { problems.push(`unsupported file type: ${rel}`); continue }
    if (kind(sa) !== 'symlink' && mode !== (sx.mode & 0o7777)) {
      problems.push(`permissions differ (${mode.toString(8)} vs ${(sx.mode & 0o7777).toString(8)}): ${rel}`)
      continue
    }
    if (sa.isSymbolicLink()) {
      const target = fs.readlinkSync(a)
      if (target !== fs.readlinkSync(x)) { problems.push(`symlink target differs: ${rel}`); continue }
      fs.symlinkSync(target, o)
      stats.symlinks++
    } else if (sa.isDirectory()) {
      fs.mkdirSync(o)
      dirModes.push([o, mode])
      stats.dirs++
    } else if (armLinks.has(rel)) {
      fs.linkSync(path.join(outDir, armLinks.get(rel)), o)
      stats.hardLinks++
    } else {
      const ka = machOKind(a)
      const kx = machOKind(x)
      if (Boolean(ka) !== Boolean(kx)) { problems.push(`Mach-O in only one arch: ${rel}`); continue }
      if (!ka) {
        if (!sameBytes(a, x)) { problems.push(`non-Mach-O file differs between arches: ${rel}`); continue }
        fs.copyFileSync(a, o)
        stats.plain++
      } else if (ka === 'fat' || kx === 'fat') {
        if (!sameBytes(a, x)) { problems.push(`already-universal Mach-O differs between arches: ${rel}`); continue }
        fs.copyFileSync(a, o) // universal upstream; verifyUniversal checks its slices
        stats.machO++
      } else {
        run('xcrun', ['lipo', '-create', a, x, '-output', o])
        stats.machO++
      }
      fs.chmodSync(o, mode)
    }
  }
  if (problems.length) fail(`cannot merge the arm64 and x64 archives:\n  ${problems.join('\n  ')}`)
  for (const required of REQUIRED) {
    if (!fs.existsSync(path.join(outDir, required))) fail(`merged tree has no ${required}`)
  }
  // Directory modes last, so a read-only directory does not block its children.
  for (const [dir, mode] of dirModes.reverse()) fs.chmodSync(dir, mode)
  return stats
}

/** Every Mach-O under dir must contain both arm64 and x86_64. Returns counts. */
export function verifyUniversal(dir) {
  const bad = []
  let machO = 0
  let symlinks = 0
  for (const rel of walk(dir)) {
    const p = path.join(dir, rel)
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) { symlinks++; continue }
    if (!st.isFile() || !machOKind(p)) continue
    machO++
    const archs = lipoArchs(p)
    if (!ARCHES.every(a => archs.includes(a.lipo))) bad.push(`${rel} (${archs.join(' ')})`)
  }
  if (machO === 0) fail(`no Mach-O files found under ${dir}`)
  if (bad.length) fail(`not universal:\n  ${bad.join('\n  ')}`)
  return { machO, symlinks }
}

/** Download both archives, verify checksums, extract and merge into outDir. */
export async function buildUniversalTree(outDir, { dugiteDir = dugitePackageDir() } = {}) {
  const meta = embeddedGit(dugiteDir)
  const cacheDir = process.env.DUGITE_CACHE_DIR ? path.resolve(process.env.DUGITE_CACHE_DIR) : os.tmpdir()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-universal-git-'))
  try {
    const dirs = {}
    for (const { key } of ARCHES) {
      const entry = meta[key]
      if (!entry) fail(`dugite's embedded-git.json has no ${key} entry`)
      const archive = await download(entry, cacheDir)
      const dir = path.join(work, key)
      fs.mkdirSync(dir)
      // bsdtar refuses absolute paths, `..` and extracting through symlinks by default.
      run('/usr/bin/tar', ['-xzf', archive, '-C', dir])
      dirs[key] = dir
    }
    const stats = mergeTrees(dirs['darwin-arm64'], dirs['darwin-x64'], outDir)
    verifyUniversal(outDir)
    console.log(`[universal-git] merged ${meta['darwin-arm64'].name} + ${meta['darwin-x64'].name}: ` +
      `${stats.machO} universal Mach-O, ${stats.plain} identical files, ${stats.symlinks} symlinks, ${stats.hardLinks} hard links`)
    return stats
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function isUniversal(dir) {
  try {
    verifyUniversal(dir)
    return true
  } catch {
    return false
  }
}

/** Replace node_modules/dugite/git with the universal tree (no-op if it already is one). */
export async function installUniversalGit({ dugiteDir = dugitePackageDir() } = {}) {
  if (process.platform !== 'darwin') {
    console.log('[universal-git] not on macOS; leaving dugite as installed')
    return
  }
  const target = path.join(dugiteDir, 'git')
  if (fs.existsSync(target) && isUniversal(target)) {
    console.log(`[universal-git] ${target} is already universal`)
    return
  }
  const staging = `${target}.universal-${process.pid}`
  await buildUniversalTree(staging, { dugiteDir })
  // Rename rather than overwrite: node_modules files may be hard links into
  // pnpm's store, which must not be modified in place.
  const old = `${target}.old-${process.pid}`
  if (fs.existsSync(target)) fs.renameSync(target, old)
  fs.renameSync(staging, target)
  fs.rmSync(old, { recursive: true, force: true })
  console.log(`[universal-git] installed universal git at ${target}`)
}

// electron-builder `beforePack` hook (package.json build.beforePack). It runs
// before each arch slice is packed, only for real packs (not `--prepackaged`),
// and never for `pnpm dev` or the test jobs. Mac targets only.
export async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return
  await installUniversalGit()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, dir] = process.argv.slice(2)
  try {
    if (flag === '--out' && dir) {
      await buildUniversalTree(path.resolve(dir))
    } else if (flag === '--verify' && dir) {
      const { machO, symlinks } = verifyUniversal(path.resolve(dir))
      console.log(`[universal-git] ${machO} Mach-O files, all universal (${symlinks} symlinks)`)
    } else if (!flag) {
      await installUniversalGit()
    } else {
      fail('usage: universal-git.mjs [--out <dir> | --verify <dir>]')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
