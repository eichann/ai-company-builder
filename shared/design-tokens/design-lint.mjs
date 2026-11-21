#!/usr/bin/env node
// Design lint, as a ratchet (.claude/rules/design-system.md "Design lint").
//
//   node shared/design-tokens/design-lint.mjs                  # compare the tree with the baseline
//   node shared/design-tokens/design-lint.mjs --base <ref>     # CI: also, the baseline itself has
//                                                              # not grown against <ref>'s
//   node shared/design-tokens/design-lint.mjs --update         # write the baseline (never higher;
//                                                              # renames and splits move counts)
//   node shared/design-tokens/design-lint.mjs --list <file>…   # print one file's findings
//
// Scans client/src and admin/src (.ts / .tsx, tests excluded) for values that bypass the design
// tokens: Tailwind palette colours, colour literals, arbitrary values, scale steps that are not
// the approved ones, opacity-modified colours, and colour literals in inline styles. Each class is
// split into "variant:…:body" and only the body is judged, so variants such as data-[state=open]:,
// aria-[selected=true]:, group-data-[…]: and [&>svg]: are never findings.
//
// Today's findings are recorded per file and rule in design-lint-baseline.txt. The check fails
// when a rule gains findings (more in some files than went away in others: a rename or a split
// only moves counts), and also when the tree differs from the baseline without it being updated,
// so the list only shrinks (like KNOWN_FOLDER_CYCLES in client/tests/architecture-boundaries.test.ts).
// A legitimate exception is a `design-lint-allow <rule> -- <reason>` comment on or above the line.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DIR, '..', '..')
export const BASELINE_FILE = path.join(DIR, 'design-lint-baseline.txt')
export const SCANNED = ['client/src', 'admin/src']

const COLOR_UTIL = '(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|inset-ring|outline|fill|stroke|divide|placeholder|caret|accent|from|via|to|decoration|shadow|inset-shadow|drop-shadow|text-shadow)'
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/i
const RADIUS_SIDES = new Set(['t', 'r', 'b', 'l', 'x', 'y', 's', 'e', 'ss', 'se', 'es', 'ee', 'tl', 'tr', 'bl', 'br'])
const RADIUS_STEPS = new Set(['small', 'control', 'card', 'full', 'none'])
const SHADOW_STEPS = new Set(['card', 'pop', 'dialog', 'none'])

/** Semantic token names (theme.css), the only names an arbitrary value may reference: w-[var(--size-menu)], w-(--size-menu). */
export function tokenNames() {
  const css = fs.readFileSync(path.join(DIR, 'theme.css'), 'utf8')
  return new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]))
}

let palette
/** Tailwind's colour palettes, from Tailwind 4's default theme (admin) and Tailwind 3's colours (app), not a hand list. */
export function tailwindPalette() {
  if (palette) return palette
  const tw4 = path.dirname(createRequire(path.join(ROOT, 'admin', 'package.json')).resolve('tailwindcss/package.json'))
  const names = new Set([...fs.readFileSync(path.join(tw4, 'theme.css'), 'utf8').matchAll(/--color-([a-z]+)-\d{2,3}\s*:/g)].map(m => m[1]))
  const tw3 = createRequire(path.join(ROOT, 'client', 'package.json'))('tailwindcss/colors')
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(tw3))) {
    // Deprecated names (lightBlue, …) are getters that print a warning: skip them.
    if (d.value && typeof d.value === 'object' && '500' in d.value) names.add(k)
  }
  if (!names.has('zinc') || !names.has('taupe')) throw new Error('design lint: could not read the Tailwind palettes')
  palette = [...names].sort().join('|')
  return palette
}

/** The `[…]` or `(…)` value of a class body (bg-[#fff], w-(--size-menu)), else undefined. */
function arbitraryValue(b) {
  return /^-?[a-z][a-z0-9-]*-(?:\[(.+)\]|\((.+)\))(?:\/\S+)?$/.exec(b)?.slice(1).find(x => x !== undefined)
}
/** A reference to a semantic token (or a Radix run-time measure): var(--x) or --x (Tailwind 3 `[--x]`, Tailwind 4 `(--x)`), optionally typed (`color:--x`). */
function tokenReference(value, tokens) {
  const m = /^(?:[a-z-]+:)?(?:var\(--([a-z0-9-]+)\)|--([a-z0-9-]+))$/.exec(value)
  const name = m && (m[1] ?? m[2])
  // --radix-*: positions and sizes Radix measures at run time (shadcn's menus, selects, popovers).
  return !!name && (tokens.has(name) || name.startsWith('radix-'))
}

