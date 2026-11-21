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
 *   sha256 of its signed text, the next version, ≤ 3 days, signed with a freshness key; a company
 *   whose list does not verify is reported and does not block the others.
 * - `signRoot`: adds one root key's signature to a root text (the owner, one USB key at a time); in
 *   a rotation a key of the predecessor root may sign too (both thresholds, as `stepRoot` needs).
 * - `checkSigningKey`: signs a fixed text through the agent and verifies it with the core — the
 *   owner's first real-device check of Secretive (P-256) or 1Password (v3.1 §6).
 * - `installTrust`: the operator's timer: copies the two branches' files into a new dot folder of
 *   `PLUGINS_DIR`, checks each company there, then swaps the `trust` link in one rename.
 * An existing document whose version cannot be read refuses (never "start again at v1").
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
  PLUGIN_TRUST_POLICY, ROLE_KEY_TYPES, TRUST_NAMESPACES, TRUST_ROLES, openEnvelope, parseEnvelope, parseRoot,
  type ParsedRoot, type SignedEnvelope, type TargetsPackage, type TrustRoleName,
} from '../../shared/core/plugin-trust-documents'
import { bakedRoot, stepRoot, type TrustedRoot } from '../../shared/core/plugin-trust'
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
  try { names = (await readdir(join(dir, 'root'))).filter(n => TRUST_ROOT_FILE_RE.test(n)) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new TrustToolError(`${join(dir, 'root')}: cannot be read`)
  }
  names.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
  return Promise.all(names.map(n => readFile(join(dir, 'root', n), 'utf8')))
}

/** The version of the document already there: 0 when there is none; a file that cannot be read refuses (never "start again at v1"). */
const versionOf = (text: string | null, what: string): number => {
  if (text === null) return 0
  try {
    const v = (JSON.parse((JSON.parse(text) as SignedEnvelope).signed) as { version?: unknown }).version
    if (Number.isInteger(v) && (v as number) >= 1) return v as number
  } catch { /* refused below */ }
  throw new TrustToolError(`${what}: the existing document cannot be read, so its next version is unknown; fix or remove it by hand first`)
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
      await git([...auth, '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-checkout', '--filter=blob:none', '--', url, checkout])
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
  const version = versionOf(await readIf(file), files.targets) + 1
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

/**
 * A freshness document for each company list in `listsDir` (or the ones named), written to `outDir`.
 * One company whose list does not verify is refused and reported; the others are still signed.
 */
export async function signFreshness(opts: SignOpts & {
  listsDir: string; outDir: string; server: string; companies?: string[]; days?: number
}): Promise<{ signed: Array<{ companyId: string; version: number }>; refused: Array<{ companyId: string; reason: string }> }> {
  const server = trustServerOf(opts.server)
  if (!server) throw new TrustToolError('--server must be http(s)://host[:port], exactly as PUBLIC_URL')
  const days = opts.days ?? 3
  if (!(days > 0 && days * DAY_MS <= PLUGIN_TRUST_POLICY.maxFreshnessLifetimeMs)) throw new TrustToolError('a freshness document lives at most 3 days')
  const now = opts.now ?? Date.now()
  const roots = await rootTexts(opts.listsDir)
  const companies = opts.companies ?? await companyIdsIn(join(opts.listsDir, 'targets'))
  const signed: Array<{ companyId: string; version: number }> = []
  const refused: Array<{ companyId: string; reason: string }> = []
  for (const companyId of companies) {
    try {
      const files = companyTrustFiles(companyId)
      if (!files) throw new TrustToolError('not a company id')
      const listText = await readIf(join(opts.listsDir, files.targets))
      if (!listText) throw new TrustToolError('no list')
      const ctx = { server, companyId, now }
      const check = companyTrustToServe({ roots, targets: listText, freshness: null }, ctx, crypto)
      if (!check.documents.targets) throw new TrustToolError(`its list does not verify (${check.notes.join('; ')})`)
      const outFile = join(opts.outDir, files.freshness)
      const version = versionOf(await readIf(outFile), files.freshness) + 1
      const doc = {
        _type: 'acb-freshness', scope: `company:${companyId}`, server, version,
        issued: trustTime(now), expires: trustTime(now + days * DAY_MS),
        targets: { version: versionOf(listText, files.targets), sha256: sha256Hex(check.documents.targets.signed) },
      }
      const text = JSON.stringify(doc, null, 1)
      const sig = await (opts.sign ?? sshKeygenSigner)(text, opts.keyFile, TRUST_NAMESPACES.freshness)
      const envelope: SignedEnvelope = { signed: text, signatures: [{ key_id: opts.keyId, sig }] }
      const served = companyTrustToServe({ roots, targets: listText, freshness: JSON.stringify(envelope) }, ctx, crypto)
      if (!served.documents.freshness) throw new TrustToolError(`the signed freshness document does not verify: ${served.notes.join('; ')}`)
      await mkdir(join(opts.outDir, 'freshness'), { recursive: true })
      await writeAtomic(outFile, envelopeText(envelope))
      signed.push({ companyId, version })
    } catch (e) {
      refused.push({ companyId, reason: e instanceof Error ? e.message : 'unknown' })
    }
  }
  return { signed, refused }
}

/** `company-<id>.json` names in a folder → ids. A folder that cannot be read refuses (never "no companies"). */
async function companyIdsIn(dir: string): Promise<string[]> {
  let names: string[]
  try { names = await readdir(dir) } catch { throw new TrustToolError(`${dir}: cannot be read`) }
  return names.flatMap(n => { const m = /^company-(.+)\.json$/.exec(n); return m ? [m[1]] : [] }).sort()
}

const jsonOrUndefined = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }

