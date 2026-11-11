// 「AI の番」 run automatically (ai-turns.md) in the real ChatPanel (tests/chat-header-ui.tsx
// ?autoturn=1): the runner claims the record with a hidden consultation's own id, that
// consultation sends and is saved like a normal one, and the shown tab stays as it was.
// The scheduling rules are pinned in src/features/chat/aiTurns.test.ts, the claim in
// tests/ai-turn-claims.test.ts.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Control = {
  requests: Array<{ path: string; body: Record<string, unknown> | null }>
  open(): boolean
  finish(): void
  aiTurns: { claims: Array<[string, string, number, string]>; settled: string[]; retried: string[]; order: string[] }
}
const chat = async <T>(page: Page, fn: (control: Control) => T) =>
  (await page.evaluateHandle(() => (window as unknown as { __acbChat: Control }).__acbChat)).evaluate(fn)

const conversationList = (page: Page) => page.getByRole('complementary', { name: 'AIへの相談' })
/** The consultations open as tabs (what the chat pane remembers of its tabs). */
const openTabSessions = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('chatTabs:'))
  .flatMap(k => (JSON.parse(localStorage.getItem(k) ?? '{}') as { tabs?: Array<{ sessionId: string | null }> }).tabs ?? []).map(t => t.sessionId))
const closeRecordConsultations = (page: Page, recordId: string) => page.evaluate(id =>
  (window as unknown as { __acbCommands: { run: (cmd: string, args: unknown) => Promise<unknown> } }).__acbCommands.run('chat.closeRecordConsultations', { recordId: id }), recordId)

const MINUTES_ID = 'minutes-0a1b2c3d4e5f60718293a4b5'
const day = () => { const d = new Date('2026-11-05T06:00:00.000Z'); return `${d.getMonth() + 1}/${d.getDate()}` }

test('a received minutes record runs by itself in a hidden consultation that is saved like a normal one', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: '1' })
  const composer = page.locator('.cm-content[role="textbox"]').locator('visible=true')
  await expect(composer).toBeVisible()

  // Nobody pressed anything: the runner claims, then the hidden consultation sends.
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(1)
  const [claim] = await chat(page, c => c.aiTurns.claims)
  expect(claim.slice(0, 3)).toEqual(['preview-company', MINUTES_ID, 1])
  const sent = await chat(page, c => c.requests.find(r => r.path === '/api/chat')?.body)
  // The claim named this very consultation (the record's ledger points at it).
  expect(sent?.appSessionId).toBe(claim[3])
  // Only that step's tools for this unattended request (ai-turns.md); the member's next message is normal.
  expect(sent?.aiTurnStep).toBe('minutes-reading')
  const saved = await chat(page, c => c.requests.find(r => r.path === 'flushChatSession')?.body)
  expect(saved?.id).toBe(claim[3])
  expect(saved?.minutesId).toBe(MINUTES_ID)
  expect(saved?.title).toBe(`A社 商談 のあと（${day()}）`)
  expect(JSON.stringify(saved?.messages)).toContain('自動で始めた相談')
  expect(JSON.stringify(saved?.messages)).toContain(`minutes_read で会議 ${MINUTES_ID} の議事録`)
  // The version the claim left the record at (the unattended run cannot look it up).
  expect(JSON.stringify(saved?.messages)).toContain('会議の version は 2 です')

  // It is listed as working, but the member's own tab stays in front, untouched.
  await expect(page.getByText(`A社 商談 のあと（${day()}）`).first()).toBeVisible()
  await expect(page.getByText('自動で始めた相談').locator('visible=true')).toHaveCount(0)

  // The turn ends: the record is settled once, and nothing starts again for it.
  await chat(page, c => c.finish())
  await expect.poll(() => chat(page, c => c.aiTurns.settled), { timeout: 15_000 }).toEqual([MINUTES_ID])
  // It ended well with nothing of the member's in it: it closes by itself (owner FB #28), saved as it was;
  // the member's own tab stays in front. (This preview's queue never changes, so the record may run again.)
  await expect.poll(() => openTabSessions(page), { timeout: 10_000 }).not.toContain(claim[3])
  await expect(composer).toBeVisible()
})

test('when another PC took the AI turn first, nothing is sent from this one', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'taken' })
  await expect.poll(() => chat(page, c => c.aiTurns.claims.length), { timeout: 15_000 }).toBe(1)
  await page.waitForTimeout(4_000)
  expect(await chat(page, c => c.requests.filter(r => r.path === '/api/chat').length)).toBe(0)
  expect(await chat(page, c => c.aiTurns.claims.length)).toBe(1)
})