// Order matters: the first rule that matches a class body names the finding.
export const RULES = [
  { id: 'color-literal', why: 'colour literal in a class: use a semantic colour (bg-danger-bg, text-text-muted)',
    test: b => COLOR_LITERAL.test(arbitraryValue(b) ?? /^\[(.+)\]$/.exec(b)?.[1] ?? '') },
  { id: 'palette-color', why: 'Tailwind palette colour: use a semantic colour (text-text-muted, bg-warning-bg)',
    test: b => new RegExp(`^${COLOR_UTIL}-(?:${tailwindPalette()})-\\d{2,3}(?:/\\S+)?$`).test(b) },
  { id: 'white-black', why: 'white / black: use on-primary, surface, scrim, …',
    test: b => new RegExp(`^${COLOR_UTIL}-(?:white|black)(?:/\\S+)?$`).test(b) },
  { id: 'arbitrary-value', why: 'arbitrary value […] / (…): use a token or an approved step',
    test: (b, tokens) => { const v = arbitraryValue(b); return v !== undefined && !tokenReference(v, tokens) } },
  { id: 'type-scale', why: 'type step outside the scale: text-caption / small / body / title / heading / page',
    test: b => /^text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:\/\S+)?$/.test(b) },
  { id: 'radius-scale', why: 'radius outside the scale: rounded-small / control / card / full',
    test: b => {
      const parts = b.split('-')
      if (parts[0] !== 'rounded') return false
      return !RADIUS_STEPS.has((RADIUS_SIDES.has(parts[1]) ? parts.slice(2) : parts.slice(1)).join('-'))
    } },
  { id: 'shadow-scale', why: 'shadow outside the scale: shadow-card / pop / dialog (no drop / inset / text shadows)',
    test: (b, tokens) => {
      if (/^(?:drop|inset|text)-shadow(?:-.*)?$/.test(b)) return !b.endsWith('-shadow-none')
      const m = /^shadow(?:-([a-z0-9-]+))?$/.exec(b)
      return !!m && !SHADOW_STEPS.has(m[1] ?? '') && !tokens.has(`color-${m[1]}`)
    } },
  { id: 'z-index', why: 'numeric z-index: z-overlay / dialog / menu / toast',
    test: b => /^-?z-\d+$/.test(b) },
  { id: 'opacity-scale', why: 'numeric opacity: opacity-disabled (0 and 100 for show / hide are fine)',
    test: b => /^opacity-\d+$/.test(b) && b !== 'opacity-0' && b !== 'opacity-100' },
  { id: 'color-opacity', why: 'opacity-modified colour (/5, /10, …): use the state set (bg-warning-bg, bg-selected-bg)',
    test: b => new RegExp(`^${COLOR_UTIL}-[a-z][a-z0-9-]*/(?:\\d+|\\[[^\\]]+\\]|\\([^)]+\\))$`).test(b) },
]
export const INLINE_RULE = { id: 'inline-color', why: 'colour literal in an inline style: use var(--color-…) or a --data-* colour' }
export const RULE_IDS = [...RULES.map(r => r.id), INLINE_RULE.id]
const WHY = Object.fromEntries([...RULES, INLINE_RULE].map(r => [r.id, r.why]))

/** The class body without its variants ("dark:hover:bg-x" → "bg-x", "data-[state=open]:x" → "x"); a colon inside […] / (…) is not a separator. */
export function classBody(cls) {
  let depth = 0, start = 0
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i]
    if (c === '[' || c === '(') depth++
    else if ((c === ']' || c === ')') && depth > 0) depth--
    else if (c === ':' && depth === 0) start = i + 1
  }
  return cls.slice(start).replace(/^!/, '').replace(/!$/, '')
}

export function ruleFor(cls, tokens) {
  const body = classBody(cls)
  if (!body) return undefined
  return RULES.find(r => r.test(body, tokens))
}

let ts
function typescript() {
  ts ??= createRequire(path.join(ROOT, 'client', 'package.json'))('typescript')
  return ts
}

