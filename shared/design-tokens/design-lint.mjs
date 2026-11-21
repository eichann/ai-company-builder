#!/usr/bin/env node
// Design lint, as a ratchet (.claude/rules/design-system.md "Design lint").
//
//   node shared/design-tokens/design-lint.mjs                  # CI: compare with the baseline
//   node shared/design-tokens/design-lint.mjs --update         # write the baseline (lower only)
//   node shared/design-tokens/design-lint.mjs --list <file>…   # print one file's findings
//
// Scans client/src and admin/src (.ts / .tsx, tests excluded) for values that bypass the design
// tokens: Tailwind palette colours, colour literals, arbitrary values, scale steps that are not
// the approved ones, opacity-modified colours, and colour literals in inline styles. Each class is
// split into "variant:…:body" and only the body is judged, so variants such as data-[state=open]:,
// aria-[selected=true]:, group-data-[…]: and [&>svg]: are never findings.
//
// Today's findings are recorded per file and rule in design-lint-baseline.txt. The check fails
// when a file's count for a rule grows or a file not in the baseline has findings, and also when
// a count drops without the baseline being lowered, so the list only shrinks (like
// KNOWN_FOLDER_CYCLES in client/tests/architecture-boundaries.test.ts).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DIR, '..', '..')
export const BASELINE_FILE = path.join(DIR, 'design-lint-baseline.txt')
export const SCANNED = ['client/src', 'admin/src']

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const COLOR_UTIL = '(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|divide|placeholder|caret|accent|from|via|to|decoration|shadow)'
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/i

/** Semantic token names (theme.css), the only names an arbitrary value may reference: w-[var(--size-menu)]. */
export function tokenNames() {
  const css = fs.readFileSync(path.join(DIR, 'theme.css'), 'utf8')
  return new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]))
}

// Order matters: the first rule that matches a class body names the finding.
export const RULES = [
  { id: 'color-literal', why: 'colour literal in a class: use a semantic colour (bg-danger-bg, text-text-muted)',
    test: b => /\[[^\]]*\]/.test(b) && COLOR_LITERAL.test(b) },
  { id: 'palette-color', why: 'Tailwind palette colour: use a semantic colour (text-text-muted, bg-warning-bg)',
    test: b => new RegExp(`^${COLOR_UTIL}-(?:${PALETTE})-\\d{2,3}(?:/\\S+)?$`).test(b) },
  { id: 'white-black', why: 'white / black: use on-primary, surface, scrim, …',
    test: b => new RegExp(`^${COLOR_UTIL}-(?:white|black)(?:/\\S+)?$`).test(b) },
  { id: 'arbitrary-value', why: 'arbitrary value […]: use a token or an approved step',
    test: (b, tokens) => {
      const m = /^-?[a-z][a-z0-9-]*-\[([^\]]+)\](?:\/\S+)?$/.exec(b)
      if (!m) return false
      const ref = /^var\(--([a-z0-9-]+)\)$/.exec(m[1])
      return !(ref && tokens.has(ref[1]))
    } },
  { id: 'type-scale', why: 'type step outside the scale: text-caption / small / body / title / heading / page',
    test: b => /^text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:\/\S+)?$/.test(b) },
  { id: 'radius-scale', why: 'radius outside the scale: rounded-small / control / card / full',
    test: b => /^rounded(?:-[trblse]{1,2})?(?:-(?:sm|md|lg|xl|2xl|3xl))?$/.test(b) },
  { id: 'shadow-scale', why: 'shadow outside the scale: shadow-card / pop / dialog',
    test: b => /^shadow(?:-(?:xs|sm|md|lg|xl|2xl|inner))?$/.test(b) },
  { id: 'z-index', why: 'numeric z-index: z-overlay / dialog / menu / toast',
    test: b => /^-?z-\d+$/.test(b) },
  { id: 'opacity-scale', why: 'numeric opacity: opacity-disabled (0 and 100 for show / hide are fine)',
    test: b => /^opacity-\d+$/.test(b) && b !== 'opacity-0' && b !== 'opacity-100' },
  { id: 'color-opacity', why: 'opacity-modified colour (/5, /10, …): use the state set (bg-warning-bg, bg-selected-bg)',
    test: b => new RegExp(`^${COLOR_UTIL}-[a-z][a-z0-9-]*/(?:\\d+|\\[[^\\]]+\\])$`).test(b) },
]
export const INLINE_RULE = { id: 'inline-color', why: 'colour literal in an inline style: use var(--color-…) or a --data-* colour' }
export const RULE_IDS = [...RULES.map(r => r.id), INLINE_RULE.id]

