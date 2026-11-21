// The design lint (shared/design-tokens/design-lint.mjs, .claude/rules/design-system.md) catches
// the ways screens bypass the design tokens, never flags a variant selector, and its baseline can
// only shrink. CI runs the ratchet itself in "Lint (changed files)"; this file guards the rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  lintSource, compareToBaseline, parseBaseline, formatBaseline, RULE_IDS,
} from '../../shared/design-tokens/design-lint.mjs'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/design-tokens/lint-examples')
const lintExample = (name: string) => lintSource(fs.readFileSync(path.join(examples, name), 'utf8'), name)
const lint = (tsx: string) => lintSource(tsx, 'example.tsx')
const pairs = (found: { rule: string, text: string }[]) => found.map(f => `${f.rule} ${f.text}`)

test('a hand-written warning callout (admin today) is caught class by class', () => {
  assert.deepEqual(pairs(lintExample('bad-1-callout.tsx')), [
    'radius-scale rounded-xl',
    'color-opacity border-warning/30',
    'color-opacity bg-warning/10',
    'type-scale text-sm',
    'palette-color text-amber-900',
  ])
})

test('an ad-hoc dialog (app today) is caught: scrim, surface, shadow, type, danger colour, disabled', () => {
  assert.deepEqual(pairs(lintExample('bad-2-dialog.tsx')), [
    'arbitrary-value z-[60]',
    'white-black bg-black/50',
    'radius-scale rounded-2xl',
    'white-black bg-white',
    'shadow-scale shadow-xl',
    'palette-color dark:bg-zinc-800',
    'arbitrary-value text-[15px]',
    'arbitrary-value text-[12.5px]',
    'palette-color text-gray-500',
    'palette-color dark:text-zinc-400',
    'palette-color bg-red-500',
    'white-black text-white',
    'opacity-scale disabled:opacity-40',
  ])
})

test('variants and semantic names are never findings (data-[state=open]:, aria-[…]:, group-data-[…]:, [&>svg]:)', () => {
  assert.deepEqual(lintExample('good.tsx'), [])
  assert.deepEqual(lint('<div className="data-[state=open]:bg-surface-sunken aria-[selected=true]:bg-selected-bg group-data-[disabled=true]:opacity-disabled [&>svg]:size-icon dark:hover:bg-danger-bg" />'), [])
})

test('an arbitrary value may only reference a semantic token', () => {
  assert.deepEqual(lint('<div className="w-[var(--size-menu)] z-[var(--z-dialog)]" />'), [])
  assert.deepEqual(pairs(lint('<div className="w-[var(--not-a-token)] w-[220px]" />')),
    ['arbitrary-value w-[var(--not-a-token)]', 'arbitrary-value w-[220px]'])
})

test('colour literals are caught in classes and in inline styles, user-chosen colours from data are not', () => {
  assert.deepEqual(pairs(lint('<div className="bg-[#fff] [color:rgb(0,0,0)]" style={{ color: \'#6366f1\', borderColor: `oklch(0.5 0.1 200)` }} />')), [
    'color-literal bg-[#fff]',
    'color-literal [color:rgb(0,0,0)]',
    'inline-color #6366f1',
    'inline-color oklch(0.5 0.1 200)',
  ])
  assert.deepEqual(lint('<div style={{ backgroundColor: department.color, color: \'var(--color-text)\' }} />'), [])
})

test('class constants and cn() arguments are read too, comments and module names are not', () => {
  assert.deepEqual(pairs(lint(`
    import x from 'text-sm'
    // text-gray-500 in a comment
    const FIELD = 'rounded-md text-xs'
    cn('bg-amber-50', cond && \`z-50 \${y}\`)
  `)), ['radius-scale rounded-md', 'type-scale text-xs', 'palette-color bg-amber-50', 'z-index z-50'])
})

test('Tailwind 4 spellings are caught: (--x) shorthand, newer palettes, xs / 4xl / 2xs steps, drop / inset / text shadows', () => {
  assert.deepEqual(pairs(lintExample('bad-3-tailwind4.tsx')), [
    'arbitrary-value bg-(--brand-tint)',
    'arbitrary-value w-(--sidebar-w)',
    'palette-color bg-olive-500',
    'palette-color text-taupe-700',
    'radius-scale rounded-4xl',
    'radius-scale rounded-t-xs',
    'shadow-scale shadow-2xs',
    'shadow-scale drop-shadow-md',
    'shadow-scale inset-shadow-sm',
    'shadow-scale text-shadow-lg',
  ])
})

