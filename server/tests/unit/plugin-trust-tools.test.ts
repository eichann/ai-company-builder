/**
 * The owner's and operator's plugin trust tools (adapters/plugin-trust-tools.ts,
 * `.claude/rules/plugin-trust.md` "Owner steps") with real `ssh-keygen` and keys made here for the
 * test only (deleted afterwards): a root signed key by key, a company's list from reviewed tags, the
 * daily freshness documents, the operator's install that swaps `trust/` in one rename, and the
 * owner's key check. Each refusal writes nothing. Mutation-checked (the rule lists the guards).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TrustToolError, checkSigningKey, installTrust, reviewedPackage, signFreshness, signRoot, signTargets, sshKeygenSigner, trustTime,
} from '../../src/adapters/plugin-trust-tools'
import { packageFingerprintV2 } from '../../src/adapters/plugin-collect'
import { diskPluginTrustFiles } from '../../src/adapters/plugin-trust-files'
import { nodePluginTrustCrypto as C } from '../../src/adapters/plugin-trust-crypto'
import { companyTrustToServe } from '../../../shared/core/plugin-trust-distribution'

const SERVER = 'https://acb.example'
let work: string
const key = (n: string) => join(work, 'keys', n)
const pub = (n: string) => readFileSync(`${key(n)}.pub`, 'utf8').trim().split(/\s+/)[1]
const signWith = (name: string) => (text: string, _file: string, ns: string) => sshKeygenSigner(text, key(name), ns)
const pkg = { id: 'lstep', version: '0.3.0', fingerprint: 'a'.repeat(64), commit: 'c'.repeat(40), tag: 'lstep@0.3.0' }

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'acb-trust-tools-'))
  mkdirSync(join(work, 'keys'))
  for (const n of ['root-1', 'root-2', 'root-3', 'root-4', 'root-5', 'fresh']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ACB TEST KEY', '-f', key(n)])
  execFileSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-b', '256', '-N', '', '-C', 'ACB TEST KEY', '-f', key('targets')])
  const root = {
    _type: 'acb-root', version: 1, expires: trustTime(Date.now() + 365 * 86_400_000),
    keys: { 'root-1': pub('root-1'), 'root-2': pub('root-2'), 'root-3': pub('root-3'), targets: pub('targets'), fresh: pub('fresh') },
    roles: { root: { keys: ['root-1', 'root-2', 'root-3'], threshold: 2 }, targets: { keys: ['targets'], threshold: 1 }, freshness: { keys: ['fresh'], threshold: 1 } },
  }
  mkdirSync(join(work, 'main', 'root'), { recursive: true })
  writeFileSync(join(work, 'root.json'), `${JSON.stringify(root, null, 1)}\n`)
  // v2 replaces two of the three root keys (root-2, root-3 → root-4, root-5)
  const v2 = { ...root, version: 2, keys: { 'root-1': pub('root-1'), 'root-4': pub('root-4'), 'root-5': pub('root-5'), targets: pub('targets'), fresh: pub('fresh') },
    roles: { ...root.roles, root: { keys: ['root-1', 'root-4', 'root-5'], threshold: 2 } } }
  writeFileSync(join(work, 'root-v2.json'), `${JSON.stringify(v2, null, 1)}\n`)
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('signing', () => {
  it('O1 a root collects one root key\'s signature at a time; a key the root does not list, or a signature by another key, is refused', async () => {
    const out = join(work, 'main', 'root', '1.json')
    await expect(signRoot({ rootFile: join(work, 'root.json'), keyFile: key('targets'), keyId: 'targets', out })).rejects.toThrow(/not one of this root's \(or its predecessor's\) root keys/)
    await expect(signRoot({ rootFile: join(work, 'root.json'), keyFile: key('root-2'), keyId: 'root-1', out })).rejects.toThrow(/not root-1's/)
    expect(existsSync(out)).toBe(false)
    expect(await signRoot({ rootFile: join(work, 'root.json'), keyFile: key('root-1'), keyId: 'root-1', out })).toMatchObject({ signatures: 1, complete: false })
    expect(await signRoot({ rootFile: out, keyFile: key('root-2'), keyId: 'root-2', out })).toEqual({ signatures: 2, newThreshold: true, predecessorThreshold: null, complete: true })
    expect(companyTrustToServe({ roots: [readFileSync(out, 'utf8')], targets: null, freshness: null }, { server: SERVER, companyId: 'c1', now: Date.now() }, C).documents.roots).toHaveLength(1)
  })

  it('O1b a rotation that replaces two of three root keys: the removed keys sign as the predecessor\'s, both thresholds are needed', async () => {
    const out = join(work, 'rot', '2.json')
    mkdirSync(join(work, 'rot'), { recursive: true })
    const v2 = join(work, 'root-v2.json')
    const v1 = join(work, 'main', 'root', '1.json')
    // without the predecessor a removed key cannot sign the new root
    await expect(signRoot({ rootFile: v2, keyFile: key('root-2'), keyId: 'root-2', out })).rejects.toThrow(/not one of this root's/)
    await expect(signRoot({ rootFile: v2, keyFile: key('root-2'), keyId: 'root-2', out, predecessor: join(work, 'root.json') })).rejects.toThrow(/predecessor is not a signed root/)
    expect(await signRoot({ rootFile: v2, keyFile: key('root-2'), keyId: 'root-2', out, predecessor: v1 }))
      .toEqual({ signatures: 1, newThreshold: false, predecessorThreshold: false, complete: false })
    expect(await signRoot({ rootFile: out, keyFile: key('root-3'), keyId: 'root-3', out, predecessor: v1 }))
      .toEqual({ signatures: 2, newThreshold: false, predecessorThreshold: true, complete: false })
    expect(await signRoot({ rootFile: out, keyFile: key('root-4'), keyId: 'root-4', out, predecessor: v1 }))
      .toEqual({ signatures: 3, newThreshold: false, predecessorThreshold: true, complete: false })
    expect(await signRoot({ rootFile: out, keyFile: key('root-5'), keyId: 'root-5', out, predecessor: v1 }))
      .toEqual({ signatures: 4, newThreshold: true, predecessorThreshold: true, complete: true })
    // a removed key's signature is checked against the predecessor's key: another key under its id is refused
    await expect(signRoot({ rootFile: out, keyFile: key('root-4'), keyId: 'root-2', out, predecessor: v1 })).rejects.toThrow(/not root-2's/)
    const served = companyTrustToServe({ roots: [readFileSync(v1, 'utf8'), readFileSync(out, 'utf8')], targets: null, freshness: null }, { server: SERVER, companyId: 'c1', now: Date.now() }, C)
    expect(served.documents.roots).toHaveLength(2)
  })

  it('O1c the new keys alone are not a complete rotation; a predecessor below its own threshold is refused', async () => {
    const v2 = join(work, 'root-v2.json')
    const v1 = join(work, 'main', 'root', '1.json')
    const out = join(work, 'rot-new-only.json')
    await signRoot({ rootFile: v2, keyFile: key('root-4'), keyId: 'root-4', out, predecessor: v1 })
    expect(await signRoot({ rootFile: out, keyFile: key('root-5'), keyId: 'root-5', out, predecessor: v1 }))
      .toEqual({ signatures: 2, newThreshold: true, predecessorThreshold: false, complete: false })
    const weak = JSON.parse(readFileSync(v1, 'utf8'))
    weak.signatures = weak.signatures.slice(0, 1)
    writeFileSync(join(work, 'weak-v1.json'), JSON.stringify(weak))
    await expect(signRoot({ rootFile: v2, keyFile: key('root-2'), keyId: 'root-2', out: join(work, 'never.json'), predecessor: join(work, 'weak-v1.json') }))
      .rejects.toThrow(/predecessor is not a signed root/)
    expect(existsSync(join(work, 'never.json'))).toBe(false)
  })

  it('O2 a company\'s list: the next version, verified against the roots before it is written; another key is refused with nothing written', async () => {
    const main = join(work, 'main')
    await expect(signTargets({ trustDir: main, companyId: 'c1', server: SERVER, packages: [pkg], keyFile: key('fresh'), keyId: 'targets', sign: signWith('fresh') }))
      .rejects.toThrow(/does not verify/)
    expect(existsSync(join(main, 'targets', 'company-c1.json'))).toBe(false)
    await expect(signTargets({ trustDir: main, companyId: 'c1', server: `${SERVER}/x`, packages: [pkg], keyFile: key('targets'), keyId: 'targets' })).rejects.toThrow(/--server/)
    await expect(signTargets({ trustDir: main, companyId: 'c1', server: SERVER, packages: [pkg], keyFile: key('targets'), keyId: 'targets', days: 91 })).rejects.toThrow(/90 days/)
    expect(await signTargets({ trustDir: main, companyId: 'c1', server: SERVER, packages: [pkg], keyFile: key('targets'), keyId: 'targets' })).toMatchObject({ version: 1 })
    expect(await signTargets({ trustDir: main, companyId: 'c1', server: SERVER, packages: [pkg], floors: { lstep: '0.3.0' }, keyFile: key('targets'), keyId: 'targets' })).toMatchObject({ version: 2 })
    expect(await signTargets({ trustDir: main, companyId: 'c2', server: SERVER, packages: [pkg], keyFile: key('targets'), keyId: 'targets' })).toMatchObject({ version: 1 })
  })

  it('O2b an existing list whose version cannot be read refuses to sign (never starts again at v1)', async () => {
    const dir = join(work, 'unreadable-main')
    mkdirSync(join(dir, 'targets'), { recursive: true })
    execFileSync('cp', ['-R', join(work, 'main', 'root'), join(dir, 'root')])
    writeFileSync(join(dir, 'targets', 'company-c1.json'), '{ damaged')
    await expect(signTargets({ trustDir: dir, companyId: 'c1', server: SERVER, packages: [pkg], keyFile: key('targets'), keyId: 'targets' })).rejects.toThrow(/next version is unknown/)
    expect(readFileSync(join(dir, 'targets', 'company-c1.json'), 'utf8')).toBe('{ damaged')
  })

  it('O3 freshness documents bound to each company\'s list, the next version each time, at most 3 days', async () => {
    const out = join(work, 'fresh-branch')
    await expect(signFreshness({ listsDir: join(work, 'main'), outDir: out, server: SERVER, keyFile: key('fresh'), keyId: 'fresh', days: 4 })).rejects.toThrow(/3 days/)
    expect(await signFreshness({ listsDir: join(work, 'main'), outDir: out, server: SERVER, keyFile: key('fresh'), keyId: 'fresh' }))
      .toEqual({ signed: [{ companyId: 'c1', version: 1 }, { companyId: 'c2', version: 1 }], refused: [] })
    expect(await signFreshness({ listsDir: join(work, 'main'), outDir: out, server: SERVER, keyFile: key('fresh'), keyId: 'fresh' }))
      .toEqual({ signed: [{ companyId: 'c1', version: 2 }, { companyId: 'c2', version: 2 }], refused: [] })
    const served = companyTrustToServe({
      roots: [readFileSync(join(work, 'main', 'root', '1.json'), 'utf8')],
      targets: readFileSync(join(work, 'main', 'targets', 'company-c1.json'), 'utf8'),
      freshness: readFileSync(join(out, 'freshness', 'company-c1.json'), 'utf8'),
    }, { server: SERVER, companyId: 'c1', now: Date.now() }, C)
    expect(served.documents.freshness).not.toBeNull()
  })

  it('O3b one company\'s broken list does not block the others\' freshness', async () => {
    const lists = join(work, 'lists-one-broken')
    execFileSync('cp', ['-R', join(work, 'main'), lists])
    const c2 = join(lists, 'targets', 'company-c2.json')
    writeFileSync(c2, readFileSync(c2, 'utf8').replace('lstep', 'evil'))
    const r = await signFreshness({ listsDir: lists, outDir: join(work, 'fresh-one-broken'), server: SERVER, keyFile: key('fresh'), keyId: 'fresh' })
    expect(r.signed).toEqual([{ companyId: 'c1', version: 1 }])
    expect(r.refused).toEqual([{ companyId: 'c2', reason: expect.stringMatching(/does not verify/) }])
    await expect(signFreshness({ listsDir: join(work, 'no-such'), outDir: join(work, 'x'), server: SERVER, keyFile: key('fresh'), keyId: 'fresh' })).rejects.toThrow(/cannot be read/)
  })

  it('O4 the owner\'s key check: signs through the given key and verifies with the app\'s code; a key of the wrong type for the role is refused', async () => {
    expect(await checkSigningKey({ publicKeyFile: `${key('targets')}.pub`, role: 'targets', sign: signWith('targets') })).toMatchObject({ type: 'ecdsa-sha2-nistp256' })
    await expect(checkSigningKey({ publicKeyFile: `${key('fresh')}.pub`, role: 'targets', sign: signWith('fresh') })).rejects.toThrow(/must be ecdsa-sha2-nistp256/)
    await expect(checkSigningKey({ publicKeyFile: `${key('targets')}.pub`, role: 'targets', sign: signWith('root-1') })).rejects.toThrow(TrustToolError)
    await expect(checkSigningKey({ publicKeyFile: `${key('targets')}.pub`, role: 'toString', sign: signWith('targets') })).rejects.toThrow(/--role must be one of/)
  })
})

describe('the operator\'s install', () => {
  it('I1 installs all at once through a link swap; the api reads the new set; the previous folder goes', async () => {
    const plugins = join(work, 'plugins')
    mkdirSync(plugins)
    const first = await installTrust({ mainDir: join(work, 'main'), freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER })
    expect(first).toMatchObject({ companies: ['c1', 'c2'], kept: [], refused: [] })
    expect(lstatSync(join(plugins, 'trust')).isSymbolicLink()).toBe(true)
    expect((await diskPluginTrustFiles(plugins).read('c1'))?.freshness).toBeTruthy()
    const second = await installTrust({ mainDir: join(work, 'main'), freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER, now: Date.now() + 1000 })
    expect(readlinkSync(join(plugins, 'trust'))).toBe(second.folder)
    expect(existsSync(join(plugins, first.folder))).toBe(false)
  })

  it('I2 when no company\'s documents verify, nothing is installed; trust/ stays as it was', async () => {
    const plugins = join(work, 'plugins')
    const before = readlinkSync(join(plugins, 'trust'))
    const badMain = join(work, 'bad-main')
    execFileSync('cp', ['-R', join(work, 'main'), badMain])
    for (const c of ['c1', 'c2']) {
      const list = join(badMain, 'targets', `company-${c}.json`)
      writeFileSync(list, readFileSync(list, 'utf8').replace('lstep', 'evil'))
    }
    await expect(installTrust({ mainDir: badMain, freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER })).rejects.toThrow(/nothing was installed/)
    expect(readlinkSync(join(plugins, 'trust'))).toBe(before)
  })

  it('I3 a source folder that cannot be read (or is missing) refuses the install, never "no companies"', async () => {
    const plugins = join(work, 'plugins')
    const before = readlinkSync(join(plugins, 'trust'))
    const noTargets = join(work, 'main-without-targets')
    mkdirSync(noTargets)
    execFileSync('cp', ['-R', join(work, 'main', 'root'), join(noTargets, 'root')])
    await expect(installTrust({ mainDir: noTargets, freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER })).rejects.toThrow(/targets: .* cannot be read/)
    await expect(installTrust({ mainDir: join(work, 'main'), freshnessDir: join(work, 'no-such-branch'), pluginsDir: plugins, server: SERVER })).rejects.toThrow(/freshness: .* cannot be read/)
    expect(readlinkSync(join(plugins, 'trust'))).toBe(before)
    expect((await diskPluginTrustFiles(plugins).read('c1'))?.targets).toBeTruthy()
  })

  it('I4 no company list at all is refused unless asked for explicitly', async () => {
    const plugins = join(work, 'plugins-empty')
    mkdirSync(plugins)
    const emptyMain = join(work, 'main-empty')
    mkdirSync(join(emptyMain, 'targets'), { recursive: true })
    execFileSync('cp', ['-R', join(work, 'main', 'root'), join(emptyMain, 'root')])
    await expect(installTrust({ mainDir: emptyMain, freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER })).rejects.toThrow(/no company list/)
    expect(existsSync(join(plugins, 'trust'))).toBe(false)
    expect(await installTrust({ mainDir: emptyMain, freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER, allowEmpty: true })).toMatchObject({ companies: [] })
  })

  it('I5 a root version installed now and missing from the new set refuses the install', async () => {
    const plugins = join(work, 'plugins')
    const withV2 = join(work, 'main-with-v2')
    execFileSync('cp', ['-R', join(work, 'main'), withV2])
    execFileSync('cp', [join(work, 'rot', '2.json'), join(withV2, 'root', '2.json')])
    const r = await installTrust({ mainDir: withV2, freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER, now: Date.now() + 2000 })
    expect(r.refused).toEqual([])
    await expect(installTrust({ mainDir: join(work, 'main'), freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER, now: Date.now() + 3000 }))
      .rejects.toThrow(/lacks 2\.json/)
    expect(readlinkSync(join(plugins, 'trust'))).toBe(r.folder)
  })

  it('I6 one company\'s broken documents do not block the others: its installed ones are kept when they still verify, else it is left out', async () => {
    const plugins = join(work, 'plugins')
    const oneBad = join(work, 'main-one-bad')
    execFileSync('cp', ['-R', join(work, 'main-with-v2'), oneBad])
    const c2 = join(oneBad, 'targets', 'company-c2.json')
    writeFileSync(c2, readFileSync(c2, 'utf8').replace('lstep', 'evil'))
    const r = await installTrust({ mainDir: oneBad, freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER, now: Date.now() + 4000 })
    expect(r).toMatchObject({ companies: ['c1'], kept: ['c2'], refused: [{ companyId: 'c2' }] })
    expect((await diskPluginTrustFiles(plugins).read('c2'))?.targets).toBe(readFileSync(join(work, 'main', 'targets', 'company-c2.json'), 'utf8'))
    // a company with nothing usable installed before is left out (never its broken documents)
    const fresh = join(work, 'plugins-fresh')
    mkdirSync(fresh)
    const r2 = await installTrust({ mainDir: oneBad, freshnessDir: join(work, 'fresh-branch'), pluginsDir: fresh, server: SERVER })
    expect(r2).toMatchObject({ companies: ['c1'], kept: [], refused: [{ companyId: 'c2' }] })
    expect((await diskPluginTrustFiles(fresh).read('c2'))?.targets).toBeNull()
  })
})

describe('a reviewed package', () => {
  let repo: string
  let fingerprint: string
  beforeAll(async () => {
    repo = join(work, 'plugin-repo')
    const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' })
    mkdirSync(join(repo, 'lstep@0.3.0'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, 'lstep@0.3.0', 'plugin.yaml'), 'id: lstep\nversion: 0.3.0\n')
    g('add', '.'); g('commit', '-qm', 'reviewed'); g('tag', 'lstep@0.3.0')
    g('checkout', '-qb', 'side')
    mkdirSync(join(repo, 'lstep@0.4.0'))
    writeFileSync(join(repo, 'lstep@0.4.0', 'plugin.yaml'), 'id: lstep\nversion: 0.4.0\n')
    g('add', '.'); g('commit', '-qm', 'not merged'); g('tag', 'lstep@0.4.0')
    g('checkout', '-q', 'main')
    fingerprint = await packageFingerprintV2(join(repo, 'lstep@0.3.0'))
  })

  it('R1 a tag on main with the lock\'s fingerprint becomes a list entry with its commit', async () => {
    const entry = await reviewedPackage({ repo, pkg: 'lstep@0.3.0', fingerprint })
    expect(entry).toMatchObject({ id: 'lstep', version: '0.3.0', fingerprint, tag: 'lstep@0.3.0' })
    expect(entry.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('R2 a tag not on main (unreviewed) is refused; a fingerprint that differs from the lock is refused', async () => {
    await expect(reviewedPackage({ repo, pkg: 'lstep@0.4.0', fingerprint })).rejects.toThrow(/not on main/)
    await expect(reviewedPackage({ repo, pkg: 'lstep@0.3.0', fingerprint: 'b'.repeat(64) })).rejects.toThrow(/does not match the lock/)
  })
})