/** The class body without its variants ("dark:hover:bg-x" → "bg-x", "data-[state=open]:x" → "x"). */
export function classBody(cls) {
  const parts = cls.split(/:(?![^[]*\])/)
  return parts[parts.length - 1].replace(/^!/, '').replace(/!$/, '')
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
  return out
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

/** Differences between the current counts and the baseline. */
export function compareToBaseline(current, baseline) {
  const grown = [], shrunk = []
  for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    const now = current[file] ?? {}, before = baseline[file] ?? {}
    for (const rule of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const a = before[rule] ?? 0, b = now[rule] ?? 0
      if (b > a) grown.push({ file, rule, before: a, now: b })
      else if (b < a) shrunk.push({ file, rule, before: a, now: b })
    }
  }
  return { grown, shrunk }
}

export function totalsByRule(counts, prefix = '') {
  const totals = {}
  for (const [file, c] of Object.entries(counts)) {
    if (!file.startsWith(prefix)) continue
    for (const [rule, n] of Object.entries(c)) totals[rule] = (totals[rule] ?? 0) + n
  }
  return totals
}

function main(argv) {
  if (argv[0] === '--list') {
    const tokens = tokenNames()
    for (const f of argv.slice(1)) {
      for (const x of lintSource(fs.readFileSync(f, 'utf8'), f, tokens)) {
        console.log(`${f}:${x.line}: ${x.rule}: ${x.text}  (${[...RULES, INLINE_RULE].find(r => r.id === x.rule).why})`)
      }
    }
    return 0
  }
  const current = scanRepository()
  const baseline = fs.existsSync(BASELINE_FILE) ? parseBaseline(fs.readFileSync(BASELINE_FILE, 'utf8')) : {}
  const { grown, shrunk } = compareToBaseline(current, baseline)
  if (argv.includes('--update')) {
    if (grown.length && !argv.includes('--allow-growth')) {
      for (const g of grown) console.error(`grew: ${g.file} ${g.rule} ${g.before} → ${g.now}`)
      console.error('The baseline only shrinks: fix these (`--list <file>` shows where), or pass --allow-growth for an exception the owner accepted.')
      return 1
    }
    fs.writeFileSync(BASELINE_FILE, formatBaseline(current))
    console.log(`design lint: baseline written (${Object.keys(current).length} files)`)
    return 0
  }
  for (const g of grown) {
    console.error(`::error file=${g.file}::design lint: ${g.rule} ${g.before} → ${g.now} (${[...RULES, INLINE_RULE].find(r => r.id === g.rule).why}). Run node shared/design-tokens/design-lint.mjs --list ${g.file}`)
  }
  for (const s of shrunk) {
    console.error(`::error file=${s.file}::design lint: ${s.rule} ${s.before} → ${s.now}, fewer than the baseline. Lower it: node shared/design-tokens/design-lint.mjs --update`)
  }
  const total = Object.values(current).reduce((n, c) => n + Object.values(c).reduce((a, b) => a + b, 0), 0)
  if (!grown.length && !shrunk.length) console.log(`design lint: ${total} findings in ${Object.keys(current).length} files, as in the baseline`)
  return grown.length || shrunk.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
