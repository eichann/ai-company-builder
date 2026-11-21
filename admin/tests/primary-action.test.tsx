// The admin's primary action is the primary blue (design-system.md "Primary actions (P2a, done)",
// owner decision 2: the black primary buttons became the primary colour). Measured from the CSS
// Tailwind 4 really generates for the classes on the rendered button, resolved through the token
// files in light and dark — not from class names alone, so a class that stops reading the token
// (a hard-coded black, a bridge that keeps today's value) fails.
import { useState } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import tailwind from '@tailwindcss/postcss'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/app/confirm-dialog'

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
const LIGHT = vars(':root')
const DARK = { ...LIGHT, ...vars('.dark') }
function resolve(v: Record<string, string>, value: string, depth = 0): string {
  return depth > 20 ? value : value.replace(/var\(--([a-z0-9-]+)\)/g, (_, n: string) => resolve(v, v[n] ?? `(undefined --${n})`, depth + 1))
}

type Paint = { fill?: string, hover?: string, active?: string, text?: string }
/** The background (plain, :hover, :active) and text colour Tailwind 4 generates for `className`. */
async function paint(className: string): Promise<{ light: Paint, dark: Paint }> {
  const input = fs.readFileSync(globals, 'utf8')
    .replace('@import "tailwindcss";', `@import "tailwindcss" source(none);\n@source inline("${className.replace(/"/g, '\\"')}");`)
  const { css } = await postcss([tailwind({ base: path.resolve(__dirname, '..') })]).process(input, { from: globals })
  const raw: Paint = {}
  const classes = className.split(/\s+/).filter(Boolean)
  const walk = (n: Node, sel = '') => {
    const s = n.type === 'rule' ? (n.selector!.includes('&') ? n.selector!.replace(/&/g, sel) : n.selector!).replace(/\\/g, '') : sel
    for (const c of n.nodes ?? []) {
      if (c.type === 'decl' && n.type === 'rule') {
        for (const cls of classes) {
          const state = s === `.${cls}` ? 'fill' : s === `.${cls}:hover` ? 'hover' : s === `.${cls}:active` ? 'active' : null
          if (state && c.prop === 'background-color') raw[state] = c.value
          if (state === 'fill' && c.prop === 'color') raw.text = c.value
        }
      }
      walk(c, s)
    }
  }
  walk(postcss.parse(css))
  const res = (v: Record<string, string>) => Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, resolve(v, x!)])) as Paint
  return { light: res(LIGHT), dark: res(DARK) }
}

const PRIMARY = {
  light: { fill: resolve(LIGHT, 'var(--color-primary)'), hover: resolve(LIGHT, 'var(--color-primary-hover)'), active: resolve(LIGHT, 'var(--color-primary-active)'), text: resolve(LIGHT, 'var(--color-on-primary)') },
  dark: { fill: resolve(DARK, 'var(--color-primary)'), hover: resolve(DARK, 'var(--color-primary-hover)'), active: resolve(DARK, 'var(--color-primary-active)'), text: resolve(DARK, 'var(--color-on-primary)') },
}

describe('the admin primary action reads the primary tokens', () => {
  it('the tokens are the owner\'s primary blue (#1264a3, dark #1b71b8) with white text', () => {
    expect([PRIMARY.light.fill, PRIMARY.dark.fill, PRIMARY.light.text, PRIMARY.dark.text]).toEqual(['#1264a3', '#1b71b8', '#ffffff', '#ffffff'])
  })

  it('Button (default variant): fill, hover, pressed and text, light and dark', async () => {
    render(<Button>保存する</Button>)
    expect(await paint(screen.getByRole('button', { name: '保存する' }).className)).toEqual(PRIMARY)
  }, 30_000)

  it('an ordinary ConfirmDialog\'s main action is primary; a destructive one is not', async () => {
    function Harness({ destructive }: { destructive: boolean }) {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>開く</button>
          <ConfirmDialog open={open} onOpenChange={setOpen} title="公開しますか？" description="全員に見えます。" confirmLabel="公開する" destructive={destructive} onConfirm={async () => {}} />
        </>
      )
    }
    const user = userEvent.setup()
    const { unmount } = render(<Harness destructive={false} />)
    await user.click(screen.getByRole('button', { name: '開く' }))
    expect(await paint((await screen.findByRole('button', { name: '公開する' })).className)).toEqual(PRIMARY)
    unmount()

    render(<Harness destructive />)
    await user.click(screen.getByRole('button', { name: '開く' }))
    const danger = await paint((await screen.findByRole('button', { name: '公開する' })).className)
    expect(danger.light.fill).toBe(resolve(LIGHT, 'var(--color-danger)'))
    expect(danger.light.fill).not.toBe(PRIMARY.light.fill)
  }, 30_000)
})
