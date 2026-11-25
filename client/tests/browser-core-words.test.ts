/**
 * 「本体はサイトの言葉を持たない」 (agent-browser.md "The tools' words"; design memo §3 I10, step ①): every text shipped to
 * all companies — the AI's browser tool descriptions and refusal words, `client/shared`, the admin console's texts and the
 * server's browser refusal words — names no site, job or field. Extends the server's §17-2 test (which covers the core
 * modules) to texts, and runs on two kinds of names:
 *
 * - a **fictional site sample** (`SAMPLE`, below), so the test keeps meaning something once a real site's data leaves the
 *   repository (step ⑦), and so the catalog — the one place a site's words may enter a tool's description — is shown to
 *   carry a site's words from its data only;
 * - every name the site data this repository still carries gives (`approved.json`'s declarations, `opened.json`'s maps and
 *   lines), so a new site is covered by itself.
 *
 * Read with the TypeScript scanner: string literals, template text and JSX text — the words people and the AI see —, not
 * comments or identifiers. Excluded, each with its reason: the site data files themselves (`EXCLUDED`), which stay until
 * step ⑦ removes them, and the old path's site-specific pieces (`OLD_PATH`), removed with it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parsePluginManifest } from '../../shared/core/plugins'
import type { BrowserOpenedFile, BrowserOpenedLine } from '../../shared/core/browser-opened'
import type { BrowserMap } from '../../shared/core/browser-map'
import { BROWSER_CATALOG_NONE, browserLineCatalog, browserOperationCatalog } from '../shared/browser-tool-catalog'
import { browserBrowseDescription, browserBrowseSchema, browserInspectDescription, browserInspectSchema, browserWriteDescription, browserWriteSchema, createBrowserInspectTools } from '../electron/browser-request/inspect-tool'
import { BROWSER_OPERATOR_BROWSE_PROMPT } from '../shared/browser-browse'
import { browserRequestDescription, browserRequestSchema, createBrowserRequestTools } from '../electron/browser-request/tools'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * A made-up site (no such service): a shop whose coupons the AI could check. Its words must reach a tool only through the
 * catalog built from its data.
 */
const SAMPLE = {
  site: { id: 'kumo_shop', label: 'くもショップ' },
  line: {
    name: 'coupon_inspect',
    version: '1.0.0',
    label: 'クーポンを点検する',
    read: {
      site: 'kumo_shop',
      values: { coupon: { kind: 'id', role: 'target', from: ['site_fact'] } },
      reads: [{ name: 'coupon', thing: 'coupon', id: { value: 'coupon' } }],
      checks: [],
    },
    readLabels: { coupon: '点検するクーポン' },
    show: [],
  } as unknown as BrowserOpenedLine,
  operation: { name: 'coupon_extend', label: 'クーポンの期限を延ばす', target: ['coupon_id'], change: ['until_date'] },
  words: ['kumo_shop', 'くもショップ', 'coupon_inspect', 'クーポン', 'coupon_extend', 'coupon_id', 'until_date'],
}

/**
 * Not scanned, and why. The site data stays in the repository until step ⑦ (design memo §12: removing it earlier breaks
 * the login before ② and the inspection before ⑤⑥); the old path (`lstep@0.6.x`) is removed with it.
 */
const EXCLUDED: Record<string, string> = {
  'client/connector-maps/lstep': 'a site map (data and its readers): removed in step ⑦',
  'client/browser-lines/lstep.ts': 'a site\'s opened lines (data): removed in step ⑦',
  'shared/browser-connectors/opened.json': 'the opened list (data): removed in step ⑦',
}

/**
 * The old path (`lstep@0.6.x`: one operation type with its own card and facts), not the site data but written for one
 * site's operation; it is removed with the data in step ⑦ (design memo §7-1, §12). Listed here so nothing else is skipped.
 */
const OLD_PATH: Record<string, string> = {
  'client/src/features/browser-plans/components/BrowserPlanCard.tsx': 'the old path\'s plan card (one operation\'s fields): removed in step ⑦',
  'client/src/features/browser-plans/model.ts': 'the old path\'s card words: removed in step ⑦',
  'shared/core/browser-plans.ts': 'the old path\'s facts schema for its one checker: removed in step ⑦',
}

/** What is scanned: everything shipped to all companies that people or the AI read as text. */
const SCANNED = [
  'client/shared',
  'client/src',
  'shared/core',
  'shared/types',
  'client/electron/browser-request',
  'client/electron/features/browser',
  'admin/src',
  'server/src/services/browser-lines.ts',
  'server/src/services/browser-line-steps.ts',
  'server/src/services/browser-site-grants.ts',
  'server/src/services/browser-plans.ts',
  'server/src/services/browser-devices.ts',
  'server/src/services/agent-browser.ts',
  'server/src/routes/browser-lines.ts',
  'server/src/routes/browser-plans.ts',
  'server/src/routes/browser-devices.ts',
  'server/src/routes/agent-browser.ts',
  // 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval").
  'server/src/services/browser-skills.ts',
  'server/src/routes/browser-skills.ts',
  'server/src/adapters/browser-skill-source.ts',
]

/**
 * A site's thing labels that are everyday words the core uses for its own things (a record's tags, a meeting's next
 * actions): not a site's word when they stand alone. A site's own phrase holding one (「流入経路のアクション」) is still found.
 */
const EVERYDAY_WORDS = new Set(['タグ', 'アクション'])

