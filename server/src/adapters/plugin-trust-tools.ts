/**
 * The owner's and operator's tools for plugin trust (`cli/plugin-trust.ts`,
 * `.claude/rules/plugin-trust.md` "P2" and "Owner steps"; design v3 §6, §12 + v3.1 §1–§3). They hold
 * **no key**: every signature is made by `ssh-keygen -Y sign` with a key file or, given only a
 * public key file, through the ssh agent (Secretive / 1Password / the Actions job's agent), and
 * every document is verified with the core's own rules (`companyTrustToServe`) before it is
 * written. Nothing here runs in the api.
 *
 * - `reviewedPackage`: a lock line's package at its tag — the tag's commit must be reachable from
 *   the repository's protected main (the owner's reviewed merge) and the folder's fingerprint v2 at
 *   that tag must equal the lock's — as a list entry `{ id, version, fingerprint, commit, tag }`.
 * - `signTargets`: one company's list, the next version, ≤ 90 days, signed with the targets key.
 * - `signFreshness`: for each company's list, a freshness document bound to its version and the
 *   sha256 of its signed text, the next version, ≤ 3 days, signed with a freshness key.
 * - `signRoot`: adds one root key's signature to a root text (the owner, one USB key at a time).
 * - `checkSigningKey`: signs a fixed text through the agent and verifies it with the core — the
 *   owner's first real-device check of Secretive (P-256) or 1Password (v3.1 §6).
 * - `installTrust`: the operator's timer: copies the two branches' files into a new dot folder of
 *   `PLUGINS_DIR`, checks every company there, then swaps the `trust` link in one rename.
 */
import { execFile, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import {
  TRUST_ROOT_FILE_RE, companyTrustFiles, companyTrustToServe, trustServerOf,
} from '../../shared/core/plugin-trust-distribution'
import {
  PLUGIN_TRUST_POLICY, ROLE_KEY_TYPES, TRUST_NAMESPACES, parseEnvelope, parseRoot,
  type SignedEnvelope, type TargetsPackage, type TrustRoleName,
} from '../../shared/core/plugin-trust-documents'
import { parseRootKey, toHex, utf8, verifySshSig } from '../../shared/core/plugin-trust-sshsig'
import { nodePluginTrustCrypto as crypto } from './plugin-trust-crypto'
import { packageFingerprintV2, type LockEntry } from './plugin-collect'

const execFileAsync = promisify(execFile)

export class TrustToolError extends Error {}

/** Signs `text` in `namespace` with `keyFile` (a private key file, or a public one whose key the agent holds). */
export type TrustSigner = (text: string, keyFile: string, namespace: string) => Promise<string>

export const sshKeygenSigner: TrustSigner = (text, keyFile, namespace) => new Promise((resolve, reject) => {
  const child = spawn('ssh-keygen', ['-q', '-Y', 'sign', '-f', keyFile, '-n', namespace], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', () => reject(new TrustToolError('ssh-keygen could not be started')))
  child.on('close', code => (code === 0 && out.includes('BEGIN SSH SIGNATURE')
    ? resolve(out)
    : reject(new TrustToolError(`ssh-keygen -Y sign failed (${err.trim().split('\n')[0] || `exit ${code}`})`))))
  child.stdin.end(text)
})

/** A time as the documents write it (whole seconds, UTC). */
export const trustTime = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
const DAY_MS = 86_400_000
const sha256Hex = (text: string): string => toHex(crypto.sha256(utf8(text)))

async function readIf(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, text, { mode: 0o644, flag: 'wx' })
  await rename(tmp, path)
}

/** Every root text in `<dir>/root/`, version order. */
export async function rootTexts(dir: string): Promise<string[]> {
  let names: string[] = []
  try { names = (await readdir(join(dir, 'root'))).filter(n => TRUST_ROOT_FILE_RE.test(n)) } catch { return [] }
  names.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
  return Promise.all(names.map(n => readFile(join(dir, 'root', n), 'utf8')))
}

const versionOf = (text: string | null): number => {
  if (!text) return 0
  try {
    const v = (JSON.parse((JSON.parse(text) as SignedEnvelope).signed) as { version?: unknown }).version
    return Number.isInteger(v) ? v as number : 0
  } catch { return 0 }
}

const envelopeText = (env: SignedEnvelope): string => `${JSON.stringify(env, null, 1)}\n`

// ---------------------------------------------------------------- the reviewed package

export type GitRunner = (args: string[], cwd?: string) => Promise<string>
export const gitRunner: GitRunner = async (args, cwd) => (await execFileAsync('git', args, {
  cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
})).stdout

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * A lock line's package as the list names it. Clones `repo` (all of main's history, blobs on
 * demand), refuses a tag whose commit is not reachable from `origin/<main>` (unreviewed), and a
 * folder whose fingerprint v2 at the tag differs from the lock's.
 */
