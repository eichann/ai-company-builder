// The company selector (tests/company-selector-ui.tsx): choosing a company,
// creating one, and setting its folder up — the department picker before a
// first download, refusals that leave the folder alone, the setup screen and
// the company that opens. Which folder gets which setup is pinned by
// company-folder.test.ts; this pins what the member sees and what is sent.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Control = { calls: unknown[][]; progress: (bytes: number) => void; finishSetup: () => void; listening: number }
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.calls)
const callsOf = async (page: Page, name: string) => (await calls(page)).filter(call => call[0] === name)
const opened = (page: Page) => page.getByRole('status', { name: '開いた会社' })
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name })

async function open(page: Page, query: Record<string, string> = {}) {
  const state = await openPreview(page, 'company-selector', query)
  await expect(page.getByRole('heading', { name: '会社を選択' })).toBeVisible()
  return state
}

async function chooseCompany(page: Page, name = '阿部商店') {
  await button(page, new RegExp(name)).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

test('the list shows the member\'s companies with their role; signing out goes through the auth store', async ({ page }) => {
  const state = await open(page)
  await expect(button(page, /阿部商店\s*オーナー/)).toBeVisible()
  await expect(button(page, /山田工務店\s*メンバー/)).toBeVisible()
  await button(page, 'ログアウト').click()
  await expect.poll(() => callsOf(page, 'signOut')).toHaveLength(1)
  expectNoPageErrors(state)
})

test('no companies says so; a failed list load shows why', async ({ page }) => {
  await open(page, { companies: 'empty' })
  await expect(page.getByText('まだ会社がありません。新しく作成してください。')).toBeVisible()
  await open(page, { companies: 'error' })
  await expect(page.getByText('会社の一覧を読めませんでした')).toBeVisible()
})

test('someone the server does not let create a company is not offered it, and is told to open their invitation link', async ({ page }) => {
  await open(page, { create: 'no' })
  await expect(button(page, /阿部商店/)).toBeVisible()
  await expect(button(page, /新しい会社を作成/)).toHaveCount(0)
  await open(page, { create: 'no', companies: 'empty' })
  await expect(page.getByText(/まだ会社に参加していません。会社に参加するには、届いた招待リンクを開いてください。/)).toBeVisible()
  await expect(button(page, /新しい会社を作成/)).toHaveCount(0)
  // An operator (or the first account of a fresh server) is.
  await open(page, { create: 'yes' })
  await expect(button(page, /新しい会社を作成/)).toBeVisible()
})

test('creating a company sends the trimmed name and goes on to its folder choice; a failure stays on the form', async ({ page }) => {
  await open(page)
  await button(page, /新しい会社を作成/).click()
  const create = button(page, '作成')
  await expect(create).toBeDisabled()
  const name = page.getByPlaceholder('例: 株式会社サンプル')
  await expect(name).toBeFocused()
  await name.fill('失敗')
  await create.click()
  await expect(page.getByText('作成できませんでした')).toBeVisible()
  await expect(page.getByRole('heading', { name: '新しい会社を作成' })).toBeVisible()
  await name.fill('  新会社  ')
  await create.click()
  await expect(page.getByRole('heading', { name: '新会社' })).toBeVisible()
  await expect(page.getByText('作業フォルダを選択してください')).toBeVisible()
  expect(await callsOf(page, 'createCompany')).toEqual([['createCompany', '失敗'], ['createCompany', '新会社']])
})

test('an empty folder asks for departments first and downloads only the picked ones, then opens the company', async ({ page }) => {
  const state = await open(page)
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await expect(page.getByRole('heading', { name: '所属する部署を選択' })).toBeVisible()
  // Nested folders are not offered: only root folders are departments.
  await expect(button(page, /入れ子/)).toHaveCount(0)
  await expect(button(page, 'すべての部署をダウンロード')).toBeVisible()
  const dev = button(page, /開発/)
  await dev.click()
  await expect(dev).toHaveAttribute('aria-pressed', 'true')
  await button(page, /営業部/).click()
  await button(page, /営業部/).click()
  await expect(button(page, /営業部/)).toHaveAttribute('aria-pressed', 'false')
  await button(page, '選んだ部署をダウンロード（1）').click()
  await expect(opened(page)).toContainText('"rootPath":"/Users/demo/作業"')
  // Template folder ids, AGENT.md, and no '_' / '.' / file entries as departments.
  await expect(opened(page)).toContainText('"departments":["dev:development:agent","営業部:営業部:-"]')
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([['gitInspectCompanyFolder', '/Users/demo/作業', 'c1']])
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', '/Users/demo/作業', 'c1', ['development']]])
  expectNoPageErrors(state)
})

test('picking no department downloads everything', async ({ page }) => {
  await open(page)
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await button(page, 'すべての部署をダウンロード').click()
  await expect(opened(page)).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', '/Users/demo/作業', 'c1', null]])
})

test('新しく作成 sets up <chosen folder>/<company>, and the picker\'s 戻る returns to that screen', async ({ page }) => {
  await open(page)
  await chooseCompany(page)
  await button(page, /新しく作成/).click()
  await expect(page.getByRole('heading', { name: '作業フォルダを設定' })).toBeVisible()
  await expect(button(page, /開始/)).toBeDisabled()
  await button(page, /フォルダを選択/).click()
  await expect(page.getByText('/Users/demo/作業/阿部商店')).toBeVisible()
  await button(page, /開始/).click()
  await expect(page.getByRole('heading', { name: '所属する部署を選択' })).toBeVisible()
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([['gitInspectCompanyFolder', '/Users/demo/作業/阿部商店', 'c1']])
  await button(page, '戻る').click()
  await expect(page.getByRole('heading', { name: '作業フォルダを設定' })).toBeVisible()
})

test('a refused or unreachable folder shows why on the screen it was chosen from and sets nothing up', async ({ page }) => {
  await open(page, { folder: 'refuse' })
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await expect(page.getByText('別の会社のフォルダです。')).toBeVisible()
  await expect(page.getByRole('heading', { name: '阿部商店' })).toBeVisible()

  await open(page, { folder: 'offline' })
  await chooseCompany(page)
  await button(page, /新しく作成/).click()
  await button(page, /フォルダを選択/).click()
  await button(page, /開始/).click()
  await expect(page.getByText('オフラインです')).toBeVisible()
  await expect(page.getByRole('heading', { name: '作業フォルダを設定' })).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  expect(await callsOf(page, 'createDirectory')).toEqual([])
})

test('a folder refused for 既存のフォルダを開く is not taken as 新しく作成\'s parent folder', async ({ page }) => {
  await open(page, { folder: 'refuse' })
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await expect(page.getByText('別の会社のフォルダです。')).toBeVisible()
  await button(page, /新しく作成/).click()
  await expect(page.getByRole('heading', { name: '作業フォルダを設定' })).toBeVisible()
  await expect(button(page, /フォルダを選択済み/)).toHaveCount(0)
  await expect(page.getByText('作成されるフォルダ:')).toHaveCount(0)
  await expect(button(page, /開始/)).toBeDisabled()
})

test('a cancelled folder dialog changes nothing', async ({ page }) => {
  await open(page, { pick: 'cancel' })
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await expect.poll(() => callsOf(page, 'selectDirectory')).toHaveLength(1)
  await expect(page.getByRole('heading', { name: '阿部商店' })).toBeVisible()
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([])
})

test('a first download shows the bytes received, then opens the company', async ({ page }) => {
  await open(page, { setup: 'manual' })
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await button(page, 'すべての部署をダウンロード').click()
  await expect(page.getByRole('heading', { name: 'セットアップ中...' })).toBeVisible()
  await expect(page.getByText('初回のみ。会社のファイルが多いと、ダウンロードに数分かかることがあります')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.listening)).toBe(1)
  await page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.progress(5 * 1024 * 1024))
  await expect(page.getByText(/ダウンロード中… 5(\.0)? MB 受信/)).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.finishSetup())
  await expect(page.getByRole('heading', { name: 'セットアップ完了' })).toBeVisible()
  await expect(opened(page)).toBeVisible()
})

