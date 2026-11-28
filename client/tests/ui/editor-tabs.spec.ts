// TabbedEditorPanel when the open file changes on disk (the AI, a sync pull):
// tests/editor-tabs-ui.tsx?view=external. The decisions (follow the disk,
// banner, the compare choice, recreate) are pinned by tests/editor-disk-state.test.ts;
// here: the watcher event reaching the tab, the banner's ［比べて選ぶ］, the compare
// view's two one-press choices, what is kept in the backups first and what ends up on "disk".
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

const FILE = '/Users/demo/会社/コンテンツG/台本.md'
const AI_PARAGRAPH = 'AI が追記した段落です。'
/** A confirm of any kind (a dangerous one is an alertdialog). */
const anyDialog = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]')
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

type Kept = { reason: string; path: string; content: string | undefined }
const backups = (page: Page) => page.evaluate(() => (window as unknown as { __acbBackups: Kept[] }).__acbBackups)
const compare = (page: Page) => page.getByTestId('external-compare')

test('edits + a change on disk: banner, autosave paused, one ［比べて選ぶ］ that opens the compare view', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await expect(banner(page)).toContainText('このファイルは外部で変更されました。あなたの編集はまだ保存していません')
  await expect(page.getByRole('tab').getByRole('img', { name: '保存していない変更があります' })).toBeVisible()
  await expect(editor(page)).toContainText('私の追記')
  // Autosave would have run after 1 s: the disk keeps the AI's version.
  await page.waitForTimeout(1500)
  expect(await disk(page)).toContain(AI_PARAGRAPH)
  expect(await disk(page)).not.toContain('私の追記')

  await expect(banner(page).getByRole('button')).toHaveText(['比べて選ぶ'])
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()
  await expect(compare(page)).toContainText('届いた版／')
  await expect(compare(page).getByRole('button', { name: '自分の版を保存' })).toBeVisible()
  await expect(compare(page).getByRole('button', { name: '届いた版を採用' })).toBeVisible()
  await banner(page).getByRole('button', { name: '比べるのをやめる' }).click()
  await expect(compare(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('私の追記')
})

test('［自分の版を保存］ saves in one press, after keeping the version that arrived in the backups', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()
  await compare(page).getByRole('button', { name: '自分の版を保存' }).click()
  await expect(page.getByText('あなたの版を保存しました。届いた版はバックアップに残しています（タイトルバーの［バックアップ履歴］で見られます）')).toBeVisible()
  await expect(anyDialog(page)).toHaveCount(0)
  await expect(banner(page)).toHaveCount(0)
  expect(await disk(page)).toContain('私の追記')
  const kept = await backups(page)
  expect(kept).toHaveLength(1)
  expect(kept[0].reason).toBe('editor_overwrite')
  expect(kept[0].content).toContain(AI_PARAGRAPH)
  expect(kept[0].content).not.toContain('私の追記')
})

test('［届いた版を採用］ takes it in one press, no confirm, after keeping the edits in the backups', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()
  await compare(page).getByRole('button', { name: '届いた版を採用' }).click()
  await expect(page.getByText('届いた版にしました。あなたの編集はバックアップに残しています（タイトルバーの［バックアップ履歴］で見られます）')).toBeVisible()
  await expect(anyDialog(page)).toHaveCount(0)
  await expect(banner(page)).toHaveCount(0)
  await expect(editor(page)).toContainText(AI_PARAGRAPH)
  await expect(editor(page)).not.toContainText('私の追記')
  expect(await disk(page)).not.toContain('私の追記')
  const kept = await backups(page)
  expect(kept).toHaveLength(1)
  expect(kept[0].reason).toBe('editor_edits')
  expect(kept[0].content).toContain('私の追記')
})

test('a backup that cannot be written replaces nothing, either way, and says so', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await page.evaluate(() => { (window as unknown as { __acbFailBackups: { on: boolean } }).__acbFailBackups.on = true })
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()

  await compare(page).getByRole('button', { name: '自分の版を保存' }).click()
  await expect(page.getByText('届いた版をバックアップに残せなかったため、保存していません。あなたの編集はこのタブにそのまま残っています。')).toBeVisible()
  expect(await disk(page)).toContain(AI_PARAGRAPH)
  expect(await disk(page)).not.toContain('私の追記')

  await compare(page).getByRole('button', { name: '届いた版を採用' }).click()
  await expect(page.getByText('あなたの編集をバックアップに残せなかったため、届いた版にしていません。あなたの編集はこのタブにそのまま残っています。')).toBeVisible()
  await expect(compare(page)).toBeVisible()
  await expect(banner(page)).toBeVisible()
  await banner(page).getByRole('button', { name: '比べるのをやめる' }).click()
  await expect(editor(page)).toContainText('私の追記')
})

