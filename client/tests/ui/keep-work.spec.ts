// Actions that replace or remove the member's work on their behalf
// (tests/keep-work-ui.tsx): each asks first, says when it failed, and never
// drops what the member typed. Main's side (keeping the current version in
// .backups, refusing a taken name) is pinned by ipc-git / ipc-fs / ipc-app tests.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __acbCalls: unknown[][] }).__acbCalls)
const failNext = (page: Page, name: string) => page.evaluate(n => (window as unknown as { __acbFail: Set<string> }).__acbFail.add(n), name)

async function openSyncPreview(page: Page) {
  await page.getByRole('button', { name: '変更を確認' }).click()
  await expect(page.getByRole('heading', { name: /変更されたファイル/ })).toBeVisible()
}

test('「元に戻す」 asks in the app first, says what happens to the file, and nothing is undone on キャンセル', async ({ page }) => {
  const state = await openPreview(page, 'keep-work', { view: 'preview' })
  await openSyncPreview(page)
  await page.getByRole('button', { name: '元に戻す' }).first().click()
  await expect(page.getByRole('heading', { name: '変更を元に戻しますか？' })).toBeVisible()
  await expect(page.getByText('「新規メモ.md」は追加したファイルです。元に戻すと、このファイルは削除されます。')).toBeVisible()
  await expect(page.getByText('今の内容は .backups に保存します。')).toBeVisible()
  await page.getByRole('button', { name: 'キャンセル' }).click()
  expect(await calls(page)).toEqual([])
  // Enter does not confirm (the member may be typing the memo).
  await page.getByRole('button', { name: '元に戻す' }).first().click()
  await page.keyboard.press('Enter')
  expect(await calls(page)).toEqual([])
  await page.getByRole('button', { name: '元に戻す', exact: true }).last().click()
  await expect.poll(() => calls(page)).toEqual([['gitRevertFile', '営業部/新規メモ.md', 'added']])
  expectNoPageErrors(state)
})

test('a failed 「元に戻す」 says so in the dialog instead of nothing', async ({ page }) => {
  await openPreview(page, 'keep-work', { view: 'preview' })
  await openSyncPreview(page)
  await failNext(page, 'gitRevertFile')
  await page.getByRole('button', { name: '元に戻す' }).nth(1).click()
  await expect(page.getByText('「提案書.md」を最後に同期したときの内容に戻します。')).toBeVisible()
  await page.getByRole('button', { name: '元に戻す', exact: true }).last().click()
  await expect(page.getByRole('alert')).toHaveText('元に戻せませんでした。もう一度試してください。')
  await expect(page.getByText('提案書.md')).toBeVisible()
})

test('the 作業メモ survives a failed sync and is cleared only by a successful one', async ({ page }) => {
  await openPreview(page, 'keep-work', { view: 'preview' })
  await openSyncPreview(page)
  await failNext(page, 'gitSync')
  await page.getByPlaceholder('作業メモを入力（空欄ならAIが自動生成）').fill('提案書の価格を更新')
  await page.getByRole('button', { name: 'この内容で同期' }).click()
  await expect(page.getByRole('status', { name: '同期の結果' })).not.toHaveText('')
  await openSyncPreview(page)
  await expect(page.getByPlaceholder('作業メモを入力（空欄ならAIが自動生成）')).toHaveValue('提案書の価格を更新')
  await page.getByRole('button', { name: 'この内容で同期' }).click()
  await expect.poll(() => calls(page)).toEqual([['gitSync', '提案書の価格を更新'], ['gitSync', '提案書の価格を更新']])
  await openSyncPreview(page)
  await expect(page.getByPlaceholder('作業メモを入力（空欄ならAIが自動生成）')).toHaveValue('')
})