export async function reviewedPackage(entry: LockEntry, opts: { main?: string; git?: GitRunner } = {}): Promise<TargetsPackage> {
  const git = opts.git ?? gitRunner
  const main = opts.main ?? 'main'
  const [id, version] = entry.pkg.split('@')
  const github = GITHUB_REPO_RE.test(entry.repo)
  const url = github ? `https://github.com/${entry.repo}.git` : entry.repo
  const auth = github ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : []
  const work = await mkdtemp(join(tmpdir(), 'acb-trust-review-'))
  try {
    const checkout = join(work, 'repo')
    try {
      await git([...auth, '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-checkout', '--', url, checkout])
    } catch { throw new TrustToolError(`${entry.repo}: cannot clone (can you read it? \`gh auth status\`)`) }
    let commit: string
    try { commit = (await git(['rev-parse', '--verify', `refs/tags/${entry.pkg}^{commit}`], checkout)).trim() } catch {
      throw new TrustToolError(`${entry.pkg}: no tag ${entry.pkg} in ${entry.repo}`)
    }
    try { await git(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${main}`], checkout) } catch {
      throw new TrustToolError(`${entry.pkg}: the tag's commit is not on ${main} (not a reviewed merge): not signed`)
    }
    const out = join(work, 'archive')
    await mkdir(out)
    await git(['-c', 'advice.detachedHead=false', '--work-tree', out, 'checkout', '--quiet', commit, '--', `${entry.pkg}/`], checkout)
    const folder = join(out, entry.pkg)
    if (!(await lstat(folder).catch(() => null))?.isDirectory()) throw new TrustToolError(`${entry.pkg}: no folder ${entry.pkg}/ at the tag`)
    const fingerprint = await packageFingerprintV2(folder)
    if (fingerprint !== entry.fingerprint) throw new TrustToolError(`${entry.pkg}: fingerprint ${fingerprint} at the tag does not match the lock (${entry.fingerprint})`)
    return { id, version, fingerprint, commit, tag: entry.pkg }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- signing

interface SignOpts { keyFile: string; keyId: string; sign?: TrustSigner; now?: number }

/** The next list of one company, verified with the trust folder's roots before it is written. */
export async function signTargets(opts: SignOpts & {
  trustDir: string; companyId: string; server: string; packages: TargetsPackage[]; floors?: Record<string, string>; days?: number
}): Promise<{ version: number; file: string }> {
  const files = companyTrustFiles(opts.companyId)
  const server = trustServerOf(opts.server)
  if (!files) throw new TrustToolError('not a company id')
  if (!server) throw new TrustToolError('--server must be http(s)://host[:port], exactly as PUBLIC_URL')
  const days = opts.days ?? 90
  if (!(days > 0 && days * DAY_MS <= PLUGIN_TRUST_POLICY.maxTargetsLifetimeMs)) throw new TrustToolError('a list lives at most 90 days')
  const now = opts.now ?? Date.now()
  const file = join(opts.trustDir, files.targets)
  const version = versionOf(await readIf(file)) + 1
  const doc = {
    _type: 'acb-targets', scope: `company:${opts.companyId}`, server, version,
    issued: trustTime(now), expires: trustTime(now + days * DAY_MS),
    packages: opts.packages, floors: opts.floors ?? {},
  }
  const text = JSON.stringify(doc, null, 1)
  const sig = await (opts.sign ?? sshKeygenSigner)(text, opts.keyFile, TRUST_NAMESPACES.targets)
  const envelope: SignedEnvelope = { signed: text, signatures: [{ key_id: opts.keyId, sig }] }
  const served = companyTrustToServe({ roots: await rootTexts(opts.trustDir), targets: JSON.stringify(envelope), freshness: null }, { server, companyId: opts.companyId, now }, crypto)
  if (!served.documents.targets) throw new TrustToolError(`the signed list does not verify against the roots in ${opts.trustDir}: ${served.notes.join('; ')}`)
  await mkdir(join(opts.trustDir, 'targets'), { recursive: true })
  await writeAtomic(file, envelopeText(envelope))
  return { version, file }
}

/** A freshness document for each company list in `listsDir` (or the ones named), written to `outDir`. */
export async function signFreshness(opts: SignOpts & {
  listsDir: string; outDir: string; server: string; companies?: string[]; days?: number
}): Promise<Array<{ companyId: string; version: number }>> {
  const server = trustServerOf(opts.server)
  if (!server) throw new TrustToolError('--server must be http(s)://host[:port], exactly as PUBLIC_URL')
  const days = opts.days ?? 3
  if (!(days > 0 && days * DAY_MS <= PLUGIN_TRUST_POLICY.maxFreshnessLifetimeMs)) throw new TrustToolError('a freshness document lives at most 3 days')
  const now = opts.now ?? Date.now()
  const roots = await rootTexts(opts.listsDir)
  let companies = opts.companies
  if (!companies) {
    const names = await readdir(join(opts.listsDir, 'targets')).catch(() => [] as string[])
    companies = names.flatMap(n => { const m = /^company-(.+)\.json$/.exec(n); return m ? [m[1]] : [] }).sort()
  }
  const done: Array<{ companyId: string; version: number }> = []
  for (const companyId of companies) {
    const files = companyTrustFiles(companyId)
    if (!files) throw new TrustToolError(`not a company id: ${companyId}`)
    const listText = await readIf(join(opts.listsDir, files.targets))
    if (!listText) throw new TrustToolError(`company ${companyId}: no list`)
    const ctx = { server, companyId, now }
    const check = companyTrustToServe({ roots, targets: listText, freshness: null }, ctx, crypto)
    if (!check.documents.targets) throw new TrustToolError(`company ${companyId}: its list does not verify (${check.notes.join('; ')}): no freshness document is made for it`)
    const listEnv = check.documents.targets
    const outFile = join(opts.outDir, files.freshness)
    const version = versionOf(await readIf(outFile)) + 1
    const doc = {
      _type: 'acb-freshness', scope: `company:${companyId}`, server, version,
      issued: trustTime(now), expires: trustTime(now + days * DAY_MS),
      targets: { version: versionOf(listText), sha256: sha256Hex(listEnv.signed) },
    }
    const text = JSON.stringify(doc, null, 1)
    const sig = await (opts.sign ?? sshKeygenSigner)(text, opts.keyFile, TRUST_NAMESPACES.freshness)
    const envelope: SignedEnvelope = { signed: text, signatures: [{ key_id: opts.keyId, sig }] }
    const served = companyTrustToServe({ roots, targets: listText, freshness: JSON.stringify(envelope) }, ctx, crypto)
    if (!served.documents.freshness) throw new TrustToolError(`company ${companyId}: the signed freshness document does not verify: ${served.notes.join('; ')}`)
    await mkdir(join(opts.outDir, 'freshness'), { recursive: true })
    await writeAtomic(outFile, envelopeText(envelope))
    done.push({ companyId, version })
  }
  return done
}

/** Adds one root key's signature to a root (`rootFile`: a root text, or an envelope already holding signatures). */
export async function signRoot(opts: SignOpts & { rootFile: string; out: string }): Promise<{ signatures: number }> {
  const raw = await readFile(opts.rootFile, 'utf8')
  const existing = parseEnvelope((() => { try { return JSON.parse(raw) } catch { return undefined } })())
  const text = existing ? existing.signed : raw.replace(/\n$/, '')
  const parsed = parseRoot((() => { try { return JSON.parse(text) } catch { return undefined } })())
  if (!parsed.ok) throw new TrustToolError(`not a valid root: ${parsed.problem}`)
  if (!parsed.root.document.roles.root.keys.includes(opts.keyId)) throw new TrustToolError(`${opts.keyId} is not one of this root's root keys`)
  const sig = await (opts.sign ?? sshKeygenSigner)(text, opts.keyFile, TRUST_NAMESPACES.root)
  if (!verifySshSig(sig, utf8(text), TRUST_NAMESPACES.root, parsed.root.keys.get(opts.keyId)!, crypto)) {
    throw new TrustToolError(`the signature is not ${opts.keyId}'s (another key file?)`)
  }
  const signatures = [...(existing?.signatures ?? []).filter(s => s.key_id !== opts.keyId), { key_id: opts.keyId, sig }]
  await writeAtomic(opts.out, envelopeText({ signed: text, signatures }))
  return { signatures: signatures.length }
}

/** The owner's first check of a real signing key (v3.1 §6): sign through the agent, verify with the core. */
export async function checkSigningKey(opts: { publicKeyFile: string; role: TrustRoleName; sign?: TrustSigner }): Promise<{ type: string; base64: string }> {
  const line = (await readFile(opts.publicKeyFile, 'utf8')).trim().split(/\s+/)
  const key = parseRootKey(line[1])
  if (!key.ok) throw new TrustToolError(`not an OpenSSH public key this app reads: ${key.error}`)
  if (!ROLE_KEY_TYPES[opts.role].includes(key.key.type)) throw new TrustToolError(`a ${opts.role} key must be ${ROLE_KEY_TYPES[opts.role].join(' or ')}, not ${key.key.type}`)
  const text = `acb trust key check ${trustTime(Date.now())}`
  const namespace = TRUST_NAMESPACES[opts.role]
  const sig = await (opts.sign ?? sshKeygenSigner)(text, opts.publicKeyFile, namespace)
  if (!verifySshSig(sig, utf8(text), namespace, key.key, crypto)) throw new TrustToolError('the agent signed, but the app\'s verification does not accept it')
  return { type: key.key.type, base64: line[1] }
}

// ---------------------------------------------------------------- the operator's install

/**
 * Put the trust documents into `<pluginsDir>/trust` all at once: copy `root/` and `targets/` from
 * the main branch's checkout and `freshness/` from the freshness branch's into a new dot folder,
 * check every company there (each list and freshness must be what the server would hand out),
 * then point the `trust` link at it with one rename and remove the previous folder. Refuses,
 * changing nothing, on any problem. A `trust` that is a real folder (made by hand) is moved aside once.
 */
export async function installTrust(opts: { mainDir: string; freshnessDir: string; pluginsDir: string; server: string; now?: number }): Promise<{ companies: string[]; folder: string }> {
  const server = trustServerOf(opts.server)
  if (!server) throw new TrustToolError('--server must be http(s)://host[:port], exactly as PUBLIC_URL')
  const now = opts.now ?? Date.now()
  const folder = `.trust-${trustTime(now).replace(/[-:]/g, '')}-${randomBytes(3).toString('hex')}`
  const staging = join(opts.pluginsDir, folder)
  await mkdir(staging)
  try {
    for (const [from, sub] of [[opts.mainDir, 'root'], [opts.mainDir, 'targets'], [opts.freshnessDir, 'freshness']] as const) {
      await mkdir(join(staging, sub))
      for (const name of await readdir(join(from, sub)).catch(() => [] as string[])) {
        if (!name.endsWith('.json')) continue
        const st = await lstat(join(from, sub, name))
        if (!st.isFile()) throw new TrustToolError(`${sub}/${name}: not a plain file`)
        await cp(join(from, sub, name), join(staging, sub, name))
      }
    }
    const roots = await rootTexts(staging)
    if (roots.length === 0) throw new TrustToolError('no root in root/')
    const companies = (await readdir(join(staging, 'targets'))).flatMap(n => { const m = /^company-(.+)\.json$/.exec(n); return m ? [m[1]] : [] }).sort()
    const problems: string[] = []
    for (const companyId of companies) {
      const files = companyTrustFiles(companyId)
      if (!files) { problems.push(`targets/company-${companyId}.json: not a company id`); continue }
      const served = companyTrustToServe({
        roots, targets: await readIf(join(staging, files.targets)), freshness: await readIf(join(staging, files.freshness)),
      }, { server, companyId, now }, crypto)
      if (!served.documents.targets || !served.documents.freshness) problems.push(`company ${companyId}: ${served.notes.join('; ')}`)
    }
    if (problems.length > 0) throw new TrustToolError(`nothing was installed:\n  ${problems.join('\n  ')}`)
    // Swap: a new link beside the old one, renamed over it (one rename; the api reads either whole set).
    const link = join(opts.pluginsDir, 'trust')
    const st = await lstat(link).catch(() => null)
    if (st && !st.isSymbolicLink()) await rename(link, join(opts.pluginsDir, `.trust-by-hand-${randomBytes(3).toString('hex')}`))
    const previous = st?.isSymbolicLink() ? await readlink(link) : null
    const tmpLink = join(opts.pluginsDir, `.trust-link-${randomBytes(6).toString('hex')}`)
    await symlink(folder, tmpLink)
    await rename(tmpLink, link)
    if (previous && /^\.trust-[0-9TZ]+-[0-9a-f]{6}$/.test(previous)) await rm(join(opts.pluginsDir, previous), { recursive: true, force: true })
    return { companies, folder }
  } catch (e) {
    const linked = await readlink(join(opts.pluginsDir, 'trust')).catch(() => null)
    if (linked !== folder) await rm(staging, { recursive: true, force: true })
    throw e
  }
}
