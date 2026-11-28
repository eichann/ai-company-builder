// The company selector (tests/company-selector-ui.tsx): choosing a company, creating one, and
// the join screen (「〇〇 に参加します」, UX review 20) — the place decided automatically and
// changed only on request, the departments for this PC, one ［始める］ before anything is set
// up — then the setup screen and the company that opens. Which folder gets which setup is
// pinned by company-folder.test.ts; this pins what the member sees and what is sent.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Control = { calls: unknown[][]; progress: (bytes: number) => void; finishSetup: () => void; listening: number }
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.calls)
const callsOf = async (page: Page, name: string) => (await calls(page)).filter(call => call[0] === name)
const opened = (page: Page) => page.getByRole('status', { name: '開いた会社' })
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name })
const allOption = (page: Page) => page.getByRole('group', { name: 'この PC に置く部署' }).getByRole('button', { name: /^すべての部署/ })
const startButton = (page: Page) => button(page, '始める')
const place = (page: Page) => page.locator('[data-company-place]')
const AUTO = '/Users/demo/AI Company Builder/阿部商店'

async function open(page: Page, query: Record<string, string> = {}) {
  const state = await openPreview(page, 'company-selector', query)
  await expect(page.getByRole('heading', { name: '会社を選択' })).toBeVisible()
  return state
}

async function chooseCompany(page: Page, name = '阿部商店') {
  await button(page, new RegExp(name)).click()
}

const joinHeading = (page: Page, name = '阿部商店') => page.getByRole('heading', { name: `${name} に参加します` })

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
  await open(page, { create: 'yes' })
  await expect(button(page, /新しい会社を作成/)).toBeVisible()
})

test('creating a company sends the trimmed name and goes on to its join screen; a failure stays on the form', async ({ page }) => {
  await open(page, { mine: 'd1' })
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
  await expect(joinHeading(page, '新会社')).toBeVisible()
  expect(await callsOf(page, 'createCompany')).toEqual([['createCompany', '失敗'], ['createCompany', '新会社']])
})

test('the join screen: the company with its server, the 所属 and the automatic place; nothing is set up before 始める', async ({ page }) => {
  const state = await open(page, { mine: 'd1' })
  await chooseCompany(page)
  await expect(joinHeading(page)).toBeVisible()
  await expect(page.getByText('（acb.example.com）')).toBeVisible()
  await expect(page.getByText('あなたの所属の部署です。ほかの部署もあとから置けます')).toBeVisible()
  await expect(place(page)).toHaveText(AUTO)
  await expect(page.getByText('ふつうはこのままで大丈夫です')).toBeVisible()
  // The place was only looked at (read-only) and no folder dialog was shown.
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([['gitInspectCompanyFolder', AUTO, 'c1']])
  expect(await callsOf(page, 'selectDirectory')).toEqual([])
  expect(await callsOf(page, 'createDirectory')).toEqual([])
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  await startButton(page).click()
  await expect(opened(page)).toContainText(`"rootPath":"${AUTO}"`)
  // Template folder ids, AGENT.md, and no '_' / '.' / file entries as departments.
  await expect(opened(page)).toContainText('"departments":["dev:development:agent","営業部:営業部:-"]')
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', AUTO, 'c1', ['営業部']]])
  expectNoPageErrors(state)
})

test('without 所属 the departments are asked first (nothing chosen waits), then confirmed on the join screen', async ({ page }) => {
  await open(page)
  await chooseCompany(page)
  await expect(page.getByRole('heading', { name: 'この PC に置く部署を選ぶ' })).toBeVisible()
  // Nested folders are not offered: only root folders are departments.
  await expect(button(page, /入れ子/)).toHaveCount(0)
  await expect(button(page, '部署を選んでください')).toBeDisabled()
  // 戻る without a choice: ［始める］ waits on the join screen.
  await button(page, '戻る').click()
  await expect(page.getByText('まだ選んでいません')).toBeVisible()
  await expect(startButton(page)).toBeDisabled()
  await button(page, '選ぶ').click()
  const dev = button(page, /開発/)
  await dev.click()
  await expect(dev).toHaveAttribute('aria-pressed', 'true')
  await button(page, '選んだ部署にする（1）').click()
  await expect(joinHeading(page)).toBeVisible()
  await expect(page.getByText('開発', { exact: true })).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  await startButton(page).click()
  await expect(opened(page)).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', AUTO, 'c1', ['development']]])
})