test('復元 asks first and says the current content is kept; a failure is shown, not an alert', async ({ page }) => {
  const state = await openPreview(page, 'keep-work', { view: 'backups' })
  await page.getByText('競合').click()
  await page.getByRole('button', { name: '復元' }).click()
  await expect(page.getByRole('heading', { name: 'バックアップから復元しますか？' })).toBeVisible()
  await expect(page.getByText('今の内容は .backups に保存してから置き換えます。')).toBeVisible()
  await page.getByRole('button', { name: 'キャンセル' }).click()
  expect(await calls(page)).toEqual([])

  await page.getByRole('button', { name: '復元' }).click()
  await page.getByRole('button', { name: '復元する' }).click()
  await expect(page.getByRole('status')).toHaveText('「営業部/提案書.md」を復元しました。それまでの内容は .backups に保存しました。')

  await failNext(page, 'backupRestore')
  await page.getByRole('button', { name: '復元', exact: true }).click()
  await page.getByRole('button', { name: '復元する' }).click()
  await expect(page.getByRole('alert')).toHaveText('今の内容を .backups に保存できなかったため、復元しませんでした。何も変更していません。')
  expectNoPageErrors(state)
})

async function wizardTo(page: Page, folder: string) {
  await page.getByRole('button', { name: '新しいスキル' }).click()
  await page.getByPlaceholder('例: 提案書作成').fill('提案書')
  await page.getByPlaceholder('例: 提案書作成').locator('xpath=following::input[1]').fill(folder)
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '次へ' }).click()
  await page.getByRole('button', { name: 'SKILLを作成' }).click()
}

test('a new skill never replaces one with the same folder name, and never marks a shared skill private', async ({ page }) => {
  const state = await openPreview(page, 'keep-work', { view: 'skills' })
  await wizardTo(page, 'proposal')
  await expect(page.getByRole('alert')).toHaveText('フォルダ名「proposal」のスキルはすでにあります。別のフォルダ名にしてください（今あるスキルはそのままです）。')
  expect(await calls(page)).toEqual([])
  await page.getByRole('button', { name: '戻る' }).click()
  await page.getByRole('button', { name: '戻る' }).click()
  await page.getByRole('button', { name: '戻る' }).click()
  await page.getByPlaceholder('例: 提案書作成').locator('xpath=following::input[1]').fill('shared-one')
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '次へ' }).click()
  await page.getByRole('button', { name: 'SKILLを作成' }).click()
  await expect(page.getByRole('alert')).toHaveText('このフォルダ名のスキルはすでに会社で共有されています。別のフォルダ名にしてください。')
  // Refused before any folder or file was made.
  expect((await calls(page)).map(c => c[0])).toEqual(['makeSkillPrivate'])
  expectNoPageErrors(state)
})

test('a new skill with a free name is made private, then created; the wizard closes on success', async ({ page }) => {
  await openPreview(page, 'keep-work', { view: 'skills' })
  await wizardTo(page, 'pricing')
  await expect(page.getByRole('status', { name: '選んだスキル' })).toHaveText('d-sales-営業部-pricing')
  await expect(page.getByRole('heading', { name: '新しいSKILLを作成' })).toHaveCount(0)
  const made = (await calls(page)).map(c => c[0])
  expect(made[0]).toBe('makeSkillPrivate')
  expect(made.at(-1)).toBe('createFile')
})

test('copying onto a folder name that is taken is refused in the modal; nothing is copied', async ({ page }) => {
  await openPreview(page, 'keep-work', { view: 'skills' })
  await page.getByRole('button', { name: 'スキルをコピー' }).click()
  await page.getByRole('button', { name: /面接メモ/ }).click()
  await page.getByPlaceholder('skill-folder-name').fill('proposal')
  await page.getByRole('button', { name: 'コピーして作成' }).click()
  await expect(page.getByRole('alert')).toHaveText('フォルダ名「proposal」のスキルはすでにあります。別のフォルダ名にしてください（今あるスキルはそのままです）。')
  expect((await calls(page)).filter(c => c[0] === 'copyItem')).toEqual([])
})
