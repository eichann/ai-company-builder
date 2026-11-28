// The screens before sign-in (tests/sign-in-ui.tsx), UX review 20: the app waits for the
// invitation's 「アプリを開く」, an offered address is shown on the sign-in form and ［ログイン］
// connects to it — only to the address on screen — then signs in. Main's own guards are
// app-link.test.ts; this pins what the member sees and what the screen sends.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Control = { calls: unknown[][]; offer: (server: string | null) => void }
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __acbSignIn: Control }).__acbSignIn.calls)
const callsOf = async (page: Page, name: string) => (await calls(page)).filter(call => call[0] === name)
const signInWith = async (page: Page) => {
  await page.getByLabel('メールアドレス').fill('yamada@example.com')
  await page.getByLabel('パスワード').fill('secret-pw')
  await page.getByRole('button', { name: 'ログイン' }).click()
}

test('with no server, the first screen waits for the invitation; typing the address is the side path', async ({ page }) => {
  const state = await openPreview(page, 'sign-in', { screen: 'server' })
  await expect(page.getByRole('heading', { name: 'AI Company Builder へようこそ' })).toBeVisible()
  await expect(page.getByText('メールのページで［アプリを開く］を押します')).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('招待のリンクを待っています')
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: '招待のメールが見当たらないとき' }).click()
  await page.getByLabel('会社のアドレス').fill('acb.example.com/')
  await page.getByRole('button', { name: '次へ' }).click()
  await expect.poll(() => callsOf(page, 'complete')).toHaveLength(1)
  expect(await callsOf(page, 'validateServerUrl')).toEqual([['validateServerUrl', 'https://acb.example.com']])
  expect(await callsOf(page, 'setServerUrl')).toEqual([['setServerUrl', 'https://acb.example.com']])
  expectNoPageErrors(state)
})

test('a link clicked while the app waits shows its host on the sign-in form; nothing is sent before ログイン', async ({ page }) => {
  await openPreview(page, 'sign-in', { screen: 'server' })
  await page.evaluate(() => (window as unknown as { __acbSignIn: Control }).__acbSignIn.offer('https://midori.example.com'))
  await expect(page.getByRole('heading', { name: 'ログインして参加' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'つなぎ先' })).toContainText('midori.example.com')
  expect(await callsOf(page, 'acceptAppLinkServer')).toEqual([])
  expect(await callsOf(page, 'signIn')).toEqual([])
})

test('ログイン on an offered address connects to the address on screen first, then signs in', async ({ page }) => {
  const state = await openPreview(page, 'sign-in', { screen: 'offer', accept: 'ok', signin: 'ok' })
  await expect(page.getByRole('region', { name: 'つなぎ先' })).toContainText('acb.example.com')
  await signInWith(page)
  await expect.poll(() => callsOf(page, 'complete')).toHaveLength(1)
  const order = (await calls(page)).map(call => call[0]).filter(name => name === 'acceptAppLinkServer' || name === 'signIn')
  expect(order).toEqual(['acceptAppLinkServer', 'signIn'])
  expect(await callsOf(page, 'acceptAppLinkServer')).toEqual([['acceptAppLinkServer', 'https://acb.example.com']])
  expectNoPageErrors(state)
})

test('an address that cannot be connected to sends no password', async ({ page }) => {
  await openPreview(page, 'sign-in', { screen: 'offer' })
  await signInWith(page)
  await expect(page.getByRole('alert')).toHaveText('つなげませんでした。')
  expect(await callsOf(page, 'signIn')).toEqual([])
})

test('a newer link replacing the address after the screen showed it: the old address is refused and no password is sent', async ({ page }) => {
  // A fixed clock, paused before the screen's next look (every 1.5 s): the link changes between that look and the press.
  await page.clock.install({ time: new Date('2026-11-29T09:00:00+09:00') })
  await openPreview(page, 'sign-in', { screen: 'offer', accept: 'ok', signin: 'ok' })
  await expect(page.getByRole('region', { name: 'つなぎ先' })).toContainText('acb.example.com')
  await page.clock.pauseAt(new Date('2026-11-29T09:00:01+09:00'))
  await page.evaluate(() => (window as unknown as { __acbSignIn: Control }).__acbSignIn.offer('https://other.example.com'))
  await signInWith(page)
  await expect(page.getByRole('alert')).toHaveText('招待のリンクが新しくなりました。')
  expect(await callsOf(page, 'acceptAppLinkServer')).toEqual([['acceptAppLinkServer', 'https://acb.example.com']])
  expect(await callsOf(page, 'signIn')).toEqual([])
})

