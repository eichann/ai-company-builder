// The design tokens reached the admin console without changing what it shows
// (.claude/rules/design-system.md): every shadcn/ui variable and --radius still resolves to the value
// it had before the tokens (light and dark), until a component PR drops its `keep` on purpose — and
// then this table changes with it. The token CSS never shadows a variable of Tailwind 4's own theme.
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import tailwind from '@tailwindcss/postcss'

// postcss is not a direct dependency of the admin: take the one Tailwind's PostCSS plugin uses.
const require = createRequire(__filename)
type CssRule = { type: string, selector?: string, walkDecls(fn: (d: { prop: string, value: string }) => void): void }
type PostCss = ((plugins: unknown[]) => { process(css: string, opts: { from: string }): Promise<{ css: string }> })
  & { parse(css: string): { nodes: CssRule[] } }
const postcss = require(require.resolve('postcss', { paths: [path.dirname(require.resolve('@tailwindcss/postcss'))] })) as PostCss

const tokensDir = path.resolve(__dirname, '../../shared/design-tokens')
const read = (f: string) => fs.readFileSync(path.join(tokensDir, f), 'utf8')

/** What the admin showed before the design tokens (admin/src/app/globals.css on 2026-11-21). */
const TODAY: Record<string, [light: string, dark: string]> = {
  radius: ['0.5rem', '0.5rem'],
  background: ['oklch(0.99 0 0)', 'oklch(0.16 0.004 286)'],
  foreground: ['oklch(0.21 0.006 285.9)', 'oklch(0.96 0 0)'],
  card: ['oklch(1 0 0)', 'oklch(0.19 0.005 286)'],
  'card-foreground': ['oklch(0.21 0.006 285.9)', 'oklch(0.96 0 0)'],
  popover: ['oklch(1 0 0)', 'oklch(0.21 0.006 286)'],
  'popover-foreground': ['oklch(0.21 0.006 285.9)', 'oklch(0.96 0 0)'],
  primary: ['oklch(0.21 0.006 285.9)', 'oklch(0.94 0 0)'],
  'primary-foreground': ['oklch(0.985 0 0)', 'oklch(0.21 0.006 285.9)'],
  secondary: ['oklch(0.967 0.001 286.4)', 'oklch(0.26 0.006 286)'],
  'secondary-foreground': ['oklch(0.21 0.006 285.9)', 'oklch(0.96 0 0)'],
  muted: ['oklch(0.967 0.001 286.4)', 'oklch(0.24 0.006 286)'],
  'muted-foreground': ['oklch(0.5 0.014 285.9)', 'oklch(0.72 0.012 286)'],
  accent: ['oklch(0.955 0.003 286.3)', 'oklch(0.26 0.006 286)'],
  'accent-foreground': ['oklch(0.21 0.006 285.9)', 'oklch(0.96 0 0)'],
  destructive: ['oklch(0.577 0.245 27.3)', 'oklch(0.66 0.2 22)'],
  'destructive-foreground': ['oklch(0.985 0 0)', 'oklch(0.985 0 0)'],
  warning: ['oklch(0.6 0.13 70)', 'oklch(0.8 0.14 80)'],
  success: ['oklch(0.55 0.13 155)', 'oklch(0.75 0.15 155)'],
  brand: ['oklch(0.51 0.2 277)', 'oklch(0.7 0.15 277)'],
  border: ['oklch(0.92 0.004 286.3)', 'oklch(1 0 0 / 10%)'],
  input: ['oklch(0.89 0.004 286.3)', 'oklch(1 0 0 / 15%)'],
  ring: ['oklch(0.51 0.2 277)', 'oklch(0.7 0.15 277)'],
  sidebar: ['oklch(0.975 0.001 286.4)', 'oklch(0.14 0.004 286)'],
  'sidebar-foreground': ['oklch(0.21 0.006 285.9)', 'oklch(0.96 0 0)'],
  'sidebar-accent': ['oklch(0.93 0.003 286.3)', 'oklch(0.23 0.006 286)'],
  'sidebar-border': ['oklch(0.92 0.004 286.3)', 'oklch(1 0 0 / 8%)'],
}
/** Spellings of one value (exact equivalents only: white, and 0.5rem at the 16px root size). */
const SAME: Record<string, string> = { 'oklch(1 0 0)': '#ffffff', '0.5rem': '8px' }
const normal = (v: string) => SAME[v] ?? v

