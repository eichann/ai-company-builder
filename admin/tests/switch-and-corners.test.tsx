// Sizes and corners (design-system.md "Sizes, type and corners (P3, done)"): the admin's switch is the
// app's — 36×20, "on" the primary colour, "off" border-strong (3:1), the thumb on-primary — and native
// check boxes are "on" in the primary colour. Measured from the CSS Tailwind 4 generates for the
// rendered classes, resolved through the token files in light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Switch } from '@/components/ui/switch'
import { DARK, LIGHT, paint, resolve, styles } from './token-paint'

const both = (v: string) => ({ light: resolve(LIGHT, v), dark: resolve(DARK, v) })

describe('the admin switch and check boxes read the tokens', () => {
  it('a switch is 36×20 with its thumb inside; on = primary, off = border-strong, light and dark', async () => {
    render(<><Switch checked aria-label="オン" /><Switch checked={false} aria-label="オフ" /></>)
    const on = screen.getByRole('switch', { name: 'オン' })
    const off = screen.getByRole('switch', { name: 'オフ' })
    expect(on).toHaveAttribute('aria-checked', 'true')
    expect(off).toHaveAttribute('aria-checked', 'false')

    const size = await styles(on.className)
    expect([size.light.width, size.light.height]).toEqual([resolve(LIGHT, 'var(--size-switch-w)'), resolve(LIGHT, 'var(--size-switch-h)')])
    expect([resolve(LIGHT, 'var(--size-switch-w)'), resolve(LIGHT, 'var(--size-switch-h)')]).toEqual(['36px', '20px'])

    const pOn = await paint(on.className), pOff = await paint(off.className)
    const primary = both('var(--color-primary)'), strong = both('var(--color-border-strong)')
    expect([pOn.light.fill, pOn.dark.fill]).toEqual([primary.light, primary.dark])
    expect([pOff.light.fill, pOff.dark.fill]).toEqual([strong.light, strong.dark])
    const thumb = await paint(on.querySelector('span')!.className)
    expect([thumb.light.fill, thumb.dark.fill]).toEqual(Object.values(both('var(--color-on-primary)')))
  }, 30_000)

  it('native check boxes and radio buttons are "on" in the primary colour', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/app/globals.css'), 'utf8')
    expect(css).toMatch(/input\[type='checkbox'\],\s*input\[type='radio'\]\s*\{\s*accent-color:\s*var\(--color-primary\);/)
  })
})