test('a keep that was skipped (kept nowhere) counts as not kept: nothing replaced, either way', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await page.evaluate(() => { (window as unknown as { __acbFailBackups: { skip: boolean } }).__acbFailBackups.skip = true })
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()
  await compare(page).getByRole('button', { name: '自分の版を保存' }).click()
  await expect(page.getByText('届いた版をバックアップに残せなかったため、保存していません。', { exact: false })).toBeVisible()
  expect(await disk(page)).not.toContain('私の追記')
  await compare(page).getByRole('button', { name: '届いた版を採用' }).click()
  await expect(page.getByText('あなたの編集をバックアップに残せなかったため、届いた版にしていません。', { exact: false })).toBeVisible()
  await banner(page).getByRole('button', { name: '比べるのをやめる' }).click()
  await expect(editor(page)).toContainText('私の追記')
})

test('［自分の版を保存］ when the file changes again while the arrived version is being kept: nothing written, compare again', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()
  await page.evaluate(path => {
    const w = window as unknown as { __acbDuringBackup?: () => void; __acbFiles: Record<string, string> }
    w.__acbDuringBackup = () => { w.__acbFiles[path] += '\n\nAI がもう一度直しました。' }
  }, FILE)
  await compare(page).getByRole('button', { name: '自分の版を保存' }).click()
  await expect(compare(page)).toContainText('比べている間に、ファイルがまた変わりました。')
  expect(await disk(page)).toContain('AI がもう一度直しました。')
  expect(await disk(page)).not.toContain('私の追記')
})

test('the file changed again while comparing: nothing is saved or replaced, compare again', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()
  // Changed on disk before the watcher tells the tab: the press itself must notice.
  await page.evaluate(path => { const f = (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles; f[path] += '\n\nAI がもう一度直しました。' }, FILE)
  await compare(page).getByRole('button', { name: '自分の版を保存' }).click()
  await expect(compare(page)).toContainText('比べている間に、ファイルがまた変わりました。新しい内容で比べ直したので、もう一度選んでください。')
  expect(await disk(page)).toContain('AI がもう一度直しました。')
  expect(await disk(page)).not.toContain('私の追記')
  await compare(page).getByRole('button', { name: '届いた版を採用' }).click()
  await expect(editor(page)).toContainText('AI がもう一度直しました。')
  const kept = await backups(page)
  expect(kept.map(k => k.reason)).toEqual(['editor_edits'])
})

test('［届いた版を採用］ when the file changes again while the edits are being kept: the edits stay, compare again', async ({ page }) => {
  await openWithEdits(page)
  await page.getByTestId('external-edit').click()
  await banner(page).getByRole('button', { name: '比べて選ぶ' }).click()
  await page.evaluate(path => {
    const w = window as unknown as { __acbDuringBackup?: () => void; __acbFiles: Record<string, string>; __acbFileChange: (p: string) => void }
    w.__acbDuringBackup = () => { w.__acbFiles[path] += '\n\nAI がもう一度直しました。'; w.__acbFileChange(path) }
  }, FILE)
  await compare(page).getByRole('button', { name: '届いた版を採用' }).click()
  await expect(compare(page)).toContainText('比べている間に、ファイルがまた変わりました。')
  await expect(compare(page)).toContainText('AI がもう一度直しました。')
  await expect(page.getByText('届いた版にしました。', { exact: false })).toHaveCount(0)
  await banner(page).getByRole('button', { name: '比べるのをやめる' }).click()
  await expect(editor(page)).toContainText('私の追記')
})

test('⌘S on a file changed elsewhere opens the compare view instead of overwriting', async ({ page }) => {
  await openWithEdits(page)
  await page.evaluate(path => { const f = (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles; f[path] += '\n\nAI が追記した段落です。' }, FILE)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(compare(page)).toBeVisible()
  await expect(anyDialog(page)).toHaveCount(0)
  expect(await disk(page)).not.toContain('私の追記')
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