/** Findings in one source text: [{ rule, line, text }]. */
export function lintSource(text, fileName, tokens = tokenNames()) {
  const t = typescript()
  const sf = t.createSourceFile(fileName, text, t.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? t.ScriptKind.TSX : t.ScriptKind.TS)
  const out = []
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const isText = n => t.isStringLiteral(n) || t.isNoSubstitutionTemplateLiteral(n)
    || n.kind === t.SyntaxKind.TemplateHead || n.kind === t.SyntaxKind.TemplateMiddle || n.kind === t.SyntaxKind.TemplateTail
  const isModuleName = n => (t.isImportDeclaration(n.parent) || t.isExportDeclaration(n.parent))
    || (t.isCallExpression(n.parent) && n.parent.expression.kind === t.SyntaxKind.ImportKeyword)
  function inlineStyle(expr) {
    const visit = n => {
      if (isText(n) && COLOR_LITERAL.test(n.text)) out.push({ rule: INLINE_RULE.id, line: lineOf(n), text: n.text })
      t.forEachChild(n, visit)
    }
    visit(expr)
  }
  const visit = node => {
    if (t.isJsxAttribute(node) && node.name.getText(sf) === 'style' && node.initializer
      && t.isJsxExpression(node.initializer) && node.initializer.expression) {
      inlineStyle(node.initializer.expression)
    }
    if (isText(node) && !isModuleName(node)) {
      for (const cls of node.text.split(/\s+/)) {
        const rule = cls && ruleFor(cls, tokens)
        if (rule) out.push({ rule: rule.id, line: lineOf(node), text: cls })
      }
    }
    t.forEachChild(node, visit)
  }
  visit(sf)
  // A recorded exception: `design-lint-allow <rule>[, <rule>] -- <reason>` in a comment on the
  // line of the finding or the line above it (a reason is required).
  const allowed = new Map()
  text.split('\n').forEach((line, i) => {
    const m = /design-lint-allow\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)\s+--\s+\S/.exec(line)
    if (!m) return
    const rules = m[1].split(/\s*,\s*/)
    for (const l of [i + 1, i + 2]) allowed.set(l, [...(allowed.get(l) ?? []), ...rules])
  })
  return out.filter(f => !allowed.get(f.line)?.includes(f.rule))
}

export function countByRule(findings) {
  const counts = {}
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1
  return counts
}

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

/** Current counts: { 'client/src/x.tsx': { 'palette-color': 3 } } (files without findings left out). */
export function scanRepository(root = ROOT) {
  const tokens = tokenNames()
  const result = {}
  for (const dir of SCANNED) {
    for (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      const counts = countByRule(lintSource(fs.readFileSync(file, 'utf8'), file, tokens))
      if (Object.keys(counts).length) result[rel] = counts
    }
  }
  return result
}

export function parseBaseline(text) {
  const out = {}
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [file, ...pairs] = line.trim().split(/\s+/)
    out[file] = Object.fromEntries(pairs.map(p => { const [k, v] = p.split('='); return [k, Number(v)] }))
  }
  return out
}

export function formatBaseline(counts) {
  const header = [
    '# Design lint baseline (shared/design-tokens/design-lint.mjs): findings per file and rule on',
    '# 2026-11-21. It only shrinks: fix a file, then run `node shared/design-tokens/design-lint.mjs',
    '# --update` and commit the lower counts. Never raise a count to get a change through.',
  ]
  const lines = Object.keys(counts).sort().map(f =>
    [f, ...Object.keys(counts[f]).sort().map(r => `${r}=${counts[f][r]}`)].join(' '))
  return [...header, ...lines].join('\n') + '\n'
}

/**
 * Differences between the current counts and the baseline, per file and rule.
 * - `shrunk`: fewer than recorded (the baseline must be lowered in the same change).
 * - `moved`: more than recorded in some files while, for that rule, at least as many went away
 *   elsewhere in the same change: a rename (`git mv`) or a split. Allowed; the baseline is updated.
 * - `grown`: more of a rule than went away anywhere: new findings. Never allowed.
 */
