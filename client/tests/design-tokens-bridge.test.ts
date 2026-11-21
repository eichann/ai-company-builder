// The design-token bridges (shared/design-tokens, .claude/rules/design-system.md) add semantic
// class names without changing what any existing class means, and never point at a variable the
// tokens do not define (a typo there is a class that silently renders nothing).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import appConfig from '../tailwind.config.js'

const require = createRequire(import.meta.url)
const resolveConfig = require('tailwindcss/resolveConfig') as (c: object) => { theme: Record<string, unknown> }
const tokensDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/design-tokens')
const read = (f: string) => fs.readFileSync(path.join(tokensDir, f), 'utf8')

function flatten(value: unknown, prefix: string, out: Map<string, string>) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else {
    out.set(prefix, JSON.stringify(value))
  }
  return out
}

test('the app bridge changes no existing class: every theme value without it is the same with it', () => {
  // Without `presets` at all, so Tailwind's defaults (text-sm, rounded-lg, …) are compared too
  // (`presets: []` would drop them).
  const withoutBridge: Record<string, unknown> = { ...appConfig }
  delete withoutBridge.presets
  const without = flatten(resolveConfig(withoutBridge).theme, '', new Map())
  const withBridge = flatten(resolveConfig(appConfig).theme, '', new Map())
  const changed = [...without].filter(([k, v]) => withBridge.get(k) !== v).map(([k]) => k)
  assert.deepEqual(changed, [], 'the bridge redefines an existing name (accent, surface, text-sm, rounded-lg, …): add a new name instead')
  assert.ok(withBridge.size > without.size + 50, 'the bridge adds the semantic names (self-test)')
})

test('app semantic colours take an opacity modifier, and the semantic names resolve to the tokens', async () => {
  const html = '<div class="bg-primary/10 bg-surface-raised text-text-muted text-body rounded-control z-dialog data-[state=open]:bg-selected-bg">'
  const { css } = await postcss([tailwind({ ...appConfig, content: [{ raw: html, extension: 'html' }], corePlugins: { preflight: false } })])
    .process('@tailwind utilities;', { from: undefined })
  const rule = (sel: string) => { const i = css.indexOf(sel); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)) }
  assert.match(rule('.bg-primary\\/10'), /rgb\(var\(--color-primary-rgb\) \/ 0\.1\)/)
  assert.match(rule('.bg-surface-raised'), /var\(--color-surface-raised-rgb\)/)
  assert.match(rule('.text-body'), /font-size: var\(--font-size-body\)/)
  assert.match(rule('.rounded-control'), /var\(--radius-control\)/)
  assert.match(rule('.z-dialog'), /var\(--z-dialog\)/)
  assert.match(rule('data-\\[state\\=open\\]\\:bg-selected-bg'), /var\(--color-selected-bg-rgb\)/)
})

test('both bridges reference only variables the tokens (or the bridge, or Tailwind) define', () => {
  const defined = new Set([...(read('primitives.css') + read('theme.css') + read('tailwind-bridge.admin.css'))
    .matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]))
  const used = (text: string) => [...text.matchAll(/var\(--([a-z0-9-]*[a-z0-9])\b(?!-)/g)].map(m => m[1])
  const missing = [...used(read('tailwind-bridge.app.cjs')), ...used(read('tailwind-bridge.admin.css')), ...used(read('theme.css'))]
    .filter(n => !defined.has(n) && !n.startsWith('tw-'))
  assert.deepEqual([...new Set(missing)], [])
})
