// The file tree's own behaviour (tests/file-tree-ui.tsx): what a member's
// clicks, keys, menus and drops do to the company folder. The model's refresh
// rules are pinned by fileTreeModel.test.ts; private-folder screens by
// private-folders.spec.ts; not-downloaded folders by download-folders.spec.ts.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const DEPT = '/Users/demo/会社/営業部'

const row = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' })
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __acbCalls: unknown[][] }).__acbCalls)
const tree = (page: Page) => page.locator('main > div').first()

async function open(page: Page) {
  const state = await openPreview(page, 'file-tree')
  await expect(row(page, '提案書')).toBeVisible()
  return state
}

async function nameDialog(page: Page, title: string, value: string) {
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  const input = page.getByRole('textbox')
  await input.fill(value)
  await page.getByRole('button', { name: '作成' }).click()
}

/** An internal drag: dragstart on the source row, drop on the target (HTML5 DnD, one DataTransfer). */
async function drag(page: Page, from: Locator, to: Locator) {
  const data = await page.evaluateHandle(() => new DataTransfer())
  await from.dispatchEvent('dragstart', { dataTransfer: data })
  await to.dispatchEvent('dragover', { dataTransfer: data })
  await to.dispatchEvent('drop', { dataTransfer: data })
  await from.dispatchEvent('dragend', { dataTransfer: data })
}

test('a click on a file opens it; a click on a folder opens and closes it', async ({ page }) => {
  const state = await open(page)
  await row(page, '見積.xlsx').click()
  await expect(page.getByRole('status', { name: '開いているファイル' })).toHaveText(`${DEPT}/提案書/見積.xlsx`)
  await row(page, '提案書').click()
  await expect(row(page, '見積.xlsx')).toHaveCount(0)
  await row(page, '提案書').click()
  await expect(row(page, '見積.xlsx')).toBeVisible()
  expectNoPageErrors(state)
})

test('review sidecars are never listed, their document carries the new-review mark; the eye hides dot files', async ({ page }) => {
  await open(page)
  await expect(page.getByTitle('新しいレビューあり')).toBeVisible()
  await expect(page.getByText(/\.review\./)).toHaveCount(0)

  await expect(row(page, '.settings.json')).toBeVisible()
  await page.getByRole('button', { name: '隠しファイルを非表示' }).click()
  await expect(row(page, '.settings.json')).toHaveCount(0)
  await page.getByRole('button', { name: '隠しファイルを表示' }).click()
  await expect(row(page, '.settings.json')).toBeVisible()
})

test('the header\'s 新規ファイル creates in the open file\'s folder, which shows it at once', async ({ page }) => {
  await open(page)
  await row(page, '10月.md').click()
  await tree(page).getByRole('button', { name: '新規ファイル' }).click()
  await nameDialog(page, '新規ファイル', '11月.md')
  await expect(row(page, '11月.md')).toBeVisible()
  expect(await calls(page)).toEqual([['createFile', `${DEPT}/議事録/11月.md`, '']])
})

test('the menu on a closed folder creates inside it and opens it', async ({ page }) => {
  await open(page)
  await row(page, '議事録').click()
  await expect(row(page, '10月.md')).toHaveCount(0)
  await row(page, '議事録').click({ button: 'right' })
  await page.getByRole('button', { name: '新規ファイル' }).last().click()
  await nameDialog(page, '新規ファイル', 'メモ.md')
  await expect(row(page, 'メモ.md')).toBeVisible()
  await expect(row(page, '10月.md')).toBeVisible()
  expect(await calls(page)).toEqual([['createFile', `${DEPT}/議事録/メモ.md`, '']])
})

test('F2 renames and Del deletes only that item, each after a dialog', async ({ page }) => {
  await open(page)
  await row(page, 'README.md').focus()
  await page.keyboard.press('F2')
  await expect(page.getByRole('textbox')).toHaveValue('README.md')
  await nameDialog(page, '名前を変更', 'はじめに.md')
  await expect(row(page, 'はじめに.md')).toBeVisible()

  await row(page, 'ロゴ.png').focus()
  await page.keyboard.press('Delete')
  await expect(page.getByText('「ロゴ.png」を削除しますか？ この操作は取り消せません。')).toBeVisible()
  await page.getByRole('button', { name: 'キャンセル' }).click()
  expect(await calls(page)).toEqual([['renameItem', `${DEPT}/README.md`, `${DEPT}/はじめに.md`]])

  await row(page, 'ロゴ.png').focus()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: '削除', exact: true }).click()
  await expect(row(page, 'ロゴ.png')).toHaveCount(0)
  expect((await calls(page)).slice(1)).toEqual([['deleteItem', `${DEPT}/ロゴ.png`]])
})

test('⌘-click and shift-click select several; the menu deletes exactly those after a confirm', async ({ page }) => {
  await open(page)
  await row(page, /^2026春\.md/).click()
  // Screen order from 2026春.md: 見積.xlsx, .settings.json, README.md (folders first).
  await row(page, 'README.md').click({ modifiers: ['Shift'] })
  await row(page, '.settings.json').click({ modifiers: ['ControlOrMeta'] })
  await row(page, 'README.md').click({ button: 'right' })
  await page.getByRole('button', { name: '3件を削除' }).click()
  await expect(page.getByText('3件のアイテムを削除しますか？ この操作は取り消せません。')).toBeVisible()
  await page.getByRole('button', { name: '削除', exact: true }).click()
  await expect(row(page, 'README.md')).toHaveCount(0)
  expect((await calls(page)).map(c => c[1]).sort()).toEqual([`${DEPT}/README.md`, `${DEPT}/提案書/2026春.md`, `${DEPT}/提案書/見積.xlsx`].sort())
  await expect(row(page, '議事録')).toBeVisible()
})

