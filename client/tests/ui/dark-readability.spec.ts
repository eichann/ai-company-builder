// The screens that stayed white in dark mode (design-system.md "Dark-mode readability (P1b,
// done)") follow the theme: with the `dark` class on <html> their surface is dark and their main
// text reads on it (WCAG AA, 4.5:1); in light mode the surface stays light. Measured from the
// computed colours of what the member sees (the surface is the nearest ancestor with a painted
// background), not from class names or pixels.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Theme = 'light' | 'dark'

/** Relative luminance of the surface behind `el` and the contrast of its text colour on it. */
async function readability(el: Locator): Promise<{ surface: number; contrast: number }> {
  return el.evaluate(node => {
    const parse = (css: string) => {
      const m = css.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return { r, g, b, a }
    }
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    }
    let bg = null as ReturnType<typeof parse>
    for (let at: Element | null = node; at; at = at.parentElement) {
      const c = parse(getComputedStyle(at).backgroundColor)
      if (c && c.a > 0.5) { bg = c; break }
    }
    const surface = lum(bg ?? { r: 255, g: 255, b: 255 })
    const fg = parse(getComputedStyle(node).color)!
    const text = lum(fg)
    const [hi, lo] = text > surface ? [text, surface] : [surface, text]
    return { surface, contrast: (hi + 0.05) / (lo + 0.05) }
  })
}

/** In dark mode the surface is dark; in light mode light; either way the text reads at 4.5:1. */
async function expectReadable(theme: Theme, ...texts: Locator[]) {
  for (const text of texts) {
    await expect(text).toBeVisible()
    const { surface, contrast } = await readability(text)
    const name = await text.evaluate(n => (n.textContent || (n as HTMLInputElement).value || '').trim().slice(0, 30))
    if (theme === 'dark') expect(surface, `surface behind 「${name}」 is dark`).toBeLessThan(0.05)
    else expect(surface, `surface behind 「${name}」 is light`).toBeGreaterThan(0.8)
    expect(contrast, `「${name}」 reads on its surface`).toBeGreaterThanOrEqual(4.5)
  }
}

async function open(page: Page, name: string, theme: Theme, query: Record<string, string> = {}) {
  const state = await openPreview(page, name, theme === 'dark' ? { ...query, theme } : query)
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
  return state
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(theme, () => {
    test('the file tree\'s right-click menu', async ({ page }) => {
      const state = await open(page, 'file-tree', theme)
      await page.getByRole('button', { name: '議事録', exact: true }).click({ button: 'right' })
      await expectReadable(theme, page.getByRole('button', { name: /^名前を変更/ }), page.getByRole('button', { name: /^パスをコピー/ }))
      expectNoPageErrors(state)
    })

    test('the name dialog (InputDialog)', async ({ page }) => {
      await open(page, 'file-tree', theme)
      await page.getByRole('button', { name: 'README.md', exact: true }).click({ button: 'right' })
      await page.getByRole('button', { name: /^名前を変更/ }).click()
      await expectReadable(theme, page.getByRole('heading', { name: '名前を変更' }), page.getByRole('textbox'), page.getByRole('button', { name: 'キャンセル' }))
    })

    test('the company selector: the list, the empty state and the folder choice', async ({ page }) => {
      await open(page, 'company-selector', theme)
      await expectReadable(theme, page.getByText('山田工務店', { exact: true }), page.getByText('demo@example.com'))
      await page.getByText('阿部商店', { exact: true }).click()
      await expectReadable(theme, page.getByText('既存のフォルダを開く'), page.getByRole('button', { name: '戻る' }))
      await open(page, 'company-selector', theme, { companies: 'empty' })
      await expectReadable(theme, page.getByText('まだ会社がありません。新しく作成してください。'), page.getByText('新しい会社を作成'))
    })

    test('the company switcher menu in the title bar', async ({ page }) => {
      await open(page, 'skill-layout', theme, { companies: '2' })
      await page.getByTitle('会社を切り替える').click()
      const menu = page.getByRole('menu', { name: '会社を切り替える' })
      await expectReadable(theme, menu.getByRole('menuitem', { name: '別会社' }), menu.getByText('ほかの会社を開く'))
    })

    test('the chat\'s loading box', async ({ page }) => {
      await open(page, 'skill-layout', theme)
      // The box with the spinner (it used to stay white in dark mode). Its label sits on the chat
      // pane's own surface, which is not part of this change, so only the box is measured.
      const label = page.getByText('認証を確認中...')
      await expect(label).toBeVisible()
      const box = label.locator('xpath=preceding-sibling::div[1]/div')
      const { surface } = await readability(box)
      if (theme === 'dark') expect(surface).toBeLessThan(0.05)
      else expect(surface).toBeGreaterThan(0.8)
    })

    test('the login screen, with its error', async ({ page }) => {
      const state = await open(page, 'sign-in', theme)
      await page.getByRole('button', { name: 'ログイン' }).click()
      await expectReadable(theme,
        page.getByRole('heading', { name: 'AI Company Builder' }),
        page.getByText('メールアドレス', { exact: true }),
        page.getByText('メールアドレスとパスワードを入力してください'),
        page.getByRole('link', { name: /Webサイトで新規登録/ }))
      expectNoPageErrors(state)
    })

    test('the server setup screen and the invitation link\'s offer', async ({ page }) => {
      await open(page, 'sign-in', theme, { screen: 'server' })
      await page.getByRole('textbox').fill('bad.example.com')
      await page.keyboard.press('Enter')
      await expectReadable(theme, page.getByRole('heading').first(), page.getByRole('textbox'), page.getByText('このアドレスの会社のサーバーが見つかりません'))
      await open(page, 'sign-in', theme, { screen: 'offer' })
      await expectReadable(theme, page.getByRole('heading', { name: '招待のリンクから開きました' }), page.getByLabel('つなぐサーバー'), page.getByRole('button', { name: 'つながない' }))
    })

    test('the new skill wizard follows the theme', async ({ page }) => {
      await open(page, 'keep-work', theme, { view: 'skills' })
      await page.getByRole('button', { name: '新しいスキル' }).click()
      await page.getByPlaceholder('例: 提案書作成').fill('提案書')
      await expectReadable(theme, page.getByRole('heading', { name: '新しいSKILLを作成' }), page.locator('label', { hasText: 'スキル名' }), page.getByPlaceholder('例: 提案書作成'))
      // A step not reached yet: its number in the grey circle still reads.
      await expectReadable(theme, page.getByText('2', { exact: true }))
    })
  })
}