test('an address typed before a link came, whose check ends after ログイン on the link: not saved, the password goes only to the address on screen', async ({ page }) => {
  const state = await openPreview(page, 'sign-in', { screen: 'server', accept: 'ok', validate: 'hold' })
  await page.getByRole('button', { name: '招待のメールが見当たらないとき' }).click()
  await page.getByLabel('会社のアドレス').fill('typed.example.com')
  await page.getByRole('button', { name: '次へ' }).click()
  await expect.poll(() => callsOf(page, 'validateServerUrl')).toHaveLength(1)
  // The invitation's link arrives while the typed address is still being checked.
  await page.evaluate(() => (window as unknown as { __acbSignIn: Control }).__acbSignIn.offer('https://invited.example.com'))
  await expect(page.getByRole('region', { name: 'つなぎ先' })).toContainText('invited.example.com')
  await signInWith(page)
  await expect(page.getByRole('alert')).toHaveText('メールアドレスかパスワードが違います')
  // Now the typed address's check answers: what started on the screen that is gone is not applied.
  await page.evaluate(() => (window as unknown as { __acbSignIn: Control & { release: () => void } }).__acbSignIn.release())
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect.poll(() => callsOf(page, 'signIn')).toHaveLength(2)
  expect(await callsOf(page, 'setServerUrl')).toEqual([])
  // Each sign-in names the address on screen, so main can refuse when it is not the saved one.
  expect((await callsOf(page, 'signIn')).map(call => call[2])).toEqual(['https://invited.example.com', 'https://invited.example.com'])
  expect(await callsOf(page, 'passwordSentTo')).toEqual([['passwordSentTo', 'https://invited.example.com'], ['passwordSentTo', 'https://invited.example.com']])
  expect(await callsOf(page, 'complete')).toEqual([])
  expectNoPageErrors(state)
})

test('a wrong password after connecting stays on the same address and retries only the sign-in', async ({ page }) => {
  await openPreview(page, 'sign-in', { screen: 'offer', accept: 'ok' })
  await signInWith(page)
  await expect(page.getByRole('alert')).toHaveText('メールアドレスかパスワードが違います')
  // Connected: つながない is gone, the address stays.
  await expect(page.getByRole('button', { name: 'つながない' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'つなぎ先' })).toContainText('acb.example.com')
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect.poll(() => callsOf(page, 'signIn')).toHaveLength(2)
  expect(await callsOf(page, 'acceptAppLinkServer')).toHaveLength(1)
})

test('つながない forgets the offered address and goes back to waiting', async ({ page }) => {
  await openPreview(page, 'sign-in', { screen: 'offer' })
  await page.getByRole('button', { name: 'つながない' }).click()
  await expect(page.getByRole('heading', { name: 'AI Company Builder へようこそ' })).toBeVisible()
  expect(await callsOf(page, 'dismissAppLinkServer')).toHaveLength(1)
  expect(await callsOf(page, 'acceptAppLinkServer')).toEqual([])
})

test('the login screen of a configured app shows where the password goes', async ({ page }) => {
  await openPreview(page, 'sign-in')
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'つなぎ先' })).toContainText('acb.example.com')
  await expect(page.getByRole('button', { name: 'つながない' })).toHaveCount(0)
  await signInWith(page)
  await expect.poll(() => callsOf(page, 'signIn')).toEqual([['signIn', 'yamada@example.com', 'https://acb.example.com']])
})

test('a newer link while the member types: the new address is said, and what was typed for the old one is cleared', async ({ page }) => {
  await openPreview(page, 'sign-in', { screen: 'offer', accept: 'ok', signin: 'ok' })
  await page.getByLabel('メールアドレス').fill('yamada@example.com')
  await page.getByLabel('パスワード').fill('secret-pw')
  await page.evaluate(() => (window as unknown as { __acbSignIn: Control }).__acbSignIn.offer('https://other.example.com'))
  await expect(page.getByRole('region', { name: 'つなぎ先' })).toContainText('other.example.com')
  await expect(page.getByText(/つなぎ先が変わりました。/)).toBeVisible()
  await expect(page.getByLabel('パスワード')).toHaveValue('')
  expect(await callsOf(page, 'acceptAppLinkServer')).toEqual([])
})