test('a legitimate exception is recorded on the line with a reason, and covers only the named rule', () => {
  const src = (comment: string) => lint(`${comment}\n<div className="w-[640px] text-[13px]" />`)
  assert.deepEqual(pairs(src('{/* design-lint-allow arbitrary-value -- the editor column matches the PDF width */}')), [])
  assert.deepEqual(pairs(src('// design-lint-allow arbitrary-value')), ['arbitrary-value w-[640px]', 'arbitrary-value text-[13px]'], 'no reason: not an exception')
  assert.deepEqual(pairs(src('// design-lint-allow z-index -- wrong rule')), ['arbitrary-value w-[640px]', 'arbitrary-value text-[13px]'])
})

const baseline = parseBaseline(formatBaseline({ 'client/src/a.tsx': { 'palette-color': 3, 'type-scale': 1 } }))

test('the baseline only shrinks: growth and a new file with findings fail, an unrecorded drop must be written down', () => {
  assert.deepEqual(compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 3, 'type-scale': 1 } }, baseline), { grown: [], moved: [], shrunk: [] })
  assert.deepEqual(compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 4, 'type-scale': 1 } }, baseline).grown,
    [{ file: 'client/src/a.tsx', rule: 'palette-color', before: 3, now: 4 }])
  assert.deepEqual(compareToBaseline({ ...baseline, 'admin/src/b.tsx': { 'z-index': 1 } }, baseline).grown,
    [{ file: 'admin/src/b.tsx', rule: 'z-index', before: 0, now: 1 }])
  // A fixed file must lower the baseline in the same change, or the list would stop shrinking.
  assert.deepEqual(compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 3 } }, baseline).shrunk,
    [{ file: 'client/src/a.tsx', rule: 'type-scale', before: 1, now: 0 }])
})

test('a rename or a split moves counts between files without counting as growth', () => {
  const renamed = compareToBaseline({ 'client/src/b.tsx': { 'palette-color': 3, 'type-scale': 1 } }, baseline)
  assert.deepEqual(renamed.grown, [])
  assert.equal(renamed.moved.length, 2)
  const split = compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 1 }, 'client/src/a-part.tsx': { 'palette-color': 2, 'type-scale': 1 } }, baseline)
  assert.deepEqual(split.grown, [])
  // Moving more than went away is growth.
  assert.deepEqual(compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 1, 'type-scale': 1 }, 'client/src/c.tsx': { 'palette-color': 3 } }, baseline).grown,
    [{ file: 'client/src/c.tsx', rule: 'palette-color', before: 0, now: 3 }])
})

test('--update writes a rename, refuses growth; --base fails when the committed baseline was raised', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-'))
  const tokens = path.join(root, 'shared/design-tokens')
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
  for (const f of ['design-lint.mjs', 'theme.css']) write(`shared/design-tokens/${f}`, fs.readFileSync(path.join(examples, '..', f), 'utf8'))
  for (const pkg of ['client', 'admin']) fs.symlinkSync(path.resolve(examples, '../../..', pkg, 'node_modules'), path.join(root, `${pkg}-nm`))
  write('client/package.json', '{}'); write('admin/package.json', '{}')
  fs.symlinkSync(path.join(root, 'client-nm'), path.join(root, 'client/node_modules'))
  fs.symlinkSync(path.join(root, 'admin-nm'), path.join(root, 'admin/node_modules'))
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(tokens, 'design-lint.mjs'), ...args], { cwd: root, encoding: 'utf8' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  try {
    write('client/src/a.tsx', 'export const A = "bg-zinc-100 text-sm"\n')
    assert.equal(run('--update').status, 0)
    git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    fs.renameSync(path.join(root, 'client/src/a.tsx'), path.join(root, 'client/src/b.tsx'))
    assert.equal(run().status, 1, 'the baseline must follow the rename')
    assert.equal(run('--update').status, 0, 'a rename is not growth')
    assert.equal(run('--base', 'HEAD').status, 0)
    write('client/src/b.tsx', 'export const A = "bg-zinc-100 bg-zinc-200 text-sm"\n')
    assert.equal(run('--update').status, 1, 'growth is refused')
    // Raising the committed baseline by hand is caught against the base branch.
    write('shared/design-tokens/design-lint-baseline.txt', formatBaseline({ 'client/src/b.tsx': { 'palette-color': 2, 'type-scale': 1 } }))
    const raised = run('--base', 'HEAD')
    assert.equal(raised.status, 1)
    assert.match(raised.stderr, /baseline was raised/)
    // …unless the lint itself changed in the same change (a new rule finds more).
    fs.appendFileSync(path.join(tokens, 'design-lint.mjs'), '\n// a rule changed\n')
    assert.equal(run('--base', 'HEAD').status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the committed baseline names only known rules', () => {
  const text = fs.readFileSync(path.join(examples, '../design-lint-baseline.txt'), 'utf8')
  const rules = new Set(Object.values(parseBaseline(text)).flatMap(c => Object.keys(c)))
  assert.deepEqual([...rules].filter(r => !RULE_IDS.includes(r)), [])
})
