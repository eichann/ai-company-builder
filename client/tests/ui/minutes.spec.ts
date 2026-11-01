// 「商談のあと」 on screen (milestone 4 G9, .claude/rules/minutes.md "The app"): the
// notice above the real ChatPanel (tests/chat-header-ui.tsx ?minutes=1). The
// checker, the first message's wording and the card's data are pinned in
// tests/minutes-app.test.ts; this pins how the pieces are wired together.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Control = {
  requests: Array<{ path: string; body: Record<string, unknown> | null }>
  open(): boolean
  send(chunk: unknown): void
  finish(): void
  minutesLinks: Array<[string, string, string]>
}
const chat = async <T>(page: Page, fn: (control: Control) => T) =>
  (await page.evaluateHandle(() => (window as unknown as { __acbChat: Control }).__acbChat)).evaluate(fn)

const MINUTES_ID = 'minutes-0a1b2c3d4e5f60718293a4b5'
const day = () => { const d = new Date('2026-11-05T06:00:00.000Z'); return `${d.getMonth() + 1}/${d.getDate()}` }

test('「読み取る」 starts a consultation 「<件名> のあと」 linked to the minutes, and the deal choice links the chosen deal', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', minutes: '1' })
  const notices = page.getByRole('region', { name: '議事録のお知らせ' })
  await expect(notices).toContainText(`議事録が届きました：A社 商談 ${day()}`)
  await expect(page.locator('.cm-content[role="textbox"]').locator('visible=true')).toBeVisible()

  await notices.getByRole('button', { name: '読み取る' }).click()
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length)).toBe(1)
  // The member's first message names the minutes by id; the conversation is stored with it and its title.
  const saved = await chat(page, c => c.requests.find(r => r.path === 'flushChatSession')?.body)
  expect(saved?.minutesId).toBe(MINUTES_ID)
  expect(saved?.title).toBe(`A社 商談 のあと（${day()}）`)
  expect(JSON.stringify(saved?.messages)).toContain(`minutes_read で議事録 ${MINUTES_ID}`)
  await expect(page.getByText(`A社 商談 のあと（${day()}）`).first()).toBeVisible()

  // The minutes tool found two candidate deals: the app's card, in the reply.
  await expect.poll(() => chat(page, c => c.open())).toBe(true)
  await chat(page, c => c.send({ type: 'data-minutes-deal-choice', id: 'minutes-deal-card-1', data: {
    id: 'card-1', companyId: 'preview-company', minutesId: 'minutes-0a1b2c3d4e5f60718293a4b5', meetingTitle: 'A社 商談',
    candidates: [{ id: 'deal-aaaaaa01', title: '研修導入' }, { id: 'deal-bbbbbb02', title: '追加導入' }],
  } }))
  const card = page.getByRole('group', { name: 'どの案件の議事録ですか？' })
  await expect(card).toBeVisible()
  await card.getByRole('radio', { name: '追加導入' }).check()
  await card.getByRole('button', { name: 'この案件にする' }).click()
  await expect(card.getByRole('status')).toContainText('「追加導入」につなぎました')
  expect(await chat(page, c => c.minutesLinks)).toEqual([['preview-company', MINUTES_ID, 'deal-bbbbbb02']])
  await chat(page, c => c.finish())
})

test('with Codex, 「読み取る」 says it is done in a Claude Code consultation and starts nothing', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', minutes: '1', agent: 'codex' })
  await expect(page.locator('.cm-content[role="textbox"]').locator('visible=true')).toBeVisible()
  await page.getByRole('region', { name: '議事録のお知らせ' }).getByRole('button', { name: '読み取る' }).click()
  await expect(page.getByRole('alert')).toContainText('議事録の読み取りは Claude Code の相談でできます')
  await page.waitForTimeout(300)
  expect(await chat(page, c => c.requests.filter(r => r.path === '/api/chat').length)).toBe(0)
})