test('「すべての部署」 is chosen on purpose: it downloads everything; changing the 所属 starts from it', async ({ page }) => {
  await open(page, { mine: 'd1' })
  await chooseCompany(page)
  await button(page, '変える').first().click()
  // The picker starts from the 所属.
  await expect(button(page, /営業部/)).toHaveAttribute('aria-pressed', 'true')
  await allOption(page).click()
  await expect(button(page, /営業部/)).toHaveAttribute('aria-pressed', 'false')
  await button(page, 'すべての部署にする').click()
  await expect(page.getByText('すべての部署', { exact: true })).toBeVisible()
  await startButton(page).click()
  await expect(opened(page)).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', AUTO, 'c1', null]])
})

test('the departments cannot be read: said on the join screen, ［始める］ waits, nothing is downloaded (never everything unasked)', async ({ page }) => {
  await open(page, { depts: 'fail' })
  await chooseCompany(page)
  await expect(page.getByRole('alert')).toContainText('部署の一覧を読み込めませんでした。')
  await expect(startButton(page)).toBeDisabled()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
})

test('置き場所を変えたいとき: a new folder inside a picked one, or a folder already on this PC — each checked before use', async ({ page }) => {
  await open(page, { mine: 'd1' })
  await chooseCompany(page)
  await expect(place(page)).toHaveText(AUTO)
  await button(page, '変える').last().click()
  const choices = page.getByRole('group', { name: '置き場所を変えたいとき（任意）' })
  await choices.getByRole('button', { name: '別の場所に作る（フォルダを選ぶ）' }).click()
  await expect(place(page)).toHaveText('/Users/demo/作業/阿部商店')
  await expect(page.getByText('ここに会社のフォルダを作ります')).toBeVisible()
  await button(page, '変える').last().click()
  await choices.getByRole('button', { name: 'この PC にすでにある会社のフォルダを使う' }).click()
  await expect(place(page)).toHaveText('/Users/demo/作業')
  expect((await callsOf(page, 'gitInspectCompanyFolder')).map(call => call[1])).toEqual([AUTO, '/Users/demo/作業/阿部商店', '/Users/demo/作業'])
  // The 所属 chosen before stays.
  await startButton(page).click()
  await expect(opened(page)).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', '/Users/demo/作業', 'c1', ['営業部']]])
})

test('a refused or unreachable place says why on the join screen, offers another place and sets nothing up', async ({ page }) => {
  await open(page, { folder: 'refuse', mine: 'd1' })
  await chooseCompany(page)
  await expect(page.getByRole('alert')).toHaveText('別の会社のフォルダです。 置き場所を変えてください。')
  await expect(page.getByRole('group', { name: '置き場所を変えたいとき（任意）' })).toBeVisible()
  await expect(startButton(page)).toBeDisabled()

  await open(page, { folder: 'offline', mine: 'd1' })
  await chooseCompany(page)
  await expect(page.getByRole('alert')).toContainText('オフラインです')
  await expect(startButton(page)).toBeDisabled()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  expect(await callsOf(page, 'createDirectory')).toEqual([])
})

test('a cancelled folder dialog changes nothing', async ({ page }) => {
  await open(page, { pick: 'cancel', mine: 'd1' })
  await chooseCompany(page)
  await expect(place(page)).toHaveText(AUTO)
  await button(page, '変える').last().click()
  await button(page, '別の場所に作る（フォルダを選ぶ）').click()
  await expect.poll(() => callsOf(page, 'selectDirectory')).toHaveLength(1)
  await expect(place(page)).toHaveText(AUTO)
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toHaveLength(1)
})

test('a first download is said in members\' words and shows the bytes received, then opens the company', async ({ page }) => {
  await open(page, { setup: 'manual', mine: 'd1' })
  await chooseCompany(page)
  await startButton(page).click()
  await expect(page.getByRole('heading', { name: '準備しています' })).toBeVisible()
  await expect(page.getByText('初めてのときだけです。会社のファイルが多いと、数分かかることがあります')).toBeVisible()
  await expect(page.getByText('会社のファイルを受け取っています')).toBeVisible()
  // The builders' words are gone (owner decision 9).
  for (const word of ['セットアップ', 'フォルダ構造', '同期設定']) await expect(page.getByText(word)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.listening)).toBe(1)
  await page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.progress(5 * 1024 * 1024))
  await expect(page.getByText(/5(\.0)? MB 受け取りました/)).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.finishSetup())
  await expect(page.getByRole('heading', { name: '準備ができました' })).toBeVisible()
  await expect(opened(page)).toBeVisible()
})