/** Custom properties declared in plain top-level blocks of `css` for one selector. */
function declared(css: string, selector: string) {
  const out: Record<string, string> = {}
  for (const rule of postcss.parse(css).nodes) {
    if (rule.type !== 'rule' || rule.selector !== selector) continue
    rule.walkDecls(d => { if (d.prop.startsWith('--')) out[d.prop.slice(2)] = d.value })
  }
  return out
}
function resolve(vars: Record<string, string>, name: string, depth = 0): string {
  const v = vars[name]
  if (v === undefined || depth > 20) return `(undefined --${name})`
  return v.replace(/var\(--([a-z0-9-]+)\)/g, (_, n: string) => resolve(vars, n, depth + 1))
}

describe('the admin bridge keeps what the admin showed before the tokens', () => {
  const css = read('primitives.css') + read('theme.css') + read('tailwind-bridge.admin.css')
  const light = declared(css, ':root')
  const dark = { ...light, ...declared(css, '.dark') }
  test.each(Object.entries(TODAY))('--%s in light and dark', (name, [l, d]) => {
    expect([normal(resolve(light, name)), normal(resolve(dark, name))]).toEqual([normal(l), normal(d)])
  })
})

describe('Tailwind 4 in the admin', () => {
  const tw4Theme = fs.readFileSync(path.join(path.dirname(require.resolve('tailwindcss/package.json')), 'theme.css'), 'utf8')
  const names = (text: string) => new Set([...text.matchAll(/^\s*--([a-z0-9-]+)\s*:/gm)].map(m => m[1]))

  test('no token variable shares a name with a variable Tailwind 4 emits (its default theme, or a registration the bridge does not mark `reference`)', () => {
    const tokenVars = names(read('primitives.css') + read('theme.css'))
    const emittedByBridge = new Set<string>()
    for (const m of read('tailwind-bridge.admin.css').matchAll(/@theme([^{]*)\{([^}]*)\}/g)) {
      if (!m[1].includes('reference')) for (const n of names(m[2])) emittedByBridge.add(n)
    }
    const clash = [...tokenVars].filter(n => names(tw4Theme).has(n) || emittedByBridge.has(n))
    expect(clash).toEqual([])
  })

  test('the shadcn classes still read the shadcn variables, and the semantic names exist on every axis', async () => {
    const page = 'bg-primary rounded-md rounded-lg border-border px-control-x py-toast-y h-control size-icon text-body z-dialog bg-danger-bg'
    const input = fs.readFileSync(path.resolve(__dirname, '../src/app/globals.css'), 'utf8')
      .replace('@import "tailwindcss";', `@import "tailwindcss" source(none);\n@source inline("${page}");`)
    const { css } = await postcss([tailwind({ base: path.resolve(__dirname, '..') })])
      .process(input, { from: path.resolve(__dirname, '../src/app/globals.css') })
    const rule = (cls: string) => {
      const i = css.indexOf(`.${cls} {`)
      return i < 0 ? '' : css.slice(i, css.indexOf('}', i)).replace(/\s+/g, ' ')
    }
    expect(rule('bg-primary')).toContain('background-color: var(--primary)')
    expect(rule('rounded-md')).toContain('border-radius: calc(var(--radius) - 2px)')
    expect(rule('border-border')).toContain('border-color: var(--border)')
    expect(rule('px-control-x')).toContain('padding-inline: var(--padding-control-x)')
    expect(rule('py-toast-y')).toContain('padding-block: var(--padding-toast-y)')
    expect(rule('h-control')).toContain('height: var(--size-control)')
    expect(rule('text-body')).toContain('font-size: var(--font-size-body)')
    expect(rule('z-dialog')).toContain('z-index: var(--z-dialog)')
    expect(rule('bg-danger-bg')).toContain('background-color: var(--color-danger-bg)')
  })
})