test('reopening a clone of this company is not called a first setup and skips the picker', async ({ page }) => {
  await open(page, { folder: 'clone', setup: 'manual' })
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await expect(page.getByRole('heading', { name: 'フォルダを開いています...' })).toBeVisible()
  await expect(page.getByText('サーバーの最新の内容を確認しています')).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.finishSetup())
  await expect(page.getByRole('heading', { name: '準備完了' })).toBeVisible()
  await expect(opened(page)).toBeVisible()
  expect(await callsOf(page, 'getDepartments')).toEqual([])
})

test('a failed first download says why and does not open an empty company; 戻る returns to the folder choice', async ({ page }) => {
  await open(page, { setup: 'fail' })
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await button(page, 'すべての部署をダウンロード').click()
  await expect(page.getByText('ダウンロードが途中で止まりました')).toBeVisible()
  await button(page, '戻る').click()
  await expect(page.getByText('作業フォルダを選択してください')).toBeVisible()
  await expect(opened(page)).toHaveCount(0)
  expect(await callsOf(page, 'readDirectory')).toEqual([])
})

test('the owner\'s first upload continues when the setup call fails (the next sync retries)', async ({ page }) => {
  await open(page, { folder: 'upload', setup: 'fail' })
  await chooseCompany(page)
  await button(page, /既存のフォルダを開く/).click()
  await expect(opened(page)).toBeVisible()
})