test('reopening a clone of this company is not called a first setup and asks no departments', async ({ page }) => {
  await open(page, { folder: 'clone', setup: 'manual' })
  await chooseCompany(page)
  await expect(page.getByRole('heading', { name: '阿部商店 を開きます' })).toBeVisible()
  await expect(page.getByText('この PC で前に選んだ部署のまま')).toBeVisible()
  await startButton(page).click()
  await expect(page.getByRole('heading', { name: '会社のフォルダを開いています' })).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbCompany: Control }).__acbCompany.finishSetup())
  await expect(page.getByRole('heading', { name: '準備ができました' })).toBeVisible()
  await expect(opened(page)).toBeVisible()
  expect(await callsOf(page, 'getDepartments')).toEqual([])
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', AUTO, 'c1', null]])
})

test('a failed first download says why and does not open an empty company; 戻る returns to the join screen, checked again', async ({ page }) => {
  await open(page, { setup: 'fail', mine: 'd1' })
  await chooseCompany(page)
  await startButton(page).click()
  await expect(page.getByText('ダウンロードが途中で止まりました')).toBeVisible()
  await button(page, '戻る').click()
  await expect(joinHeading(page)).toBeVisible()
  await expect(opened(page)).toHaveCount(0)
  await expect.poll(() => callsOf(page, 'gitInspectCompanyFolder')).toHaveLength(2)
  expect(await callsOf(page, 'readDirectory')).toEqual([])
})

test('the owner\'s first upload continues when the setup call fails (the next sync retries)', async ({ page }) => {
  await open(page, { folder: 'upload', setup: 'fail' })
  await chooseCompany(page)
  await startButton(page).click()
  await expect(opened(page)).toBeVisible()
})

test('one company and 所属: its join screen shows without the list, and nothing opens until 始める (owner decision 5)', async ({ page }) => {
  const state = await openPreview(page, 'company-selector', { companies: 'one', mine: 'd2' })
  await expect(joinHeading(page)).toBeVisible()
  await expect(page.getByRole('heading', { name: '会社を選択' })).toHaveCount(0)
  await expect(place(page)).toHaveText(AUTO)
  await expect(startButton(page)).toBeEnabled()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  await expect(opened(page)).toHaveCount(0)
  await startButton(page).click()
  await expect(opened(page)).toContainText(`"rootPath":"${AUTO}"`)
  expect(await callsOf(page, 'selectDirectory')).toEqual([])
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([['gitSetupCompanyRemote', AUTO, 'c1', ['development']]])
  expectNoPageErrors(state)
})

test('one company without 所属: the member is asked which departments (never everything by default)', async ({ page }) => {
  await openPreview(page, 'company-selector', { companies: 'one' })
  await expect(page.getByRole('heading', { name: 'この PC に置く部署を選ぶ' })).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
})

test('a company without the shared folder: the notes, no departments, nothing inspected; main checks the place at 始める', async ({ page }) => {
  const state = await open(page, { kind: 'none' })
  await chooseCompany(page)
  await expect(page.getByText('この会社では、ファイルはこの PC の中だけに置かれます（ほかの人には共有されません）。')).toBeVisible()
  await expect(page.getByText('作業フォルダのファイルはこの PC の中だけにあり、サーバーには残りません。PC のバックアップ機能で守ってください。やること・決めたことなどの記録はサーバーに残ります。')).toBeVisible()
  await expect(page.getByText('この PC に置く部署', { exact: true })).toHaveCount(0)
  expect(await callsOf(page, 'openWorkingFolder')).toEqual([])
  await startButton(page).click()
  await expect(opened(page)).toContainText(`"rootPath":"${AUTO}","folderKind":"none"`)
  expect(await callsOf(page, 'openWorkingFolder')).toEqual([['openWorkingFolder', AUTO, 'c1']])
  expect(await callsOf(page, 'gitInspectCompanyFolder')).toEqual([])
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  expectNoPageErrors(state)
})

test('a company without the shared folder whose place main refuses stays on the join screen with the reason', async ({ page }) => {
  await openPreview(page, 'company-selector', { companies: 'one', kind: 'none', working: 'fail' })
  await startButton(page).click()
  await expect(page.getByText('このフォルダは使えません。')).toBeVisible()
  await expect(joinHeading(page)).toBeVisible()
  await expect(opened(page)).toHaveCount(0)
})

test('switched to from the title bar: the selector starts at that company\'s join screen, nothing is opened by itself', async ({ page }) => {
  const state = await openPreview(page, 'company-selector', { choose: 'c2', mine: 'd1' })
  await expect(joinHeading(page, '山田工務店')).toBeVisible()
  expect(await callsOf(page, 'gitSetupCompanyRemote')).toEqual([])
  await button(page, '会社の一覧に戻る').click()
  await expect(page.getByRole('heading', { name: '会社を選択' })).toBeVisible()
  expectNoPageErrors(state)
})
