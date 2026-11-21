/**
 * Plugin trust P2 on the server (`.claude/rules/plugin-trust.md` "P2"): what one company's members
 * are handed (`companyTrustToServe`, the core's rules with the server's crypto adapter) and how the
 * operator's `trust/` folder is read (`adapters/plugin-trust-files.ts`). The fixtures are the app's
 * P1 fixtures (real `ssh-keygen`, test keys only), read from the client's folder so both sides
 * verify the same bytes. Each guard is mutation-checked (the rule lists them).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { companyTrustFiles, companyTrustToServe, trustServerOf, type CompanyTrustTexts } from '../../../shared/core/plugin-trust-distribution'
import type { SignedEnvelope } from '../../../shared/core/plugin-trust-documents'
import { nodePluginTrustCrypto as C } from '../../src/adapters/plugin-trust-crypto'
import { diskPluginTrustFiles } from '../../src/adapters/plugin-trust-files'

const FIX = join(__dirname, '../../../client/tests/fixtures/plugin-trust/documents.json')
const DOCS = JSON.parse(readFileSync(FIX, 'utf8')) as Record<string, SignedEnvelope>
const text = (name: string) => { expect(DOCS[name], name).toBeTruthy(); return JSON.stringify(DOCS[name]) }
const NOW = Date.parse('2026-11-21T12:00:00Z')
const CTX = { server: 'https://acb.example', companyId: 'c1', now: NOW }
const texts = (o: Partial<CompanyTrustTexts>): CompanyTrustTexts => ({ roots: [text('root-v1')], targets: null, freshness: null, ...o })

describe('what a company\'s members are handed', () => {
  it('V1 the chain, this company\'s list and its freshness, when each passes the app\'s own checks', () => {
    const s = companyTrustToServe(texts({ targets: text('t-c1-v5'), freshness: text('f-c1-v5') }), CTX, C)
    expect(s.documents).toEqual({ roots: [DOCS['root-v1']], targets: DOCS['t-c1-v5'], freshness: DOCS['f-c1-v5'] })
    expect(s.until).toBe(Date.parse('2026-11-24T00:00:00Z'))
    expect(s.notes).toEqual([])
  })

  it('V2 another company\'s list placed under this company\'s name is withheld (never handed to the wrong company)', () => {
    const s = companyTrustToServe(texts({ targets: text('t-c2-v5'), freshness: text('f-c1-v5') }), CTX, C)
    expect(s.documents.targets).toBeNull()
    expect(s.documents.freshness).toBeNull()
    expect(s.notes).toEqual(['list withheld: other-company'])
  })

  it('V3 another server\'s list is withheld; a freshness document for another list is withheld', () => {
    expect(companyTrustToServe(texts({ targets: text('t-c1-v5-staging') }), CTX, C).notes).toEqual(['list withheld: other-server'])
    const f = companyTrustToServe(texts({ targets: text('t-c1-v5'), freshness: text('f-c1-v6') }), CTX, C)
    expect(f.documents.targets).toEqual(DOCS['t-c1-v5'])
    expect(f.documents.freshness).toBeNull()
    expect(f.notes).toEqual(['freshness withheld: other-list'])
  })

  it('V4 a root conflict hands out nothing at all; a junk root file is skipped; the chain grows from the lowest root', () => {
    const conflict = companyTrustToServe(texts({ roots: [text('root-v1'), text('root-v2'), text('root-v2-conflict')], targets: text('t-c1-v5') }), CTX, C)
    expect(conflict.documents).toEqual({ roots: [], targets: null, freshness: null })
    expect(conflict.notes.join()).toMatch(/halted/)
    const grown = companyTrustToServe(texts({ roots: ['{junk', text('root-v3'), text('root-v2'), text('root-v1')], targets: text('t-c1-v6-tb') }), CTX, C)
    expect(grown.documents.roots).toEqual([DOCS['root-v1'], DOCS['root-v2'], DOCS['root-v3']])
    expect(grown.documents.targets).toEqual(DOCS['t-c1-v6-tb'])
    expect(grown.notes[0]).toMatch(/not a signed envelope/)
  })

  it('V5 no root that carries its own threshold → nothing is handed out', () => {
    const one = structuredClone(DOCS['root-v1']); one.signatures = one.signatures.slice(0, 1)
    expect(companyTrustToServe(texts({ roots: [JSON.stringify(one)], targets: text('t-c1-v5') }), CTX, C).documents).toEqual({ roots: [], targets: null, freshness: null })
  })

  it('V6 the server judges times by its own clock: a list issued ahead of it is withheld, an expired freshness too, and 48 hours before the end the operator is told', () => {
    const early = companyTrustToServe(texts({ targets: text('t-c1-v5') }), { ...CTX, now: Date.parse('2026-11-20T23:40:00Z') }, C)
    expect(early.notes).toEqual(['list withheld: issued-in-future'])
    const late = companyTrustToServe(texts({ targets: text('t-c1-v5'), freshness: text('f-c1-v5') }), { ...CTX, now: Date.parse('2026-11-24T00:00:01Z') }, C)
    expect(late.notes).toEqual(['freshness withheld: expired'])
    const soon = companyTrustToServe(texts({ targets: text('t-c1-v5'), freshness: text('f-c1-v5') }), { ...CTX, now: Date.parse('2026-11-22T01:00:00Z') }, C)
    expect(soon.notes).toEqual([expect.stringMatching(/^runs out in 47 h/)])
    expect(companyTrustToServe(texts({ targets: text('t-c1-v5'), freshness: text('f-c1-v5') }), CTX, C).notes).toEqual([])
  })

  it('V7 a server is named only as http(s)://host[:port]; a company id that cannot name a file names none', () => {
    expect(trustServerOf('https://acb.example/')).toBe('https://acb.example')
    expect(trustServerOf('https://acb.example/app')).toBeNull()
    expect(companyTrustFiles('c1')).toEqual({ targets: 'targets/company-c1.json', freshness: 'freshness/company-c1.json' })
    for (const bad of ['../c2', 'c1/../c2', '', '.hidden', 'a b']) expect(companyTrustFiles(bad)).toBeNull()
  })
})

describe('the operator\'s trust/ folder on disk', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acb-trust-files-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function place(base: string) {
    for (const sub of ['root', 'targets', 'freshness']) mkdirSync(join(base, sub), { recursive: true })
    writeFileSync(join(base, 'root', '1.json'), text('root-v1'))
    writeFileSync(join(base, 'targets', 'company-c1.json'), text('t-c1-v5'))
    writeFileSync(join(base, 'freshness', 'company-c1.json'), text('f-c1-v5'))
    writeFileSync(join(base, 'targets', 'company-c2.json'), text('t-c2-v5'))
  }

  it('F1 no PLUGINS_DIR or no trust/ = not set up; a company reads only its own two files', async () => {
    expect(await diskPluginTrustFiles(null).read('c1')).toBeNull()
    expect(await diskPluginTrustFiles(dir).read('c1')).toBeNull()
    place(join(dir, 'trust'))
    const c1 = await diskPluginTrustFiles(dir).read('c1')
    expect(c1).toEqual({ roots: [text('root-v1')], targets: text('t-c1-v5'), freshness: text('f-c1-v5'), problems: [] })
    const c2 = await diskPluginTrustFiles(dir).read('c2')
    expect(c2?.targets).toBe(text('t-c2-v5'))
    expect(c2?.freshness).toBeNull()
    const sneaky = await diskPluginTrustFiles(dir).read('../trust/targets/company-c1')
    expect(sneaky).toEqual({ roots: [text('root-v1')], targets: null, freshness: null, problems: [] })
  })

  it('F2 trust/ may be the operator\'s link to a dot folder; a link inside it is refused and named', async () => {
    place(join(dir, '.trust-a'))
    symlinkSync('.trust-a', join(dir, 'trust'))
    expect((await diskPluginTrustFiles(dir).read('c1'))?.targets).toBe(text('t-c1-v5'))
    rmSync(join(dir, '.trust-a', 'freshness', 'company-c1.json'))
    symlinkSync(join(dir, '.trust-a', 'targets', 'company-c1.json'), join(dir, '.trust-a', 'freshness', 'company-c1.json'))
    const read = await diskPluginTrustFiles(dir).read('c1')
    expect(read?.freshness).toBeNull()
    expect(read?.problems).toEqual(['freshness/company-c1.json'])
  })
})
