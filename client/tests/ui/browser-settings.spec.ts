// Settings → 「ブラウザ操作」 (tests/download-folders-ui.tsx; agent-browser.md "The app's window"):
// the item exists only while the member has a site, says in one line where the login lives (and why when it is
// the sandbox), and says when 「ログインを消す」 failed. Which sites and when are main's
// (tests/browser-window.test.ts).
import { test, expect } from '@playwright/test'
import { openPreview } from './helpers'

const nav = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: '設定の項目' })

test('without a site the settings have no 「ブラウザ操作」', async ({ page }) => {
  const { errors } = await openPreview(page, 'download-folders', { tab: 'mine' })
  await expect(nav(page).getByRole('button', { name: 'Slack' })).toBeVisible()
  await expect(nav(page).getByRole('button', { name: 'ブラウザ操作' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a site the company allowed: open it; the line says the login lasts until the app closes', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'mine', browser: '1' })
  await nav(page).getByRole('button', { name: 'ブラウザ操作' }).click()
  await expect(page.getByText('manager.example.net', { exact: true })).toBeVisible()
  await expect(page.getByText(/AI はまだこの窓を操作しません/)).toHaveCount(0)
  await expect(page.getByText(/ログインはアプリを閉じるまで覚えています。アプリを開き直すと、もう一度ログインが必要です。/)).toBeVisible()
  await page.getByRole('button', { name: '開いてログイン' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { browserOpened?: string[] }).browserOpened)).toEqual(['manager.example.net'])
  await page.getByRole('button', { name: 'ログインを消す' }).click()
  await expect(page.getByRole('status')).toHaveText('このサイトのログインを消しました。')
})

test('a site whose login is kept on this PC says so (never 「もう一度ログインが必要」)', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'mine', browser: 'kept' })
  await nav(page).getByRole('button', { name: 'ブラウザ操作' }).click()
  await expect(page.getByText(/ログインはこの PC に残ります/)).toBeVisible()
  await expect(page.getByText(/もう一度ログインが必要です/)).toHaveCount(0)
})

test('a site whose login is not kept because the AI sandbox is not 囲う says so plainly', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'mine', browser: 'observe' })
  await nav(page).getByRole('button', { name: 'ブラウザ操作' }).click()
  await expect(page.getByText(/ログインはアプリを閉じるまで覚えています（会社の「AI の囲い」が「囲う」ではないため、この PC には残しません）/)).toBeVisible()
})

test('「ログインを消す」 that could not clear says so (never 「消しました」)', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'browser', browser: 'clearFails' })
  await page.getByRole('button', { name: 'ログインを消す' }).click()
  await expect(page.getByRole('status')).toHaveText('ログインを消せませんでした。もう一度お試しください。')
})

// 「この PC」 (agent-browser.md "This PC's registration"): each state in plain words with what to do next, the
// combinations the member may use, 登録 with the PC's name, and 「やめる」 behind a confirm. What main answers and
// that the key never reaches the screen are main's (tests/browser-device.test.ts).
const pcSection = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'この PC' })

test('この PC, not registered: the sentence, the usable combinations, and 「この PC を登録する」 with the name', async ({ page }) => {
  const { errors } = await openPreview(page, 'download-folders', { tab: 'browser', browser: '1' })
  const pc = pcSection(page)
  await expect(pc.locator('[data-pc-sentence]')).toHaveText('この PC で、AI にブラウザ操作を任せるには、PC の登録が必要です。')
  await expect(pc.getByText('流入経路を点検する（見るだけ）')).toBeVisible()
  await expect(pc.getByText('流入経路を作る（書き込む）')).toBeVisible()
  await pc.getByLabel('PC の名前').fill('営業の MacBook')
  await pc.getByRole('button', { name: 'この PC を登録する' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { pcRegistered?: string }).pcRegistered)).toBe('営業の MacBook')
  await expect(pc.locator('[data-pc-sentence]')).toHaveText(/管理者に「登録しました」と伝えて、使えるようにしてもらってください。/)
  await expect(pc.getByText('確認待ち')).toBeVisible()
  await expect(pc.getByRole('button', { name: '取り下げる' })).toBeVisible()
  expect(errors).toEqual([])
})

