// The admin's confirm dialog follows the same keyboard rules as the app's (design-system.md P1):
// a destructive confirm is an alertdialog with focus on 「キャンセル」 that a scrim click does not
// close; an ordinary one starts on its main action; Esc cancels; focus goes back to the button
// that opened it, although the callers open it without a Radix trigger.
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from '@/components/app/confirm-dialog'

function Harness({ destructive, onConfirm = async () => {} }: { destructive?: boolean, onConfirm?: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>開く</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="規則を外しますか？"
        description="この場所の規則を外します。"
        confirmLabel="外す"
        destructive={destructive}
        onConfirm={onConfirm}
      />
    </>
  )
}

describe('admin ConfirmDialog keyboard rules', () => {
  it('destructive: an alertdialog, focus starts on キャンセル, the scrim does not close it, Esc does and focus returns', async () => {
    const user = userEvent.setup()
    render(<Harness destructive />)
    const opener = screen.getByRole('button', { name: '開く' })
    await user.click(opener)
    const dialog = await screen.findByRole('alertdialog', { name: '規則を外しますか？' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('この場所の規則を外します。')
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus()

    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement
    await user.pointer({ keys: '[MouseLeft]', target: overlay })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it('ordinary: a dialog whose focus starts on the main action; Enter presses it and focus returns', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn(async () => {})
    render(<Harness destructive={false} onConfirm={onConfirm} />)
    const opener = screen.getByRole('button', { name: '開く' })
    await user.click(opener)
    await screen.findByRole('dialog', { name: '規則を外しますか？' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '外す' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it('Tab stays inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Harness destructive />)
    await user.click(screen.getByRole('button', { name: '開く' }))
    const dialog = await screen.findByRole('alertdialog')
    for (let i = 0; i < 5; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })
})
