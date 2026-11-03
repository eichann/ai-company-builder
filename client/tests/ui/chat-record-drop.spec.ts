// Dropping on the consultation's input (owner 2026-11-03 #5, chat-ui-and-history.md "A record dropped
// on the input"): the middle's tabs dragged for real (tests/chat-header-ui.tsx ?tabs=1) onto the real
// ChatPanel. A record makes the consultation about it (asked first when it is about another) and goes to
// the AI with the next message only; a file is read as before. The frame says which, while dragging.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Request = { path: string; body: Record<string, unknown> | null }
type Control = { requests: Request[]; open(): boolean; send(chunk: unknown): void; text(id: string, delta: string): void; finish(): void }

const chat = async <T>(page: Page, fn: (control: Control) => T) =>
  (await page.evaluateHandle(() => (window as unknown as { __acbChat: Control }).__acbChat)).evaluate(fn)
const chatBodies = (page: Page) => chat(page, c => c.requests.filter(r => r.path === '/api/chat').map(r => r.body ?? {}))
const input = (page: Page) => page.locator('.cm-content[role="textbox"]').locator('visible=true')
const tab = (page: Page, name: string | RegExp) => page.locator('[data-middle-tabs]').getByRole('tab', { name })
const frame = (page: Page) => page.locator('[data-drop-frame]')

async function send(page: Page, text: string) {
  await input(page).click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Meta+Enter')
}

/** Drags a tab over the input, checks the frame's words while over it, and drops. */
async function dropOnInput(page: Page, source: Locator, frameText: string, shot?: string) {
  await source.hover()
  await page.mouse.down()
  const target = page.locator('[data-composer-drop]')
  await target.hover({ position: { x: 40, y: 20 } })
  await target.hover({ position: { x: 60, y: 24 } })
  await expect(frame(page)).toHaveText(frameText)
  if (shot && process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${shot}.png` })
  await page.mouse.up()
  await expect(frame(page)).toHaveCount(0)
}

async function finishTurn(page: Page) {
  await expect.poll(() => chat(page, c => c.open())).toBe(true)
  await chat(page, c => {
    c.send({ type: 'text-start', id: 'tx' })
    c.text('tx', '11月7日までです。')
    c.send({ type: 'text-end', id: 'tx' })
    c.finish()
  })
}

test('a やること tab dropped on the input: the consultation is about it, and the AI gets it with the next message only', async ({ page }) => {
  await openPreview(page, 'chat-header', { tabs: '1', turn: 'manual' })
  await dropOnInput(page, tab(page, /見積書を作り直す/), 'ここに落とすと、このやることの相談になります', 'chat-record-drop-frame')

  await expect(page.locator('[data-topic-chip]')).toContainText('このやることについての相談：見積書を作り直す')
  await expect(page.locator('[data-pending-records]')).toHaveText('やること『見積書を作り直す』を AI に渡します')
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/chat-record-drop.png` })

  await send(page, 'これはいつまで？')
  await expect.poll(async () => (await chatBodies(page)).length).toBe(1)
  expect((await chatBodies(page))[0].droppedRecordIds).toEqual(['task-0000aa'])
  // The conversation is saved about it (its first save carries the topic).
  const flushed = await chat(page, c => c.requests.filter(r => r.path === 'flushChatSession').map(r => r.body?.topicRecordId))
  expect(flushed.at(-1)).toBe('task-0000aa')
  await expect(page.locator('[data-dropped-records]')).toHaveText('やること『見積書を作り直す』を AI に渡しました')
  await expect(page.locator('[data-pending-records]')).toHaveCount(0)
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/chat-record-drop-sent.png` })

  // Read once: the next message does not carry it again.
  await finishTurn(page)
  await send(page, 'ほかに気をつけることは？')
  await expect.poll(async () => (await chatBodies(page)).length).toBe(2)
  expect((await chatBodies(page))[1].droppedRecordIds).toBeUndefined()
})

test('a record dropped on a consultation about another one asks before switching', async ({ page }) => {
  await openPreview(page, 'chat-header', { tabs: '1', turn: 'manual' })
  await dropOnInput(page, tab(page, /見積書を作り直す/), 'ここに落とすと、このやることの相談になります')
  await dropOnInput(page, tab(page, /株式会社サンプル/), 'ここに落とすと、この案件の相談になります')

  const ask = page.locator('[data-topic-switch]')
  await expect(ask).toContainText('『見積書を作り直す』の相談を『株式会社サンプル』の相談に切り替えますか？')
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/chat-record-drop-switch.png` })
  // Not switched until the member says so.
  await expect(page.locator('[data-topic-chip]')).toContainText('このやることについての相談：見積書を作り直す')
  await ask.getByRole('button', { name: '切り替える' }).click()
  await expect(ask).toHaveCount(0)
  await expect(page.locator('[data-topic-chip]')).toContainText('この案件についての相談：株式会社サンプル')

  // このまま keeps the topic; the dropped record still goes to the AI.
  await dropOnInput(page, tab(page, /見積書を作り直す/), 'ここに落とすと、このやることの相談になります')
  await ask.getByRole('button', { name: 'このまま' }).click()
  await expect(page.locator('[data-topic-chip]')).toContainText('この案件についての相談：株式会社サンプル')
  await send(page, '両方を見て')
  await expect.poll(async () => (await chatBodies(page)).length).toBe(1)
  expect((await chatBodies(page))[0].droppedRecordIds).toEqual(['task-0000aa', 'deal-0000bb'])
  const flushed = await chat(page, c => c.requests.filter(r => r.path === 'flushChatSession').map(r => r.body?.topicRecordId))
  expect(flushed.at(-1)).toBe('deal-0000bb')
})

test('a file tab dropped on the input is read by the AI as before, and sets no topic', async ({ page }) => {
  await openPreview(page, 'chat-header', { tabs: '1', turn: 'manual' })
  await dropOnInput(page, tab(page, /価格表\.pdf/), 'ここに落とすと、AI が読みます', 'chat-file-drop-frame')
  await expect(page.locator('[data-topic-chip]')).toHaveCount(0)
  await send(page, 'この価格表で')
  await expect.poll(async () => (await chatBodies(page)).length).toBe(1)
  const body = (await chatBodies(page))[0]
  expect(body.referenceFiles).toEqual(['/tmp/acb-preview/営業部/価格表.pdf'])
  expect(body.droppedRecordIds).toBeUndefined()
})
