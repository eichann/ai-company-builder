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
  aiTurns: { claims: Array<[string, string, number, string]>; settled: string[]; retried: string[]; order: string[]; deleted: string[] }
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
  // The hidden consultation never ran: its empty stored copy is deleted (none pile up).
  const conversation = (await chat(page, c => c.aiTurns.claims))[0][3]
  await expect.poll(() => chat(page, c => c.aiTurns.deleted), { timeout: 10_000 }).toContain(conversation)
})

// Staging 2026-11-11: a job's place not synced yet was given back four times in nine seconds, which used up the
// starts of the pass; the real claim came ten minutes later. A claim not won is no start and waits before it is asked again.
test('a claim answered 「not yet」 waits before it is asked again, and its empty consultation is deleted', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'later' })
  await expect.poll(() => chat(page, c => c.aiTurns.claims.length), { timeout: 15_000 }).toBe(1)
  await page.waitForTimeout(9_000)
  expect(await chat(page, c => c.aiTurns.claims.length)).toBe(1)
  const conversation = (await chat(page, c => c.aiTurns.claims))[0][3]
  expect(await chat(page, c => c.aiTurns.deleted)).toContain(conversation)
  expect(await chat(page, c => c.requests.filter(r => r.path === '/api/chat').length)).toBe(0)
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

// Codex review of #674: what the member keeps outside the input is theirs too. Each scenario runs in
// a failed automatic consultation shown in front, beside another consultation with a note (so it is
// never the pane's last tab), then the record is ended.
const composerOf = (page: Page) => page.locator('.cm-content[role="textbox"]').locator('visible=true')
async function failedAutomaticShown(page: Page) {
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(1)
  await chat(page, c => c.finish())
  await expect.poll(() => chat(page, c => c.aiTurns.settled), { timeout: 15_000 }).toEqual([MINUTES_ID])
  await conversationList(page).getByRole('button', { name: 'AIに相談する' }).click()
  await composerOf(page).click()
  await page.keyboard.type('ほかの相談のメモ')
  const row = conversationList(page).getByText(`A社 商談 のあと（${day()}）`)
  await row.click()
  await expect(page.getByText('自動で始めた相談').locator('visible=true')).toBeVisible()
  return row
}
async function endRecordAndExpectKept(page: Page, row: ReturnType<Page['getByText']>) {
  await closeRecordConsultations(page, MINUTES_ID)
  await page.waitForTimeout(300)
  await expect(row).toHaveCount(1)
}
async function dropOnComposer(page: Page, record: { id: string; title: string }) {
  const data = await page.evaluateHandle(r => {
    const dt = new DataTransfer()
    dt.setData('application/x-acb-record', JSON.stringify(r))
    dt.setData('text/plain', r.title)
    return dt
  }, record)
  await composerOf(page).locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]').dispatchEvent('drop', { dataTransfer: data })
}

test('ending the record keeps an automatic consultation with an edit of its message open, and after the edit is sent', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'fail' })
  const row = await failedAutomaticShown(page)
  const bubble = page.getByText('自動で始めた相談').locator('visible=true').locator('xpath=ancestor::div[contains(@class, "group")][1]')
  await bubble.hover()
  await bubble.getByTitle('編集').click()
  const edit = page.locator('textarea').locator('visible=true')
  await edit.press('End')
  await edit.pressSequentially('（先方の名前も）')
  await endRecordAndExpectKept(page, row)

  // Sent: the rewritten message is the member's, not the app's.
  await edit.press('Meta+Enter')
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(2)
  await chat(page, c => c.finish())
  await expect(page.locator('textarea').locator('visible=true')).toHaveCount(0)
  await endRecordAndExpectKept(page, row)
})

test('ending the record keeps an automatic consultation whose message is still being prepared (an image being read)', async ({ page }) => {
  // The image's reader answers only when the test says so.
  await page.addInitScript(() => {
    const read = FileReader.prototype.readAsDataURL
    const w = window as unknown as { __releaseImages?: () => void }
    const waiting: Array<() => void> = []
    w.__releaseImages = () => { for (const go of waiting.splice(0)) go() }
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) { waiting.push(() => read.call(this, blob)) }
  })
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'fail' })
  const row = await failedAutomaticShown(page)
  await composerOf(page).click()
  await page.keyboard.insertText('この画像も見て')
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'screen.png', { type: 'image/png' }))
    return dt
  })
  await composerOf(page).locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]').dispatchEvent('drop', { dataTransfer: data })
  await page.keyboard.press('Meta+Enter')
  // The composer is empty already; nothing has gone out yet.
  await expect(composerOf(page)).not.toContainText('この画像も見て')
  expect(await chat(page, c => c.requests.filter(r => r.path === '/api/chat').length)).toBe(1)
  await endRecordAndExpectKept(page, row)
  await page.evaluate(() => (window as unknown as { __releaseImages: () => void }).__releaseImages())
  await expect.poll(() => chat(page, c => c.requests.filter(r => r.path === '/api/chat').length), { timeout: 15_000 }).toBe(2)
})

test('a send still reading its image goes no further once the member closed its consultation', async ({ page }) => {
  await page.addInitScript(() => {
    const read = FileReader.prototype.readAsDataURL
    const w = window as unknown as { __releaseImages?: () => void }
    const waiting: Array<() => void> = []
    w.__releaseImages = () => { for (const go of waiting.splice(0)) go() }
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) { waiting.push(() => read.call(this, blob)) }
  })
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'fail' })
  const row = await failedAutomaticShown(page)
  await composerOf(page).click()
  await page.keyboard.insertText('この画像も見て')
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'screen.png', { type: 'image/png' }))
    return dt
  })
  await composerOf(page).locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]').dispatchEvent('drop', { dataTransfer: data })
  await page.keyboard.press('Meta+Enter')
  const item = conversationList(page).locator('[data-conversation-id]').filter({ hasText: `A社 商談 のあと（${day()}）` })
  await item.hover()
  await item.getByRole('button', { name: '相談を閉じる（履歴は残ります）' }).click()
  await expect(row).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { __releaseImages: () => void }).__releaseImages())
  await page.waitForTimeout(1_000)
  expect(await chat(page, c => c.requests.filter(r => r.path === '/api/chat').length)).toBe(1)
})

test('ending the record keeps an automatic consultation with a record waiting in its input, or a topic question open', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', autoturn: 'fail' })
  const row = await failedAutomaticShown(page)
  await dropOnComposer(page, { id: 'task-0000aa', title: '見積書を作り直す' })
  await expect(page.getByRole('button', { name: '見積書を作り直すを渡すのをやめる' })).toBeVisible()
  await endRecordAndExpectKept(page, row)

  // Another record dropped asks about the topic; with both taken off, the question alone keeps it.
  await dropOnComposer(page, { id: 'deal-0000bb', title: 'A社 案件' })
  await expect(page.getByRole('button', { name: '切り替える' })).toBeVisible()
  await page.getByRole('button', { name: '見積書を作り直すを渡すのをやめる' }).click()
  await page.getByRole('button', { name: 'A社 案件を渡すのをやめる' }).click()
  await expect(page.getByRole('button', { name: /を渡すのをやめる$/ })).toHaveCount(0)
  await endRecordAndExpectKept(page, row)

  // Answered: nothing of the member's is left there, so ending the record closes it.
  await page.getByRole('button', { name: 'このまま' }).click()
  await closeRecordConsultations(page, MINUTES_ID)
  await expect(row).toHaveCount(0)
})