export interface RootSigning {
  signatures: number
  /** The new root's own root threshold is met. */
  newThreshold: boolean
  /** With `predecessor`: its root threshold is met too. */
  predecessorThreshold: boolean | null
  /** Usable: a first root carrying its own threshold, or a valid step from the predecessor (`stepRoot`: both thresholds, version +1). */
  complete: boolean
}

/**
 * Adds one root key's signature to a root (`rootFile`: a root text, or an envelope already holding
 * signatures). For a rotation, `predecessor` is the signed root of the version before: a key that
 * root lists for `root` may sign too (a key being removed), and its signature is checked against the
 * predecessor's key — the step needs both roots' thresholds (v3 §3, `stepRoot`).
 */
export async function signRoot(opts: SignOpts & { rootFile: string; out: string; predecessor?: string }): Promise<RootSigning> {
  const raw = await readFile(opts.rootFile, 'utf8')
  const existing = parseEnvelope(jsonOrUndefined(raw))
  const text = existing ? existing.signed : raw.replace(/\n$/, '')
  const parsed = parseRoot(jsonOrUndefined(text))
  if (!parsed.ok) throw new TrustToolError(`not a valid root: ${parsed.problem}`)
  const next = parsed.root
  let previous: TrustedRoot | null = null
  if (opts.predecessor) {
    try { previous = bakedRoot(jsonOrUndefined(await readFile(opts.predecessor, 'utf8')), crypto) } catch (e) {
      throw new TrustToolError(`the predecessor is not a signed root carrying its own threshold (${e instanceof Error ? e.message : 'unknown'})`)
    }
    if (previous.document.version !== next.document.version - 1) throw new TrustToolError(`the predecessor must be version ${next.document.version - 1}`)
  }
  const inNew = next.document.roles.root.keys.includes(opts.keyId)
  const inOld = previous?.document.roles.root.keys.includes(opts.keyId) ?? false
  if (!inNew && !inOld) throw new TrustToolError(`${opts.keyId} is not one of this root's (or its predecessor's) root keys`)
  const sig = await (opts.sign ?? sshKeygenSigner)(text, opts.keyFile, TRUST_NAMESPACES.root)
  const verifies = (root: ParsedRoot) => verifySshSig(sig, utf8(text), TRUST_NAMESPACES.root, root.keys.get(opts.keyId)!, crypto)
  if (!((inNew && verifies(next)) || (inOld && previous && verifies(previous)))) {
    throw new TrustToolError(`the signature is not ${opts.keyId}'s (another key file?)`)
  }
  const signatures = [...(existing?.signatures ?? []).filter(s => s.key_id !== opts.keyId), { key_id: opts.keyId, sig }]
  const envelope: SignedEnvelope = { signed: text, signatures }
  await writeAtomic(opts.out, envelopeText(envelope))
  const newThreshold = openEnvelope(envelope, TRUST_NAMESPACES.root, next.keys, next.document.roles.root, crypto).ok
  const predecessorThreshold = previous ? openEnvelope(envelope, TRUST_NAMESPACES.root, previous.keys, previous.document.roles.root, crypto).ok : null
  const complete = previous ? stepRoot(previous, envelope, crypto).ok : newThreshold
  return { signatures: signatures.length, newThreshold, predecessorThreshold, complete }
}