test('one company and 所属: it opens by itself in the default folder and downloads only the member\'s departments', async ({ page }) => {
  const state = await openPreview(page, 'company-selector', { companies: 'one', mine: 'd2' })
  await expect(opened(page)).toContainText('"rootPath":"/Users/demo/AI Company Builder/阿部商店"')
  await expect(page.getByRole('heading', { name: '会社を選択' })).toHaveCount(0)
  expect(await callsOf(page, 'selectDirectory')).toEqual([])
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', '/Users/demo/AI Company Builder/阿部商店', 'c1', ['development']]])
  expectNoPageErrors(state)
})

test('one company without 所属: the member is asked which departments (never everything by default)', async ({ page }) => {
  await openPreview(page, 'company-selector', { companies: 'one' })
  await expect(page.getByRole('heading', { name: '所属する部署を選択' })).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
})

test('one company whose default folder is refused: the folder choice says why, nothing is set up', async ({ page }) => {
  await openPreview(page, 'company-selector', { companies: 'one', folder: 'refuse', mine: 'd1' })
  await expect(page.getByText('別の会社のフォルダです。')).toBeVisible()
  await expect(button(page, /既存のフォルダを開く/)).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
})

test('several companies: the list is shown, and a first setup still uses 所属 when there is one', async ({ page }) => {
  await open(page, { mine: 'd1' })
  await chooseCompany(page)
  // The backup note is only for a company without the shared folder.
  await expect(button(page, /既存のフォルダを開く/)).toBeVisible()
  await expect(page.getByText(/PC のバックアップ機能/)).toHaveCount(0)
  await button(page, /既存のフォルダを開く/).click()
  await expect(opened(page)).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', '/Users/demo/作業', 'c1', ['営業部']]])
})

test('a company without the shared folder opens in the chosen folder as it is: a note, no department picker, nothing inspected or downloaded', async ({ page }) => {
  const state = await open(page, { kind: 'none' })
  await chooseCompany(page)
  await expect(page.getByText('この会社では、ファイルはこの PC の中だけに置かれます（ほかの人には共有されません）。')).toBeVisible()
  // Nothing in the working folder is kept on the server: the member is told to back it up (records are kept).
  await expect(page.getByText('作業フォルダのファイルはこの PC の中だけにあり、サーバーには残りません。PC のバックアップ機能で守ってください。やること・決めたことなどの記録はサーバーに残ります。')).toBeVisible()
  await button(page, /既存のフォルダを開く/).click()
  await expect(opened(page)).toContainText('"rootPath":"/Users/demo/作業","folderKind":"none"')
  expect(await callsOf(page, 'openWorkingFolder')).toEqual([['openWorkingFolder', '/Users/demo/作業', 'c1']])
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([])
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  expectNoPageErrors(state)
})

test('the only company without the shared folder opens by itself in the default place; a refused folder stays on the choice with the reason', async ({ page }) => {
  await openPreview(page, 'company-selector', { companies: 'one', kind: 'none' })
  await expect(opened(page)).toContainText('"rootPath":"/Users/demo/AI Company Builder/阿部商店","folderKind":"none"')
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([])
  await openPreview(page, 'company-selector', { companies: 'one', kind: 'none', working: 'fail' })
  await expect(page.getByText('このフォルダは使えません。')).toBeVisible()
  await expect(opened(page)).toHaveCount(0)
})

test('switched to from the title bar: the selector starts at that company\'s folder choice, nothing is opened by itself', async ({ page }) => {
  const state = await openPreview(page, 'company-selector', { choose: 'c2' })
  await expect(page.getByRole('heading', { name: '山田工務店' })).toBeVisible()
  await expect(page.getByText('作業フォルダを選択してください')).toBeVisible()
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([])
  await button(page, '戻る').click()
  await expect(page.getByRole('heading', { name: '会社を選択' })).toBeVisible()
  expectNoPageErrors(state)
})