function siteNames(): string[] {
  const names = new Set<string>(SAMPLE.words)
  const approved = JSON.parse(readFileSync(join(ROOT, 'shared/browser-connectors/approved.json'), 'utf8')) as { combinations: { connector: string; declaration: string }[] }
  for (const c of approved.combinations) {
    names.add(c.connector)
    const parsed = parsePluginManifest(c.declaration)
    if (!parsed.ok || !parsed.value.browser) continue
    names.add(parsed.value.label)
    const b = parsed.value.browser
    names.add(b.host)
    for (const [op, o] of Object.entries(b.operations)) { names.add(op); names.add(o.label) }
  }
  const opened = JSON.parse(readFileSync(join(ROOT, 'shared/browser-connectors/opened.json'), 'utf8')) as BrowserOpenedFile
  const maps: BrowserMap[] = opened.maps.map(m => m.map)
  for (const map of maps) {
    names.add(map.site)
    for (const [thing, t] of Object.entries(map.things)) {
      if (thing.includes('_')) names.add(thing)
      names.add(t.label)
    }
  }
  for (const row of opened.lines) {
    names.add(row.name)
    names.add(row.line.label)
    for (const label of Object.values(row.line.readLabels)) names.add(label)
  }
  return [...names].filter(n => !EVERYDAY_WORDS.has(n))
}

function filesUnder(rel: string): string[] {
  const abs = join(ROOT, rel)
  if ([...Object.keys(EXCLUDED), ...Object.keys(OLD_PATH)].some(x => rel === x || rel.startsWith(`${x}/`))) return []
  if (statSync(abs).isFile()) return /\.(ts|tsx)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel) ? [rel] : []
  return readdirSync(abs).flatMap(name => (name === 'node_modules' ? [] : filesUnder(`${rel}/${name}`)))
}

/** The texts of a file: string literals, template text and JSX text (not comments, identifiers or import paths). */
function textsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text)
    if (ts.isJsxText(node)) out.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function found(names: readonly string[], text: string): string[] {
  // An ASCII name as a whole word; a Japanese one anywhere.
  return names.filter(n => (/^[\x20-\x7e]+$/.test(n)
    ? new RegExp(`(?<![A-Za-z0-9_.-])${escape(n)}(?![A-Za-z0-9_-])`)
    : new RegExp(escape(n))).test(text))
}

describe('the core\'s texts name no site (design memo §3 I10)', () => {
  const names = siteNames()

  it('collects the names to look for: the fictional sample\'s and every carried site\'s', () => {
    for (const n of [...SAMPLE.words, 'lstep', 'Lステップ', '流入経路', 'landing_inspect', 'reminder_step_add_template']) assert.ok(names.includes(n), n)
  })

  it('the excluded files exist and are exactly the site data kept until step ⑦', () => {
    for (const path of Object.keys(EXCLUDED)) assert.ok(statSync(join(ROOT, path)), path)
    assert.deepEqual(Object.keys(EXCLUDED).sort(), ['client/browser-lines/lstep.ts', 'client/connector-maps/lstep', 'shared/browser-connectors/opened.json'])
    for (const path of Object.keys(OLD_PATH)) assert.ok(statSync(join(ROOT, path)), path)
  })

  const files = SCANNED.flatMap(filesUnder)
  it('scans the shipped texts (client/shared, the renderer, shared/core and types, the browser tools and wiring, the admin console, the server\'s browser words)', () => {
    assert.ok(files.length > 100, String(files.length))
    assert.ok(files.includes('client/shared/browser-inspection.ts'))
    assert.ok(files.includes('client/electron/browser-request/inspect-tool.ts'))
    assert.ok(files.includes('admin/src/lib/agent-browser-people.ts'))
    assert.ok(files.includes('shared/core/browser-skill.ts'))
    assert.ok(files.includes('admin/src/lib/agent-browser-skills.ts'))
    assert.ok(files.includes('server/src/services/browser-skills.ts'))
  })

  for (const file of files) {
    it(`${relative(ROOT, join(ROOT, file))} holds none of them in its texts`, () => {
      const hits = textsOf(file).flatMap(t => found(names, t).map(n => `${n} in ${JSON.stringify(t.slice(0, 80))}`))
      assert.deepEqual(hits, [])
    })
  }

  it('the tools\' descriptions and schemas name no site; a site\'s words reach them only through the catalog, from its data', () => {
    const shared = [
      browserInspectDescription(BROWSER_CATALOG_NONE), browserWriteDescription(BROWSER_CATALOG_NONE), browserRequestDescription(BROWSER_CATALOG_NONE),
      browserBrowseDescription([]), BROWSER_OPERATOR_BROWSE_PROMPT,
      JSON.stringify([browserInspectSchema, browserWriteSchema, browserRequestSchema, browserBrowseSchema].map(s => Object.values(s.shape).map(f => f.description))),
    ].join('\n')
    assert.deepEqual(found(names, shared), [])
    const lineCatalog = browserLineCatalog([SAMPLE.line], id => (id === SAMPLE.site.id ? SAMPLE.site : null), 'read')
    const tool = createBrowserInspectTools(async () => ({ kind: 'refused', words: '' }) as never, () => {}, lineCatalog)
    for (const w of ['kumo_shop', 'くもショップ', 'coupon_inspect', 'クーポンを点検する', '点検するクーポンの番号']) assert.ok(tool.description.includes(w), w)
    // A site the build does not know is not offered; a line of the other kind neither.
    assert.equal(browserLineCatalog([SAMPLE.line], () => null, 'read'), BROWSER_CATALOG_NONE)
    assert.equal(browserLineCatalog([SAMPLE.line], () => SAMPLE.site, 'write'), BROWSER_CATALOG_NONE)
    const opCatalog = browserOperationCatalog([{ ...SAMPLE.site, operations: [SAMPLE.operation] }])
    const request = createBrowserRequestTools(async () => ({ outcome: 'refused' }) as never, () => {}, opCatalog)
    for (const w of ['coupon_extend', 'クーポンの期限を延ばす', 'coupon_id', 'until_date']) assert.ok(request.description.includes(w), w)
  })
})