/** The owner's first check of a real signing key (v3.1 §6): sign through the agent, verify with the core. */
export async function checkSigningKey(opts: { publicKeyFile: string; role: string; sign?: TrustSigner }): Promise<{ type: string; base64: string }> {
  if (!(TRUST_ROLES as readonly string[]).includes(opts.role)) throw new TrustToolError(`--role must be one of ${TRUST_ROLES.join(', ')}`)
  const role = opts.role as TrustRoleName
  const line = (await readFile(opts.publicKeyFile, 'utf8')).trim().split(/\s+/)
  const key = parseRootKey(line[1])
  if (!key.ok) throw new TrustToolError(`not an OpenSSH public key this app reads: ${key.error}`)
  if (!ROLE_KEY_TYPES[role].includes(key.key.type)) throw new TrustToolError(`a ${role} key must be ${ROLE_KEY_TYPES[role].join(' or ')}, not ${key.key.type}`)
  const text = `acb trust key check ${trustTime(Date.now())}`
  const namespace = TRUST_NAMESPACES[role]
  const sig = await (opts.sign ?? sshKeygenSigner)(text, opts.publicKeyFile, namespace)
  if (!verifySshSig(sig, utf8(text), namespace, key.key, crypto)) throw new TrustToolError('the agent signed, but the app\'s verification does not accept it')
  return { type: key.key.type, base64: line[1] }
}

// ---------------------------------------------------------------- the operator's install

/** Copy every `*.json` of `from` into `to` (plain files only); a folder that cannot be read refuses. */
async function copyJsonFiles(from: string, to: string, what: string): Promise<void> {
  let names: string[]
  try { names = await readdir(from) } catch { throw new TrustToolError(`${what}: ${from} cannot be read (nothing was installed)`) }
  await mkdir(to)
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const st = await lstat(join(from, name))
    if (!st.isFile()) throw new TrustToolError(`${what}/${name}: not a plain file`)
    await cp(join(from, name), join(to, name))
  }
}

export interface InstallResult {
  /** The dot folder `trust` now points at. */
  folder: string
  /** Companies installed from the new checkouts. */
  companies: string[]
  /** Companies whose new documents did not verify but whose installed ones still do: kept as they were. */
  kept: string[]
  /** Companies left without documents (new ones did not verify, nothing usable installed before), with the reason. */
  refused: Array<{ companyId: string; reason: string }>
}

/**
 * Put the trust documents into `<pluginsDir>/trust`: copy `root/` and `targets/` from the main
 * branch's checkout and `freshness/` from the freshness branch's into a new dot folder, check each
 * company there, then point the `trust` link at it with one rename and remove the previous folder.
 *
 * - A source folder that cannot be read refuses the whole install (never "no companies").
 * - No company at all refuses unless `allowEmpty` (an explicit choice to hand out no list).
 * - A root version installed now and missing from the new `root/` refuses the whole install:
 *   apps may carry it (a removed root could not be re-authenticated from there).
 * - One company's documents that do not verify do not block the others: its previously installed
 *   documents are kept when they still verify, else it is left out; both are reported. When no
 *   company verifies at all, nothing is installed.
 * A `trust` that is a real folder (made by hand) is moved aside once.
 */
