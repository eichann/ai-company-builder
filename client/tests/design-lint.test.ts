// The design lint (shared/design-tokens/design-lint.mjs, .claude/rules/design-system.md) catches
// the ways screens bypass the design tokens, never flags a variant selector, and its baseline can
// only shrink. CI runs the ratchet itself in "Lint (changed files)"; this file guards the rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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

test('the baseline only shrinks: growth, a new file and an unrecorded drop all fail', () => {
  const baseline = parseBaseline(formatBaseline({ 'client/src/a.tsx': { 'palette-color': 3, 'type-scale': 1 } }))
  assert.deepEqual(compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 3, 'type-scale': 1 } }, baseline), { grown: [], shrunk: [] })
  assert.deepEqual(compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 4, 'type-scale': 1 } }, baseline).grown,
    [{ file: 'client/src/a.tsx', rule: 'palette-color', before: 3, now: 4 }])
  assert.deepEqual(compareToBaseline({ ...baseline, 'admin/src/b.tsx': { 'z-index': 1 } }, baseline).grown,
    [{ file: 'admin/src/b.tsx', rule: 'z-index', before: 0, now: 1 }])
  // A fixed file must lower the baseline in the same change, or the list would stop shrinking.
  assert.deepEqual(compareToBaseline({ 'client/src/a.tsx': { 'palette-color': 3 } }, baseline).shrunk,
    [{ file: 'client/src/a.tsx', rule: 'type-scale', before: 1, now: 0 }])
})

test('the committed baseline names only known rules', () => {
  const text = fs.readFileSync(path.join(examples, '../design-lint-baseline.txt'), 'utf8')
  const rules = new Set(Object.values(parseBaseline(text)).flatMap(c => Object.keys(c)))
  assert.deepEqual([...rules].filter(r => !RULE_IDS.includes(r)), [])
})
