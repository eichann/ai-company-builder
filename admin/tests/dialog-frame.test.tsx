// One dialog frame and the link / selected split in the admin (design-system.md "Dialog frames, link
// and selected (P2c, done)"): every dialog draws the same scrim, surface, corner, shadow, padding and
// title as the app's `Dialog`, picks one of three widths, and text links and chosen options read
// their own tokens (`link`, `selected-*`) instead of the indigo `brand`. Measured from the CSS
// Tailwind 4 generates for the rendered classes, resolved through the token files in light and dark.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { Button } from '@/components/ui/button'
import { RadioCard } from '@/components/app/radio-card'
import { AudienceSummary } from '@/components/private-folders/audience-fields'
import { DARK, LIGHT, paint, resolve, styles } from './token-paint'

const both = (name: string) => ({ light: resolve(LIGHT, `var(--${name})`), dark: resolve(DARK, `var(--${name})`) })

async function frameOf(dialog: HTMLElement) {
  const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!
  return { panel: await paint(dialog.className), panelStyle: await styles(dialog.className), overlay: await paint(overlay.className) }
}

describe('the admin dialog frame', () => {
  it('scrim, surface, corner 12px, the dialog shadow, padding 20px and a 15px title, light and dark', async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader><DialogTitle>部署を追加</DialogTitle><DialogDescription>部署のフォルダを作ります。</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline">キャンセル</Button><Button>追加する</Button></DialogFooter>
        </DialogContent>
      </Dialog>,
    )
    const dialog = await screen.findByRole('dialog', { name: '部署を追加' })
    const { panel, panelStyle, overlay } = await frameOf(dialog)
    const surface = both('color-surface-raised')
    const scrim = both('color-scrim')
    for (const theme of ['light', 'dark'] as const) {
      expect(panel[theme].fill, `${theme} surface`).toBe(surface[theme])
      expect(overlay[theme].fill, `${theme} scrim`).toBe(scrim[theme])
      // Tailwind 4 composes the shadow through --tw-shadow; the token's offsets and blur must be in it.
      expect(panelStyle[theme]['--tw-shadow'], `${theme} shadow`).toContain('0 24px 56px')
    }
    expect(panelStyle.light['border-radius']).toBe('12px')
    expect(panelStyle.light.padding).toBe('20px')
    expect(panelStyle.light['max-width']).toBe('480px') // md by default
    const title = await styles(screen.getByText('部署を追加').className)
    expect(title.light['font-size']).toBe('0.9375rem') // 15px
    // The buttons row: 「キャンセル」 first (left), the main action last (right).
    const buttons = screen.getAllByRole('button').filter(b => b.closest('[data-slot="dialog-footer"]'))
    expect(buttons.map(b => b.textContent)).toEqual(['キャンセル', '追加する'])
  }, 30_000)

  it('sizes are the three widths 400 / 480 / 640', async () => {
    for (const [size, px] of [['sm', '400px'], ['md', '480px'], ['lg', '640px']] as const) {
      const { unmount } = render(<Dialog open><DialogContent size={size}><DialogTitle>幅 {size}</DialogTitle><DialogDescription>説明</DialogDescription></DialogContent></Dialog>)
      const dialog = await screen.findByRole('dialog', { name: `幅 ${size}` })
      expect((await styles(dialog.className)).light['max-width'], size).toBe(px)
      unmount()
    }
  }, 60_000)

  it('the confirm dialog is the same frame', async () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="公開しますか？" description="全員に見えます。" confirmLabel="公開する" destructive={false} onConfirm={async () => {}} />)
    const dialog = await screen.findByRole('dialog', { name: '公開しますか？' })
    const { panel, panelStyle } = await frameOf(dialog)
    expect(panel.dark.fill).toBe(both('color-surface-raised').dark)
    expect(panelStyle.light['border-radius']).toBe('12px')
  }, 30_000)
})

describe('links and chosen options read link / selected, not the indigo brand', () => {
  it('a link button is the link colour, light and dark', async () => {
    render(<Button variant="link">詳しく見る</Button>)
    const p = await paint(screen.getByRole('button', { name: '詳しく見る' }).className)
    expect({ light: p.light.text, dark: p.dark.text }).toEqual(both('color-link'))
  }, 30_000)

  it('a chosen radio card is the selected set; an unchosen one is not', async () => {
    const { unmount } = render(<RadioCard checked onSelect={() => {}} label="指定した人だけ" help="選んだ人だけが編集できます" />)
    const on = await paint(screen.getByRole('radio', { name: /指定した人だけ/ }).className)
    expect({ light: on.light.fill, dark: on.dark.fill }).toEqual(both('color-selected-bg'))
    expect({ light: on.light.border, dark: on.dark.border }).toEqual(both('color-selected-border'))
    unmount()
    render(<RadioCard checked={false} onSelect={() => {}} label="全員" help="全員が編集できます" />)
    const off = await paint(screen.getByRole('radio', { name: /全員/ }).className)
    expect(off.light.fill).toBeUndefined()
  }, 30_000)
})

describe('a private place is the app\'s amber (owner decision 2026-11-22: the app is the reference)', () => {
  it('the 「n 人にだけ届きます」 box and its lock: private-bg / private-border / private-text, light and dark', async () => {
    render(<AudienceSummary viewers={3} editors={3} />)
    const box = screen.getByRole('status')
    const fill = await paint(box.className)
    expect({ light: fill.light.fill, dark: fill.dark.fill }).toEqual(both('color-private-bg'))
    expect({ light: fill.light.border, dark: fill.dark.border }).toEqual(both('color-private-border'))
    const lock = await paint(box.querySelector('svg')!.getAttribute('class')!)
    expect({ light: lock.light.text, dark: lock.dark.text }).toEqual(both('color-private-text'))
    // Amber like the app's 「あなただけ」, not the indigo brand nor the primary blue.
    expect(lock.light.text).toBe('#b45309')
  }, 30_000)
})