test('a name a private folder already uses is refused with the server\'s sentence; nothing is created', async ({ page }) => {
  await open(page)
  await row(page, '提案書').click({ button: 'right' })
  await page.getByRole('button', { name: '新規ファイル' }).last().click()
  await nameDialog(page, '新規ファイル', '人事評価')
  await expect(page.getByText('「人事評価」という名前は使えません。別の名前にしてください。')).toBeVisible()
  expect(await calls(page)).toEqual([])
})

test('a private folder itself cannot be renamed', async ({ page }) => {
  await open(page)
  await row(page, /^機密/).click({ button: 'right' })
  await page.getByRole('button', { name: /^名前を変更/ }).click()
  await expect(page.getByText('非公開フォルダ「機密」そのものは、名前の変更ができません。必要なときは管理者に相談してください。')).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
})

test('dragging a file onto a folder moves it there; onto a private folder it asks first', async ({ page }) => {
  await open(page)
  await drag(page, row(page, '見積.xlsx'), row(page, '議事録'))
  await expect.poll(() => calls(page)).toEqual([['moveItem', `${DEPT}/提案書/見積.xlsx`, `${DEPT}/議事録/見積.xlsx`]])

  await drag(page, row(page, 'README.md'), row(page, /^機密/))
  await expect(page.getByRole('heading', { name: '非公開フォルダへ移動します' })).toBeVisible()
  expect(await calls(page)).toHaveLength(1)
  await page.getByRole('button', { name: '移動する' }).click()
  await expect.poll(() => calls(page)).toEqual([
    ['moveItem', `${DEPT}/提案書/見積.xlsx`, `${DEPT}/議事録/見積.xlsx`],
    ['moveItem', `${DEPT}/README.md`, `${DEPT}/機密/README.md`],
  ])
})

test('files dropped from Finder move in under a free name; other types and files over 20 MB are refused with the reason', async ({ page }) => {
  await open(page)
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], '10月.md'))
    dt.items.add(new File(['x'], 'setup.exe'))
    dt.items.add(new File([new Uint8Array(21 * 1024 * 1024)], '大きい.pdf'))
    return dt
  })
  await row(page, '議事録').dispatchEvent('drop', { dataTransfer: data })
  await expect(page.getByText(/setup\.exe: 非対応の形式\s+大きい\.pdf: 20MBを超えています/)).toBeVisible()
  expect(await calls(page)).toEqual([['moveFromExternal', '/Users/demo/Downloads/10月.md', `${DEPT}/議事録/10月 (1).md`]])
})

test('a new file or a rename onto a name that is taken is refused in the dialog; the file there is untouched', async ({ page }) => {
  await open(page)
  await row(page, 'README.md').click({ button: 'right' })
  await page.getByRole('button', { name: '新規ファイル' }).last().click()
  await nameDialog(page, '新規ファイル', 'README.md')
  const taken = '同じ名前のファイルまたはフォルダがすでにあります。別の名前にしてください。'
  await expect(page.getByRole('alert')).toHaveText(taken)
  // The dialog stays open with the typed name, so the member can change it.
  await expect(page.getByRole('textbox')).toHaveValue('README.md')
  await page.getByRole('button', { name: 'キャンセル' }).click()

  await row(page, 'ロゴ.png').focus()
  await page.keyboard.press('F2')
  await nameDialog(page, '名前を変更', 'README.md')
  await expect(page.getByRole('alert')).toHaveText(taken)
  await page.getByRole('button', { name: 'キャンセル' }).click()
  await expect(row(page, 'ロゴ.png')).toBeVisible()
  await expect(row(page, 'README.md')).toBeVisible()
})

test('a name another computer cannot hold is refused before anything is written', async ({ page }) => {
  await open(page)
  await row(page, 'README.md').click({ button: 'right' })
  await page.getByRole('button', { name: '新規ファイル' }).last().click()
  await nameDialog(page, '新規ファイル', '会議:10月.md')
  await expect(page.getByRole('alert')).toHaveText('名前に < > : " | ? * は使えません（Windows のパソコンで開けなくなります）。')
  await page.getByRole('textbox').fill('a/b.md')
  await page.getByRole('button', { name: '作成' }).click()
  await expect(page.getByRole('alert')).toHaveText('名前に「/」や「\\」は使えません。')
  expect(await calls(page)).toEqual([])
})

test('when some items of a multi-delete fail, the rest are deleted and the failed ones are named and stay selected', async ({ page }) => {
  await open(page)
  await page.evaluate(dept => (window as unknown as { __acbFailDelete: Set<string> }).__acbFailDelete.add(`${dept}/README.md`), DEPT)
  await row(page, 'README.md').click()
  await row(page, 'ロゴ.png').click({ modifiers: ['Shift'] })
  await row(page, 'ロゴ.png').click({ button: 'right' })
  await page.getByRole('button', { name: '2件を削除' }).click()
  await page.getByRole('button', { name: '削除', exact: true }).click()
  await expect(page.getByText('「README.md」を削除できませんでした。ほかのものは削除しました。開いているアプリがあれば閉じてから、もう一度試してください。')).toBeVisible()
  await expect(row(page, 'ロゴ.png')).toHaveCount(0)
  await expect(row(page, 'README.md')).toBeVisible()
  await expect(row(page, 'README.md')).toHaveClass(/bg-accent\/20/) // still selected
})
