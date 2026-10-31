// Settings → ダウンロードするフォルダ and the file tree's 未ダウンロード
// placeholder (tests/download-folders-ui.tsx). Tri-state / toggle / size rules
// are pinned by src/shared/lib/download-selection.test.ts and sparse rules by
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

  test('APIキー（このPC）: says it is for older apps, and moves a built-in key to the server (last 4 only)', async ({ page }) => {
    await openPreview(page, 'download-folders')
    await page.getByRole('button', { name: 'APIキー' }).click()
    await expect(page.getByText('古い版のアプリや、特別な場合のための画面です')).toBeVisible()
    const row = page.getByRole('listitem', { name: 'Anthropic（Claude API）（ANTHROPIC_API_KEY）' })
    await expect(row).toContainText('末尾 ab12')
    await row.getByRole('button', { name: 'この鍵をサーバーに移す' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'サーバーに移し、この PC の .env から消しました。鍵が有効なことを確かめました。' })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __acbMoved: unknown[] }).__acbMoved)).toEqual(['ANTHROPIC_API_KEY'])
    // The .env no longer holds it: the page reads its state again.
    await expect(page.getByRole('textbox', { name: 'Anthropic', exact: true })).not.toHaveAttribute('placeholder', /設定済み/)
  })

  // The owner-approved defaults and that a choice survives a restart (stored on this PC).
  test('自動同期: receive on every 15 minutes and send off by default; turning send on keeps its times after a restart', async ({ page }) => {
    await openPreview(page, 'download-folders')
    await page.evaluate(() => localStorage.removeItem('acb.autoSync.settings'))
    await page.reload()
    await page.getByRole('button', { name: '自動同期' }).click()
    const receive = page.getByRole('switch', { name: '自動で受け取る' })
    const send = page.getByRole('switch', { name: '自動で送る' })
    await expect(receive).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('combobox', { name: '間隔' })).toHaveValue('15')
    await expect(send).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('radio', { name: '決まった時刻に送る' })).toBeDisabled()

    await send.click()
    await expect(send).toHaveAttribute('aria-checked', 'true')
    const times = page.getByRole('group', { name: '送る時刻' })
    await expect(times).toContainText('12:00')
    await expect(times).toContainText('18:00')
    await page.getByRole('textbox', { name: '追加する時刻' }).fill('09:30')
    await page.getByRole('button', { name: '時刻を追加' }).click()
    await expect(times).toContainText('09:30')

    await page.reload()
    await page.getByRole('button', { name: '自動同期' }).click()
    await expect(page.getByRole('switch', { name: '自動で送る' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('group', { name: '送る時刻' })).toContainText('09:30')
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
