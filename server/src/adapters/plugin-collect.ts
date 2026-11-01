/**
 * Collecting plugin packages from their private repositories into a shelf
 * folder (`PLUGINS_DIR`) — the operator's step before a deploy
 * (`cli/collect-plugins.ts`, `.claude/rules/plugins.md` "Where packages come
 * from").
 *
 * The lock (`plugins.lock`, the operator's file) names each package as
 * `<repo> <id>@<version> <fingerprint v2>`, one per line (`#` comments). The
 * package is the folder `<id>@<version>/` at the tag `<id>@<version>` of
 * `<repo>` (`owner/name` on GitHub, or a git URL / path).
 *
 * All or nothing: every package is fetched and its fingerprint v2 checked
 * against the lock, and every folder already in the shelf checked, before
 * anything is written. A fingerprint that differs is refused; a version already
 * in the shelf with other content is refused (a published version is never
 * replaced). Other folders are left alone unless `prune` (then only
 * `<id>@<version>` folders not in the lock are removed — never `stopped` or
 * anything else). Prints names and fingerprints only, never file contents.
 */
import { execFile } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { pluginFingerprintV2 } from '../../shared/core/plugin-fingerprint'
import { PACKAGE_DIR_RE } from './plugin-shelf'

const execFileAsync = promisify(execFile)
const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FINGERPRINT_RE = /^[0-9a-f]{64}$/

export interface LockEntry {
  repo: string
  /** `<id>@<version>`: the folder and the tag. */
  pkg: string
  fingerprint: string
}

export class CollectError extends Error {}

export function parsePluginsLock(text: string): LockEntry[] {
  const entries: LockEntry[] = []
  const seen = new Set<string>()
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return
    const parts = line.split(/\s+/)
    if (parts.length !== 3) throw new CollectError(`plugins.lock line ${i + 1}: expected "<repo> <id>@<version> <fingerprint v2>"`)
    const [repo, pkg, fingerprint] = parts
    if (!PACKAGE_DIR_RE.test(pkg)) throw new CollectError(`plugins.lock line ${i + 1}: "${pkg}" is not <id>@<version>`)
    if (!FINGERPRINT_RE.test(fingerprint)) throw new CollectError(`plugins.lock line ${i + 1}: the fingerprint must be 64 lowercase hex characters`)
    if (seen.has(pkg)) throw new CollectError(`plugins.lock line ${i + 1}: ${pkg} is listed twice`)
    seen.add(pkg)
    entries.push({ repo, pkg, fingerprint })
  })
  return entries
}

/** Every plain file under a package folder (relative `/` paths); a link or anything else refuses. */
async function packageFiles(base: string, rel = ''): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const out: Array<{ path: string; bytes: Uint8Array }> = []
  for (const name of (await readdir(rel ? join(base, rel) : base)).sort()) {
    const path = rel ? `${rel}/${name}` : name
    const st = await lstat(join(base, path))
    if (st.isDirectory()) out.push(...await packageFiles(base, path))
    else if (st.isFile()) out.push({ path, bytes: await readFile(join(base, path)) })
    else throw new CollectError(`${path}: a package holds only plain files and folders`)
  }
  return out
}

/** The fingerprint v2 (shared/core/plugin-fingerprint.ts) of a package folder on disk. */
export async function packageFingerprintV2(dir: string): Promise<string> {
  return pluginFingerprintV2(await packageFiles(dir), sha256Hex)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

/** Fetch one tag of one repository into `into` (a new folder). GitHub `owner/name` uses `gh`'s credentials. */
export async function gitFetchTag(repo: string, tag: string, into: string): Promise<void> {
  const github = GITHUB_REPO_RE.test(repo)
  const url = github ? `https://github.com/${repo}.git` : repo
  const auth = github ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : []
  try {
    await execFileAsync('git', [...auth, '-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false',
      'clone', '--quiet', '--depth', '1', '--branch', tag, '--', url, into],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 })
  } catch {
    throw new CollectError(`${repo}: cannot fetch tag ${tag} (is the tag pushed, and can you read the repository? \`gh auth status\`)`)
  }
}

export interface CollectResult {
  added: string[]
  unchanged: string[]
  removed: string[]
}

export async function collectPlugins(opts: {
  entries: LockEntry[]
  dir: string
  prune?: boolean
  fetchTag?: (repo: string, tag: string, into: string) => Promise<void>
}): Promise<CollectResult> {
  const fetchTag = opts.fetchTag ?? gitFetchTag
  const st = await lstat(opts.dir).catch(() => null)
  if (!st?.isDirectory()) throw new CollectError('the shelf folder does not exist (create it first)')
  const work = await mkdtemp(join(tmpdir(), 'acb-collect-'))
  try {
    // 1. Fetch and check everything; write nothing yet.
    const checkouts = new Map<string, string>()
    const toAdd: Array<{ pkg: string; from: string }> = []
    const unchanged: string[] = []
    const problems: string[] = []
    for (const e of opts.entries) {
      const key = `${e.repo}\0${e.pkg}`
      let checkout = checkouts.get(key)
      if (!checkout) {
        checkout = join(work, String(checkouts.size))
        await fetchTag(e.repo, e.pkg, checkout)
        checkouts.set(key, checkout)
      }
      const from = join(checkout, e.pkg)
      if (!(await lstat(from).catch(() => null))?.isDirectory()) { problems.push(`${e.pkg}: no folder ${e.pkg}/ at tag ${e.pkg} of ${e.repo}`); continue }
      const got = await packageFingerprintV2(from)
      if (got !== e.fingerprint) { problems.push(`${e.pkg}: fingerprint ${got} does not match the lock (${e.fingerprint})`); continue }
      const target = join(opts.dir, e.pkg)
      if (await exists(target)) {
        const there = await packageFingerprintV2(target).catch(() => null)
        if (there === e.fingerprint) unchanged.push(e.pkg)
        else problems.push(`${e.pkg}: the shelf already has this version with other content (a published version is never replaced; make a new version)`)
        continue
      }
      toAdd.push({ pkg: e.pkg, from })
    }
    const listed = new Set(opts.entries.map(e => e.pkg))
    const toRemove = opts.prune ? (await readdir(opts.dir)).filter(n => PACKAGE_DIR_RE.test(n) && !listed.has(n)).sort() : []
    if (problems.length > 0) throw new CollectError(`nothing was written:\n  ${problems.join('\n  ')}`)

    // 2. Write: copy beside the target (a dot folder, which the shelf skips), then rename into place.
    const staging = join(opts.dir, `.collect-${randomBytes(6).toString('hex')}`)
    await mkdir(staging)
    try {
      for (const a of toAdd) {
        await cp(a.from, join(staging, a.pkg), { recursive: true, errorOnExist: true, force: false })
        if (await packageFingerprintV2(join(staging, a.pkg)) !== opts.entries.find(e => e.pkg === a.pkg)?.fingerprint) {
          throw new CollectError(`${a.pkg}: the copy does not match the lock`)
        }
      }
      for (const a of toAdd) await rename(join(staging, a.pkg), join(opts.dir, a.pkg))
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    for (const name of toRemove) await rm(join(opts.dir, name), { recursive: true, force: true })
    return { added: toAdd.map(a => a.pkg), unchanged, removed: toRemove }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
