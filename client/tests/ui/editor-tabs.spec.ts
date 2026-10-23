// TabbedEditorPanel when the open file changes on disk (the AI, a sync pull):
// tests/editor-tabs-ui.tsx?view=external. The decisions (follow the disk,
// banner, save asks, recreate) are pinned by tests/editor-disk-state.test.ts;
// here: the watcher event reaching the tab, the banner's buttons, the confirm
// dialog, the backup notice and what ends up on "disk".
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

const FILE = '/Users/demo/会社/コンテンツG/台本.md'
const AI_PARAGRAPH = 'AI が追記した段落です。'
const editor = (page: Page) => page.locator('.cm-content[role="textbox"]')
const banner = (page: Page) => page.getByRole('alert').filter({ has: page.getByRole('button') })
const disk = (page: Page) => page.evaluate(path => (window as unknown as { __acbFiles: Record<string, string | undefined> }).__acbFiles[path], FILE)

async function openWithEdits(page: Page) {
  await openPreview(page, 'editor-tabs', { view: 'external' })
  await expect(editor(page)).toContainText('第12回の構成案です。')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n私の追記')
}

test('a clean tab follows the disk: the AI\'s edit appears, no banner', async ({ page }) => {
  await openPreview(page, 'editor-tabs', { view: 'external' })
  await expect(editor(page)).toContainText('第12回の構成案です。')
  await page.getByTestId('external-edit').click()
  await expect(editor(page)).toContainText(AI_PARAGRAPH)
  await expect(banner(page)).toHaveCount(0)
})

test('a clean tab whose file is deleted keeps its content and says so', async ({ page }) => {
  await openPreview(page, 'editor-tabs', { view: 'external' })
  await expect(editor(page)).toContainText('第12回の構成案です。')
  await page.getByTestId('external-delete').click()
  await expect(page.getByText('このファイルは削除されたか、移動されました。表示しているのは開いていたときの内容です。')).toBeVisible()
  await expect(editor(page)).toContainText('第12回の構成案です。')
})

test('edits + a change on disk: banner, autosave paused, diff, keep mine, then save asks and backs the disk version up', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await expect(banner(page)).toContainText('このファイルは外部で変更されました。あなたの編集はまだ保存していません')
  await expect(page.getByText('自動保存を止めています（外部の変更あり・未保存の変更あり）')).toBeVisible()
  await expect(editor(page)).toContainText('私の追記')
  // Autosave would have run after 1 s: the disk keeps the AI's version.
  await page.waitForTimeout(1500)
  expect(await disk(page)).toContain(AI_PARAGRAPH)
  expect(await disk(page)).not.toContain('私の追記')

  const diff = banner(page).getByRole('button', { name: '差分を見る' })
  await diff.click()
  await expect(banner(page).getByRole('button', { name: '差分を閉じる' })).toHaveAttribute('aria-pressed', 'true')

  await banner(page).getByRole('button', { name: '自分の編集を残す' }).click()
  await expect(banner(page)).toContainText('編集を続けられます（自動保存は止めています）')
  await banner(page).getByRole('button', { name: '保存…' }).click()
  await page.getByRole('button', { name: '外部の変更を上書きして保存' }).click()
  await expect(page.getByText(/外部で変更された内容をバックアップしてから上書きしました（\/Users\/demo\/会社\/\.backups\//)).toBeVisible()
  await expect(banner(page)).toHaveCount(0)
  expect(await disk(page)).toContain('私の追記')
})

test('edits + a change on disk: 「ディスクの内容を読み込む」 drops the edits after a confirm', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await banner(page).getByRole('button', { name: 'ディスクの内容を読み込む' }).click()
  await page.getByRole('button', { name: '編集を破棄して読み込む' }).click()
  await expect(banner(page)).toHaveCount(0)
  await expect(editor(page)).toContainText(AI_PARAGRAPH)
  await expect(editor(page)).not.toContainText('私の追記')
})

test('edits + the file deleted on disk: 「保存して作り直す」 writes it back', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-delete').click()
  await expect(banner(page)).toContainText('ファイルは削除されました。保存すると作り直します')
  expect(await disk(page)).toBeUndefined()
  await banner(page).getByRole('button', { name: '保存して作り直す' }).click()
  await expect(banner(page)).toHaveCount(0)
  expect(await disk(page)).toContain('私の追記')
})
