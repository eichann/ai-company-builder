// Settings → ダウンロードするフォルダ and the file tree's 未ダウンロード
// placeholder (tests/download-folders-ui.tsx). Tri-state / toggle / size rules
// are pinned by tests/download-selection.test.ts and sparse rules by
// sparse-paths.test.ts; here: the tree's ARIA, the draft footer, apply with
// progress, the uncommitted-changes confirmation, offline, and the placeholder;
// and the APIキー page, which never shows a saved value.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

const tree = (page: Page) => page.getByRole('tree', { name: 'ダウンロードするフォルダ' })
const box = (page: Page, name: string) => tree(page).getByRole('checkbox', { name: `${name}をダウンロードする` })
const footer = (page: Page) => page.getByText(/^未適用の変更：/)

test.describe('settings', () => {
  test('tri-state tree; children of a folder left out are disabled; a draft applies with progress', async ({ page }) => {
    await openPreview(page, 'download-folders')
    await expect(page.getByText('6.5 GB をダウンロード済み（全体 10.4 GB）')).toBeVisible()
    await expect(page.getByText('2 個のフォルダをダウンロードしていません')).toBeVisible()
    await expect(box(page, 'コンテンツ')).toHaveAttribute('aria-checked', 'mixed')
    await expect(box(page, '営業部')).not.toBeChecked()
    await expect(box(page, '開発部')).toBeChecked()

    await tree(page).getByRole('treeitem', { name: '営業部' }).getByRole('button', { name: '開く' }).click()
    await expect(box(page, '提案書')).toBeDisabled()

    await box(page, '営業部').click()
    await expect(footer(page)).toHaveText('未適用の変更：1 個をダウンロード')
    await expect(box(page, '提案書')).toBeEnabled()
    await page.getByRole('button', { name: '適用', exact: true }).click()
    await expect(footer(page)).toHaveCount(0)
    await expect(page.getByText('1 個のフォルダをダウンロードしていません')).toBeVisible()
    await expect(page.getByText(/^7\.\d GB をダウンロード済み（全体 10\.4 GB）$/)).toBeVisible()
  })

  test('取り消す drops the draft', async ({ page }) => {
    await openPreview(page, 'download-folders')
    await box(page, '開発部').click()
    await expect(footer(page)).toHaveText('未適用の変更：1 個をダウンロードしない')
    await page.getByRole('button', { name: '取り消す' }).click()
    await expect(footer(page)).toHaveCount(0)
    await expect(box(page, '開発部')).toBeChecked()
  })

  test('leaving out a folder with unsynced changes asks first; cancelling keeps the draft', async ({ page }) => {
    await openPreview(page, 'download-folders', { state: 'confirm' })
    await box(page, '開発部').click()
    await page.getByRole('button', { name: '適用', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'まだ同期していない変更があります' })
    await expect(dialog.getByRole('listitem')).toHaveText(['開発部/編集メモ.md', '開発部/構成案_v3.pptx', '開発部/新規/台本.md'])
    await dialog.getByRole('button', { name: 'キャンセル' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(footer(page)).toHaveText('未適用の変更：1 個をダウンロードしない')

    await page.getByRole('button', { name: '適用', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '.backups に保存して進める' }).click()
    await expect(footer(page)).toHaveCount(0)
    await expect(box(page, '開発部')).not.toBeChecked()
  })

  test('offline: sizes are 「—」; a download that fails says so and keeps the draft', async ({ page }) => {
    await openPreview(page, 'download-folders', { state: 'offline' })
    await expect(page.getByText('サーバーに接続できません')).toBeVisible()
    await expect(tree(page).getByRole('treeitem', { name: '営業部' })).toContainText('—')

    await openPreview(page, 'download-folders', { state: 'applyOffline' })
    await box(page, '営業部').click()
    await page.getByRole('button', { name: '適用', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('インターネットにつながっているときにダウンロードできます。何も変更していません。')
    await expect(box(page, '営業部')).toBeChecked()
    await expect(page.getByRole('button', { name: '適用', exact: true })).toBeVisible()
  })

  test('APIキー: a saved key shows only 「設定済み（末尾 …）」; a save sends typed keys and removals only', async ({ page }) => {
    await openPreview(page, 'download-folders')
    await page.getByRole('button', { name: 'APIキー' }).click()
    const anthropic = page.getByRole('textbox', { name: 'Anthropic', exact: true })
    await expect(anthropic).toHaveValue('')
    await expect(anthropic).toHaveAttribute('placeholder', '設定済み（末尾 ab12）。変更するときだけ入力')
    await page.getByRole('textbox', { name: 'OpenAI', exact: true }).fill('sk-FAKE-typed')
    await page.getByRole('button', { name: 'ANTHROPIC_API_KEY を削除' }).click()
    await expect(anthropic).toBeDisabled()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存しました' })).toBeVisible()
    const updates = await page.evaluate(() => (window as unknown as { __acbEnvUpdates: unknown[] }).__acbEnvUpdates)
    expect(updates).toEqual([{ OPENAI_API_KEY: 'sk-FAKE-typed', ANTHROPIC_API_KEY: null }])
  })
})

test.describe('file tree', () => {
  test('a not-downloaded folder is a placeholder that does not open; its 「ダウンロード」 turns it into a folder', async ({ page }) => {
    await openPreview(page, 'download-folders', { view: 'filetree' })
    const placeholder = page.getByRole('button', { name: '2025年度（未ダウンロード）' })
    await expect(placeholder).toContainText('未ダウンロード')
    await placeholder.click()
    await expect(placeholder).toBeVisible()
    await placeholder.hover()
    await placeholder.getByRole('button', { name: 'ダウンロード' }).click()
    await expect(placeholder).toHaveCount(0)
    await expect(page.getByRole('button', { name: '2025年度', exact: true })).toBeVisible()
  })

  test('a file the AI writes into an open folder appears in place', async ({ page }) => {
    await openPreview(page, 'download-folders', { view: 'filetree' })
    await expect(page.getByRole('button', { name: '入稿ルール.md' })).toBeVisible()
    await page.evaluate(() => (window as unknown as { __acbAddFile: (dir: string, name: string) => void }).__acbAddFile('コンテンツ/記事', 'AIの新規.md'))
    await expect(page.getByRole('button', { name: 'AIの新規.md' })).toBeVisible()
    const names = await page.getByRole('button', { name: /\.md$/ }).allTextContents()
    expect(names.indexOf('AIの新規.md')).toBe(names.indexOf('2026-10-連載.md') + 1)
  })

})
