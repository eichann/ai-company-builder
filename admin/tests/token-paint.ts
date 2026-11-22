// What Tailwind 4 really paints for a class list, resolved through the token files in light and
// dark (design-system.md): the colour tests read the CSS the build generates for a rendered
// element's classes, not class names alone, so a class that stops reading its token (a hard-coded
// colour, a bridge that keeps an old value) fails. Used by primary-action and status-colours.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import tailwind from '@tailwindcss/postcss'

const require = createRequire(__filename)
type Node = { type: string, selector?: string, prop?: string, value?: string, nodes?: Node[] }
type PostCss = ((plugins: unknown[]) => { process(css: string, opts: { from: string }): Promise<{ css: string }> })
  & { parse(css: string): Node }
const postcss = require(require.resolve('postcss', { paths: [path.dirname(require.resolve('@tailwindcss/postcss'))] })) as PostCss

const tokensDir = path.resolve(__dirname, '../../shared/design-tokens')
const globals = path.resolve(__dirname, '../src/app/globals.css')
const tokenCss = ['primitives.css', 'theme.css', 'tailwind-bridge.admin.css'].map(f => fs.readFileSync(path.join(tokensDir, f), 'utf8')).join('\n')

/** Custom properties of the top-level `selector` blocks (light: `:root`, dark adds `.dark`). */
function vars(selector: string) {
  const out: Record<string, string> = {}
  for (const n of postcss.parse(tokenCss).nodes ?? []) {
    if (n.type === 'rule' && n.selector === selector) for (const d of n.nodes ?? []) if (d.type === 'decl' && d.prop!.startsWith('--')) out[d.prop!.slice(2)] = d.value!
  }
  return out
}
export const LIGHT = vars(':root')
export const DARK = { ...LIGHT, ...vars('.dark') }
export function resolve(v: Record<string, string>, value: string, depth = 0): string {
  return depth > 20 ? value : value.replace(/var\(--([a-z0-9-]+)\)/g, (_, n: string) => resolve(v, v[n] ?? `(undefined --${n})`, depth + 1))
}
/** A token's value in both themes: `token('paused-bg')` → `{ light, dark }` of `--color-paused-bg`. */
export const token = (name: string) => ({ light: resolve(LIGHT, `var(--color-${name})`), dark: resolve(DARK, `var(--color-${name})`) })

/** fill / hover / active: background-color; text: color; border: border-color; icon: the color of a child `svg` (`[&>svg]:…`). */
export type Paint = { fill?: string, hover?: string, active?: string, text?: string, border?: string, icon?: string }

/** The colours Tailwind 4 generates for `className`, light and dark. */
export async function paint(className: string): Promise<{ light: Paint, dark: Paint }> {
  const input = fs.readFileSync(globals, 'utf8')
    .replace('@import "tailwindcss";', `@import "tailwindcss" source(none);\n@source inline("${className.replace(/"/g, '\\"')}");`)
  const { css } = await postcss([tailwind({ base: path.resolve(__dirname, '..') })]).process(input, { from: globals })
  const raw: Paint = {}
  const classes = className.split(/\s+/).filter(Boolean)
  const walk = (n: Node, sel = '') => {
    // A nesting `&` is bare; an escaped `\&` belongs to a class name (`[&>svg]:…`).
    const s = n.type === 'rule' ? (/(?<!\\)&/.test(n.selector!) ? n.selector!.replace(/(?<!\\)&/g, sel) : n.selector!).replace(/\\/g, '') : sel
    for (const c of n.nodes ?? []) {
      if (c.type === 'decl' && n.type === 'rule') {
        for (const cls of classes) {
          const state = s === `.${cls}` ? 'fill' : s === `.${cls}:hover` ? 'hover' : s === `.${cls}:active` ? 'active' : null
          if (state && c.prop === 'background-color') raw[state] = c.value
          if (state === 'fill' && c.prop === 'color') raw.text = c.value
          if (state === 'fill' && c.prop === 'border-color') raw.border = c.value
          if (s.replace(/\s/g, '') === `.${cls}>svg` && c.prop === 'color') raw.icon = c.value
        }
      }
      walk(c, s)
    }
  }
  walk(postcss.parse(css))
  const res = (v: Record<string, string>) => Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, resolve(v, x!)])) as Paint
  return { light: res(LIGHT), dark: res(DARK) }
}