test('この PC, enabled: 使える, and 「この PC での利用をやめる」 only after the confirm', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'browser', browser: '1', pc: 'enabled' })
  const pc = pcSection(page)
  await expect(pc.getByText('使える', { exact: true })).toBeVisible()
  await expect(pc.locator('[data-pc-sentence]')).toHaveText('この PC で使えます。')
  await expect(pc.getByText('見本の MacBook')).toBeVisible()
  await pc.getByRole('button', { name: 'この PC での利用をやめる' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('この PC での利用をやめますか？')
  await dialog.getByRole('button', { name: 'やめない' }).click()
  await expect(pc.getByText('使える', { exact: true })).toBeVisible()
  await pc.getByRole('button', { name: 'この PC での利用をやめる' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'この PC での利用をやめる' }).click()
  await expect(pc.getByText('止めた', { exact: true })).toBeVisible()
  await expect(pc.locator('[data-pc-sentence]')).toHaveText('この PC での利用は止まっています。もう一度使うには、登録し直してください。')
  await expect(pc.getByRole('button', { name: '登録し直す' })).toBeVisible()
})

test('この PC: no combination yet says to ask the administrator; a keychain-less PC and no server say so, with nothing to press', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'browser', browser: '1', lines: '0' })
  await expect(pcSection(page).getByText('使える作業はまだありません。管理者に使えるようにしてもらってください。')).toBeVisible()
  await openPreview(page, 'download-folders', { tab: 'browser', browser: '1', pc: 'unavailable' })
  await expect(pcSection(page).getByText('この PC では使えません（安全な保存ができません）。')).toBeVisible()
  await expect(pcSection(page).getByRole('button')).toHaveCount(0)
  await openPreview(page, 'download-folders', { tab: 'browser', browser: '1', pc: 'unknown' })
  await expect(pcSection(page).getByText(/サーバーにつながらないため/)).toBeVisible()
  await expect(pcSection(page).getByRole('button')).toHaveCount(0)
})

test('この PC: a refused registration shows the server\'s sentence and keeps the form', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'browser', browser: '1', pcFail: '1' })
  const pc = pcSection(page)
  await pc.getByRole('button', { name: 'この PC を登録する' }).click()
  await expect(pc.getByRole('alert')).toHaveText(/登録できる PC の数を超えています/)
  await expect(pc.getByRole('button', { name: 'この PC を登録する' })).toBeVisible()
})

// 「記録する」 (agent-browser.md "Recording"): record, stop, check the lines (ページ → 入力した → 押した → 送った), delete what is not
// wanted, send. What is kept and that nothing leaves before ［送る］ are main's (tests/browser-recording-app.test.ts).
const recSection = (page: import('@playwright/test').Page) => page.getByRole('region', { name: '記録する' })

test('記録する: start, stop, delete a line, send — only the lines left are sent', async ({ page }) => {
  const { errors } = await openPreview(page, 'download-folders', { tab: 'browser', browser: '1' })
  const rec = recSection(page)
  await expect(rec.getByText('いつもの作業を、サイトの窓で1回通してやってください。')).toBeVisible()
  await rec.getByRole('button', { name: '記録する：manager.example.net' }).click()
  await expect(rec.getByRole('status')).toHaveText(/manager.example.net を記録しています（3行）/)
  await rec.getByRole('button', { name: '記録を止める' }).click()
  const list = rec.getByRole('list', { name: '送る前に確かめてください' })
  await expect(list.getByRole('listitem')).toHaveCount(4)
  await expect(list.getByText('（推定）手順3のあと')).toBeVisible()
  await expect(rec.getByText(/お客さまなどの名前が入っていることがあります/)).toBeVisible()
  await rec.getByRole('button', { name: '消す 2' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(3)
  // A name hidden everywhere, and another host removed, before sending.
  await rec.getByRole('button', { name: '伏せる tanaka' }).click()
  await expect(rec.getByRole('button', { name: '伏せる tanaka' })).toHaveCount(0)
  await rec.getByRole('button', { name: '消す cdn.example-assets.test' }).click()
  await expect(rec.getByText('cdn.example-assets.test')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { recordingEdits?: unknown[] }).recordingEdits)).toEqual([
    { kind: 'line', id: 2 }, { kind: 'word', word: 'tanaka' }, { kind: 'host', host: 'cdn.example-assets.test' },
  ])
  expect(await page.evaluate(() => (window as unknown as { recordingSent?: number[] }).recordingSent)).toBeUndefined()
  await rec.getByRole('button', { name: '送る' }).click()
  await expect(rec.getByRole('status')).toHaveText('記録を送りました。管理者に「記録を送りました」と伝えてください。')
  expect(await page.evaluate(() => (window as unknown as { recordingSent?: number[] }).recordingSent)).toEqual([1, 3, 4])
  expect(errors).toEqual([])
})
