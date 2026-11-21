// The admin's primary action is the primary blue (design-system.md "Primary actions (P2a, done)",
// owner decision 2: the black primary buttons became the primary colour). Measured from the CSS
// Tailwind 4 really generates for the classes on the rendered button, resolved through the token
// files in light and dark — not from class names alone, so a class that stops reading the token
// (a hard-coded black, a bridge that keeps today's value) fails.
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { DARK, LIGHT, paint, resolve } from './token-paint'

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