test('a meeting that failed on an older build and was asked for again is given back and claimed, without pressing 「もう一度」', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'asked-again' })
  await expect.poll(() => chat(page, c => c.aiTurns.claims.length), { timeout: 15_000 }).toBe(1)
  // The server's run goes first: a claim before it would be refused.
  expect(await chat(page, c => c.aiTurns.retried)).toEqual([MINUTES_ID])
  expect(await chat(page, c => c.aiTurns.order)).toEqual(['retry', 'claim'])
})

test('with Codex nothing is claimed or sent; the record says why and can be handed to the person', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: '1', agent: 'codex' })
  await expect(page.getByRole('status', { name: 'AI の番の自動実行' })).toContainText('Claude Code が必要です', { timeout: 15_000 })
  const notice = page.getByRole('region', { name: 'AI の番' })
  await expect(notice).toContainText('AI では始められません')
  await expect(notice.getByRole('button', { name: 'もう一度' })).toBeVisible()
  await notice.getByRole('button', { name: '人に渡す' }).click()
  await expect(notice).toContainText('あなたにお渡ししました', { timeout: 10_000 })
  await expect(notice).toContainText('Claude Code が必要です')
  expect(await chat(page, c => c.aiTurns.claims.length)).toBe(0)
  expect(await chat(page, c => c.requests.filter(r => r.path === '/api/chat').length)).toBe(0)
})

test('a failed run is handed to the person with the reason, and 「もう一度」 gives it back to the AI', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'fail' })
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(1)
  const notice = page.getByRole('region', { name: 'AI の番' })
  await expect(notice).toContainText('AI が進めています')
  await chat(page, c => c.finish())
  await expect(notice).toContainText('AI ができませんでした', { timeout: 15_000 })
  await expect(notice).toContainText('読み取れませんでした')
  // A failed run's consultation stays open: the reason is there (owner FB #28).
  await expect(conversationList(page).getByText(`A社 商談 のあと（${day()}）`)).toHaveCount(1)
  await notice.getByRole('button', { name: 'もう一度' }).click()
  // The server's run, held for a person after the failure (S10b), is given back too.
  await expect.poll(() => chat(page, c => c.aiTurns.retried), { timeout: 15_000 }).toEqual([MINUTES_ID])
  await expect.poll(() => chat(page, c => c.aiTurns.claims.length), { timeout: 15_000 }).toBe(2)
})

// Owner FB #28: the member ending the record closes its automatic consultations — also one kept open
// after a failure — but never one holding the member's words.
test('ending the record closes its automatic consultation that stayed open; one with the member’s draft stays', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'fail' })
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(1)
  await chat(page, c => c.finish())
  await expect.poll(() => chat(page, c => c.aiTurns.settled), { timeout: 15_000 }).toEqual([MINUTES_ID])
  const row = conversationList(page).getByText(`A社 商談 のあと（${day()}）`)
  await expect(row).toHaveCount(1)

  // The member starts a note in it: ending the record leaves it open.
  await row.click()
  const composer = page.locator('.cm-content[role="textbox"]').locator('visible=true')
  await composer.click()
  await page.keyboard.type('先方に確認する')
  // Opening it put the member's blank tab away, and the last tab is never closed: another one first.
  const newConsultation = conversationList(page).getByRole('button', { name: 'AIに相談する' })
  await newConsultation.click()
  await closeRecordConsultations(page, MINUTES_ID)
  await page.waitForTimeout(300)
  await expect(row).toHaveCount(1)

  // Without the note it closes.
  await row.click()
  await composer.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await newConsultation.click()
  await closeRecordConsultations(page, MINUTES_ID)
  await expect(row).toHaveCount(0)
})

test('ending the record keeps an automatic consultation the member wrote in', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'fail' })
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(1)
  await chat(page, c => c.finish())
  await expect.poll(() => chat(page, c => c.aiTurns.settled), { timeout: 15_000 }).toEqual([MINUTES_ID])
  const row = conversationList(page).getByText(`A社 商談 のあと（${day()}）`)
  await row.click()
  await page.locator('.cm-content[role="textbox"]').locator('visible=true').click()
  await page.keyboard.type('先方の資料を待ちます')
  await page.keyboard.press('Meta+Enter')
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(2)
  await chat(page, c => c.finish())
  await conversationList(page).getByRole('button', { name: 'AIに相談する' }).click()
  await closeRecordConsultations(page, MINUTES_ID)
  await page.waitForTimeout(300)
  await expect(row).toHaveCount(1)
})