export async function installTrust(opts: {
  mainDir: string; freshnessDir: string; pluginsDir: string; server: string; now?: number; allowEmpty?: boolean
}): Promise<InstallResult> {
  const server = trustServerOf(opts.server)
  if (!server) throw new TrustToolError('--server must be http(s)://host[:port], exactly as PUBLIC_URL')
  const now = opts.now ?? Date.now()
  const link = join(opts.pluginsDir, 'trust')
  const folder = `.trust-${trustTime(now).replace(/[-:]/g, '')}-${randomBytes(3).toString('hex')}`
  const staging = join(opts.pluginsDir, folder)
  await mkdir(staging)
  try {
    await copyJsonFiles(join(opts.mainDir, 'root'), join(staging, 'root'), 'root')
    await copyJsonFiles(join(opts.mainDir, 'targets'), join(staging, 'targets'), 'targets')
    await copyJsonFiles(join(opts.freshnessDir, 'freshness'), join(staging, 'freshness'), 'freshness')
    const roots = await rootTexts(staging)
    if (roots.length === 0) throw new TrustToolError('no root in root/ (nothing was installed)')
    const installed = await lstat(link).catch(() => null) ? link : null
    if (installed) {
      const before = (await readdir(join(installed, 'root')).catch(() => [] as string[])).filter(n => TRUST_ROOT_FILE_RE.test(n))
      const after = new Set(await readdir(join(staging, 'root')))
      const gone = before.filter(n => !after.has(n)).sort()
      if (gone.length > 0) throw new TrustToolError(`the new root/ lacks ${gone.join(', ')}, which apps may carry: never remove a root version (nothing was installed)`)
    }
    const companies = await companyIdsIn(join(staging, 'targets'))
    if (companies.length === 0 && !opts.allowEmpty) throw new TrustToolError('no company list in targets/ (nothing was installed; --allow-empty yes to hand out none on purpose)')
    const good: string[] = []
    const kept: string[] = []
    const refused: InstallResult['refused'] = []
    for (const companyId of companies) {
      const files = companyTrustFiles(companyId)
      if (!files) { refused.push({ companyId, reason: 'not a company id' }); continue }
      const ctx = { server, companyId, now }
      const verifies = async (dir: string) => {
        const s = companyTrustToServe({ roots, targets: await readIf(join(dir, files.targets)), freshness: await readIf(join(dir, files.freshness)) }, ctx, crypto)
        return s.documents.targets && s.documents.freshness ? null : s.notes.join('; ') || 'does not verify'
      }
      const problem = await verifies(staging)
      if (!problem) { good.push(companyId); continue }
      for (const rel of [files.targets, files.freshness]) await rm(join(staging, rel), { force: true })
      if (installed && !(await verifies(installed))) {
        for (const rel of [files.targets, files.freshness]) await cp(join(installed, rel), join(staging, rel))
        kept.push(companyId)
      }
      refused.push({ companyId, reason: problem })
    }
    if (companies.length > 0 && good.length === 0) {
      throw new TrustToolError(`no company's documents verify (nothing was installed):\n  ${refused.map(r => `company ${r.companyId}: ${r.reason}`).join('\n  ')}`)
    }
    // Swap: a new link beside the old one, renamed over it (one rename; the api reads either whole set).
    const st = await lstat(link).catch(() => null)
    if (st && !st.isSymbolicLink()) await rename(link, join(opts.pluginsDir, `.trust-by-hand-${randomBytes(3).toString('hex')}`))
    const previous = st?.isSymbolicLink() ? await readlink(link) : null
    const tmpLink = join(opts.pluginsDir, `.trust-link-${randomBytes(6).toString('hex')}`)
    await symlink(folder, tmpLink)
    await rename(tmpLink, link)
    if (previous && /^\.trust-[0-9TZ]+-[0-9a-f]{6}$/.test(previous)) await rm(join(opts.pluginsDir, previous), { recursive: true, force: true })
    return { folder, companies: good, kept, refused }
  } catch (e) {
    const linked = await readlink(link).catch(() => null)
    if (linked !== folder) await rm(staging, { recursive: true, force: true })
    throw e
  }
}
