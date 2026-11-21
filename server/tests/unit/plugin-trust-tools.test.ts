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
  for (const n of ['root-1', 'root-2', 'root-3', 'fresh']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ACB TEST KEY', '-f', key(n)])
  execFileSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-b', '256', '-N', '', '-C', 'ACB TEST KEY', '-f', key('targets')])
  const root = {
    _type: 'acb-root', version: 1, expires: trustTime(Date.now() + 365 * 86_400_000),
    keys: { 'root-1': pub('root-1'), 'root-2': pub('root-2'), 'root-3': pub('root-3'), targets: pub('targets'), fresh: pub('fresh') },
    roles: { root: { keys: ['root-1', 'root-2', 'root-3'], threshold: 2 }, targets: { keys: ['targets'], threshold: 1 }, freshness: { keys: ['fresh'], threshold: 1 } },
  }
  mkdirSync(join(work, 'main', 'root'), { recursive: true })
  writeFileSync(join(work, 'root.json'), `${JSON.stringify(root, null, 1)}\n`)
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('signing', () => {
  it('O1 a root collects one root key\'s signature at a time; a key the root does not list, or a signature by another key, is refused', async () => {
    const out = join(work, 'main', 'root', '1.json')
    await expect(signRoot({ rootFile: join(work, 'root.json'), keyFile: key('targets'), keyId: 'targets', out })).rejects.toThrow(/not one of this root's root keys/)
    await expect(signRoot({ rootFile: join(work, 'root.json'), keyFile: key('root-2'), keyId: 'root-1', out })).rejects.toThrow(/not root-1's/)
    expect(existsSync(out)).toBe(false)
    expect(await signRoot({ rootFile: join(work, 'root.json'), keyFile: key('root-1'), keyId: 'root-1', out })).toEqual({ signatures: 1 })
    expect(await signRoot({ rootFile: out, keyFile: key('root-2'), keyId: 'root-2', out })).toEqual({ signatures: 2 })
    expect(companyTrustToServe({ roots: [readFileSync(out, 'utf8')], targets: null, freshness: null }, { server: SERVER, companyId: 'c1', now: Date.now() }, C).documents.roots).toHaveLength(1)
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
  })

  it('O3 freshness documents bound to each company\'s list, the next version each time, at most 3 days', async () => {
    const out = join(work, 'fresh-branch')
    await expect(signFreshness({ listsDir: join(work, 'main'), outDir: out, server: SERVER, keyFile: key('fresh'), keyId: 'fresh', days: 4 })).rejects.toThrow(/3 days/)
    expect(await signFreshness({ listsDir: join(work, 'main'), outDir: out, server: SERVER, keyFile: key('fresh'), keyId: 'fresh' })).toEqual([{ companyId: 'c1', version: 1 }])
    expect(await signFreshness({ listsDir: join(work, 'main'), outDir: out, server: SERVER, keyFile: key('fresh'), keyId: 'fresh' })).toEqual([{ companyId: 'c1', version: 2 }])
    const served = companyTrustToServe({
      roots: [readFileSync(join(work, 'main', 'root', '1.json'), 'utf8')],
      targets: readFileSync(join(work, 'main', 'targets', 'company-c1.json'), 'utf8'),
      freshness: readFileSync(join(out, 'freshness', 'company-c1.json'), 'utf8'),
    }, { server: SERVER, companyId: 'c1', now: Date.now() }, C)
    expect(served.documents.freshness).not.toBeNull()
  })

  it('O4 the owner\'s key check: signs through the given key and verifies with the app\'s code; a key of the wrong type for the role is refused', async () => {
    expect(await checkSigningKey({ publicKeyFile: `${key('targets')}.pub`, role: 'targets', sign: signWith('targets') })).toMatchObject({ type: 'ecdsa-sha2-nistp256' })
    await expect(checkSigningKey({ publicKeyFile: `${key('fresh')}.pub`, role: 'targets', sign: signWith('fresh') })).rejects.toThrow(/must be ecdsa-sha2-nistp256/)
    await expect(checkSigningKey({ publicKeyFile: `${key('targets')}.pub`, role: 'targets', sign: signWith('root-1') })).rejects.toThrow(TrustToolError)
  })
})

describe('the operator\'s install', () => {
  it('I1 installs all at once through a link swap; the api reads the new set; the previous folder goes', async () => {
    const plugins = join(work, 'plugins')
    mkdirSync(plugins)
    const first = await installTrust({ mainDir: join(work, 'main'), freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER })
    expect(first.companies).toEqual(['c1'])
    expect(lstatSync(join(plugins, 'trust')).isSymbolicLink()).toBe(true)
    expect((await diskPluginTrustFiles(plugins).read('c1'))?.freshness).toBeTruthy()
    const second = await installTrust({ mainDir: join(work, 'main'), freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER, now: Date.now() + 1000 })
    expect(readlinkSync(join(plugins, 'trust'))).toBe(second.folder)
    expect(existsSync(join(plugins, first.folder))).toBe(false)
  })

  it('I2 a list or freshness that does not verify refuses the whole install; trust/ stays as it was', async () => {
    const plugins = join(work, 'plugins')
    const before = readlinkSync(join(plugins, 'trust'))
    const badMain = join(work, 'bad-main')
    execFileSync('cp', ['-R', join(work, 'main'), badMain])
    const list = join(badMain, 'targets', 'company-c1.json')
    writeFileSync(list, readFileSync(list, 'utf8').replace('lstep', 'evil'))
    await expect(installTrust({ mainDir: badMain, freshnessDir: join(work, 'fresh-branch'), pluginsDir: plugins, server: SERVER })).rejects.toThrow(/nothing was installed/)
    expect(readlinkSync(join(plugins, 'trust'))).toBe(before)
    // without a freshness document the company's code could not run: refused too
    await expect(installTrust({ mainDir: join(work, 'main'), freshnessDir: join(work, 'empty'), pluginsDir: plugins, server: SERVER })).rejects.toThrow(/no freshness document/)
    expect(readlinkSync(join(plugins, 'trust'))).toBe(before)
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
