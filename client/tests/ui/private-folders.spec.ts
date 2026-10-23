// Private folders in the file tree and the 「新しいフォルダ…」 dialog
// (tests/private-folders-ui.tsx). Who may create where, default viewers,
// boundary messages and the API mapping are pinned by
// tests/private-folder-ui.test.ts; here: the lock + banner, the dialog's
// controls per role, and how each server answer shows.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

async function createPrivate(page: Page, name: string) {
  await page.getByRole('button', { name: '新しいフォルダ…' }).click()
  const dialog = page.getByRole('dialog', { name: '新しいフォルダ' })
  await dialog.getByRole('textbox', { name: '名前' }).fill(name)
  await dialog.getByRole('radio', { name: '非公開' }).click()
  await dialog.getByRole('button', { name: '非公開フォルダを作成' }).click()
  return dialog
}

test('a private folder carries its lock; inside it a banner names who can see it', async ({ page }) => {
  await openPreview(page, 'private-folders')
  await expect(page.getByRole('button', { name: '評価 非公開（4人だけが見られます）' })).toBeVisible()
  await expect(page.getByRole('note')).toHaveCount(0)

  await openPreview(page, 'private-folders', { select: '人事部/評価/面談メモ.md' })
  await expect(page.getByRole('note', { name: '見られる人（4人）：山田 花子、高橋 美咲、佐藤 健、鈴木 一郎' })).toHaveText('非公開：4人だけが見られます（評価）')
})

test('a member cannot choose 非公開; a manager gets the viewers list with themself and the managers', async ({ page }) => {
  await openPreview(page, 'private-folders', { role: 'member' })
  await page.getByRole('button', { name: '新しいフォルダ…' }).click()
  const dialog = page.getByRole('dialog', { name: '新しいフォルダ' })
  await expect(dialog.getByRole('radio', { name: '非公開' })).toBeDisabled()
  await expect(dialog.getByText('非公開のフォルダは、管理者か部署の責任者が作れます')).toBeVisible()

  await openPreview(page, 'private-folders')
  await page.getByRole('button', { name: '新しいフォルダ…' }).click()
  await page.getByRole('dialog').getByRole('radio', { name: '非公開' }).click()
  await expect(page.getByRole('list', { name: '見られる人' }).getByRole('listitem')).toHaveText([
    /^山田 花子（自分）/, /^高橋 美咲/, /^追加/,
  ])
})

test('creating: success is announced; a taken name and outdated apps keep the dialog open with the server\'s answer', async ({ page }) => {
  await openPreview(page, 'private-folders')
  let dialog = await createPrivate(page, '面談')
  await expect(page.getByText('「面談」を非公開フォルダとして作成しました。同期すると、あなたの手元に届きます。')).toBeVisible()
  await expect(dialog).toHaveCount(0)

  await openPreview(page, 'private-folders', { state: 'taken' })
  dialog = await createPrivate(page, '面談')
  await expect(dialog.getByText('『人事部/面談』というフォルダ名は使えません。別の名前にしてください。')).toBeVisible()

  await openPreview(page, 'private-folders', { state: 'outdated', role: 'admin' })
  dialog = await createPrivate(page, '面談')
  await expect(dialog.getByText('次のメンバーは古いアプリを使っているため、非公開フォルダを扱えません：伊藤 翔。')).toBeVisible()
  await dialog.getByRole('button', { name: 'それでも作成する' }).click()
  await expect(page.getByText('「面談」を非公開フォルダとして作成しました。同期すると、あなたの手元に届きます。')).toBeVisible()
})
