/**
 * Collecting packages into the shelf (adapters/plugin-collect.ts,
 * cli/collect-plugins.ts, `.claude/rules/plugins.md` "Where packages come
 * from"): the package at the lock's tag is put in byte for byte, a fingerprint
 * that differs from the lock or a published version with other content refuses
 * everything, other folders stay unless `prune`, and the fingerprint is the
 * shelf's own v2.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectPlugins, packageFingerprintV2, parsePluginsLock, type LockEntry } from '../../src/adapters/plugin-collect'
import { diskPluginShelf } from '../../src/adapters/plugin-shelf'

const FLOW = join(__dirname, '../fixtures/plugins/sample-flow')
let tmp: string
let repo: string
let shelf: string

const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' })

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'acb-collect-test-'))
  repo = join(tmp, 'repo')
  shelf = join(tmp, 'shelf')
  mkdirSync(shelf)
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  cpSync(FLOW, join(repo, 'sample-flow@0.2.0'), { recursive: true })
  mkdirSync(join(repo, 'other@1.0.0'))
  writeFileSync(join(repo, 'other@1.0.0/plugin.yaml'), 'id: other\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'v')
  git('tag', 'sample-flow@0.2.0')
  git('tag', 'other@1.0.0')
  execFileSync('git', ['clone', '-q', '--branch', 'sample-flow@0.2.0', repo, join(tmp, 'at-tag')], { stdio: 'pipe' })
  // After the tag, main changes the published folder: the tag's content is what counts.
  writeFileSync(join(repo, 'sample-flow@0.2.0/types/deal.md'), 'changed after the tag\n')
  git('commit', '-q', '-am', 'later')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** The lock line for a package, its fingerprint taken from the tag's own tree. */
const lockFor = async (pkg: string): Promise<LockEntry> => ({ repo, pkg, fingerprint: await packageFingerprintV2(join(tmp, 'at-tag', pkg)) })

describe('collect plugins', () => {
  it('puts the tagged package in byte for byte, with the fingerprint the shelf computes', async () => {
    const entry = await lockFor('sample-flow@0.2.0')
    writeFileSync(join(shelf, 'stopped'), 'other\n')
    cpSync(FLOW, join(shelf, 'kept@0.1.0'), { recursive: true })
    const result = await collectPlugins({ entries: [entry], dir: shelf })
    expect(result).toEqual({ added: ['sample-flow@0.2.0'], unchanged: [], removed: [] })
    expect(readFileSync(join(shelf, 'sample-flow@0.2.0/types/deal.md'))).toEqual(readFileSync(join(FLOW, 'types/deal.md')))
    expect(readdirSync(shelf).sort()).toEqual(['kept@0.1.0', 'sample-flow@0.2.0', 'stopped'])
    const files = await diskPluginShelf(shelf).files('sample-flow@0.2.0')
    expect(files?.fingerprintV2).toBe(entry.fingerprint)
    // Again: nothing to do.
    expect(await collectPlugins({ entries: [entry], dir: shelf })).toEqual({ added: [], unchanged: ['sample-flow@0.2.0'], removed: [] })
  })

  it('refuses everything when one fingerprint differs from the lock', async () => {
    const good = await lockFor('sample-flow@0.2.0')
    const bad: LockEntry = { repo, pkg: 'other@1.0.0', fingerprint: 'a'.repeat(64) }
    await expect(collectPlugins({ entries: [good, bad], dir: shelf })).rejects.toThrow(/other@1\.0\.0: fingerprint .* does not match the lock/)
    expect(readdirSync(shelf)).toEqual([])
  })

  it('never replaces a version already on the shelf with other content', async () => {
    const entry = await lockFor('sample-flow@0.2.0')
    cpSync(FLOW, join(shelf, 'sample-flow@0.2.0'), { recursive: true })
    writeFileSync(join(shelf, 'sample-flow@0.2.0/types/deal.md'), 'edited on the server\n')
    await expect(collectPlugins({ entries: [entry], dir: shelf })).rejects.toThrow(/never replaced/)
    expect(readFileSync(join(shelf, 'sample-flow@0.2.0/types/deal.md'), 'utf8')).toBe('edited on the server\n')
  })

  it('prune removes only package folders the lock does not list', async () => {
    const entry = await lockFor('sample-flow@0.2.0')
    writeFileSync(join(shelf, 'stopped'), '*\n')
    mkdirSync(join(shelf, 'old@0.0.1'))
    mkdirSync(join(shelf, 'notes'))
    const result = await collectPlugins({ entries: [entry], dir: shelf, prune: true })
    expect(result.removed).toEqual(['old@0.0.1'])
    expect(readdirSync(shelf).sort()).toEqual(['notes', 'sample-flow@0.2.0', 'stopped'])
  })

  it('reads the lock strictly', () => {
    const f = 'b'.repeat(64)
    expect(parsePluginsLock(`# comment\neichann/acb-connectors hubspot@0.3.0 ${f}  # trailing\n\n`))
      .toEqual([{ repo: 'eichann/acb-connectors', pkg: 'hubspot@0.3.0', fingerprint: f }])
    expect(() => parsePluginsLock(`r a@1.0.0 ${f}\nr a@1.0.0 ${f}\n`)).toThrow(/listed twice/)
    expect(() => parsePluginsLock(`r ../x@1.0.0 ${f}\n`)).toThrow(/not <id>@<version>/)
    expect(() => parsePluginsLock('r a@1.0.0 ABC\n')).toThrow(/fingerprint/)
  })
})