export function compareToBaseline(current, baseline) {
  const up = [], shrunk = []
  for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    const now = current[file] ?? {}, before = baseline[file] ?? {}
    for (const rule of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const a = before[rule] ?? 0, b = now[rule] ?? 0
      if (b > a) up.push({ file, rule, before: a, now: b })
      else if (b < a) shrunk.push({ file, rule, before: a, now: b })
    }
  }
  const sum = (list, rule) => list.filter(x => x.rule === rule).reduce((n, x) => n + Math.abs(x.now - x.before), 0)
  const coveredRules = new Set(up.map(x => x.rule).filter(rule => sum(up, rule) <= sum(shrunk, rule)))
  return {
    grown: up.filter(x => !coveredRules.has(x.rule)),
    moved: up.filter(x => coveredRules.has(x.rule)),
    shrunk,
  }
}

export function totalsByRule(counts, prefix = '') {
  const totals = {}
  for (const [file, c] of Object.entries(counts)) {
    if (!file.startsWith(prefix)) continue
    for (const [rule, n] of Object.entries(c)) totals[rule] = (totals[rule] ?? 0) + n
  }
  return totals
}

const BASELINE_PATH = 'shared/design-tokens/design-lint-baseline.txt'

function main(argv) {
  if (argv[0] === '--list') {
    const tokens = tokenNames()
    for (const f of argv.slice(1)) {
      for (const x of lintSource(fs.readFileSync(f, 'utf8'), f, tokens)) console.log(`${f}:${x.line}: ${x.rule}: ${x.text}  (${WHY[x.rule]})`)
    }
    return 0
  }
  const hasBaseline = fs.existsSync(BASELINE_FILE)
  const baseline = hasBaseline ? parseBaseline(fs.readFileSync(BASELINE_FILE, 'utf8')) : {}
  let failed = false
  // CI: the committed baseline itself may not grow against the base branch's (only moves).
  const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined
  if (base) {
    let baseText
    try {
      baseText = execFileSync('git', ['show', `${base}:${BASELINE_PATH}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { /* the base has no baseline yet */ }
    // A change to the lint (its rules, or the token names it accepts) may find more: then a raised
    // baseline is that change's, visible in its review, and allowed.
    let lintChanged = false
    try {
      execFileSync('git', ['diff', '--quiet', base, '--', 'shared/design-tokens/design-lint.mjs', 'shared/design-tokens/theme.css'], { cwd: ROOT, stdio: 'ignore' })
    } catch { lintChanged = true }
    if (baseText !== undefined && lintChanged) console.log('design lint: the lint changed since the base; the baseline may follow it')
    if (baseText !== undefined && !lintChanged) {
      for (const g of compareToBaseline(baseline, parseBaseline(baseText)).grown) {
        failed = true
        console.error(`::error file=${BASELINE_PATH}::design lint: the baseline was raised for ${g.file} ${g.rule} (${g.before} → ${g.now}). It only shrinks; a legitimate exception is a design-lint-allow comment (design-system.md).`)
      }
    }
  }
  const current = scanRepository()
  const { grown, moved, shrunk } = compareToBaseline(current, baseline)
  if (argv.includes('--update')) {
    if (hasBaseline && grown.length) {
      for (const g of grown) console.error(`grew: ${g.file} ${g.rule} ${g.before} → ${g.now}`)
      console.error('The baseline only shrinks: fix these (`--list <file>` shows where), or record a legitimate exception with a design-lint-allow comment (design-system.md).')
      return 1
    }
    fs.writeFileSync(BASELINE_FILE, formatBaseline(current))
    console.log(`design lint: baseline written (${Object.keys(current).length} files${moved.length ? `; ${moved.length} counts moved between files` : ''})`)
    return 0
  }
  for (const g of grown) {
    console.error(`::error file=${g.file}::design lint: ${g.rule} ${g.before} → ${g.now} (${WHY[g.rule]}). Run node shared/design-tokens/design-lint.mjs --list ${g.file}`)
  }
  for (const s of [...shrunk, ...moved]) {
    console.error(`::error file=${s.file}::design lint: ${s.rule} ${s.before} → ${s.now}, not what the baseline records (fixed, renamed or split). Update it: node shared/design-tokens/design-lint.mjs --update`)
  }
  const total = Object.values(current).reduce((n, c) => n + Object.values(c).reduce((a, b) => a + b, 0), 0)
  if (!grown.length && !shrunk.length && !moved.length) console.log(`design lint: ${total} findings in ${Object.keys(current).length} files, as in the baseline`)
  return failed || grown.length || shrunk.length || moved.length ? 1 : 0
}

// Run as a script (realpath: a temp folder may be reached through a symlink, e.g. /var → /private/var).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
