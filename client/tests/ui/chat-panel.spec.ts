// The real ChatPanel (tests/chat-header-ui.tsx) with a mocked preload API and
// a mocked chat server. Pure parts are pinned elsewhere — message window
// arithmetic and markdown blocks (chat-rendering.test.ts), tool-row grouping
// (tool-rows.test.ts), meter view (rate-limit-meter.test.ts), steering and
// choice protocols (steering.test.ts, choice-prompt.test.ts), suggestion rules
// (prompt-suggestion.test.ts). These tests pin how ChatPanel wires them
// together on screen, which is what the ChatPanel split (R3) can break.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Control = {
  requests: Array<{ path: string; body: Record<string, unknown> | null }>
  steerStatus: 'delivered' | 'not-delivered' | 'unavailable'
  suggestion: string | null
  open(): boolean
  send(chunk: unknown): void
  text(id: string, delta: string): void
  finish(): void
  ask(toolCallId?: string): void
  answers: Array<{ id: string; response: unknown }>
  opened: string[]
}
declare global { interface Window { __acbChat: Control } }

const input = (page: Page) => page.locator('.cm-content[role="textbox"]').locator('visible=true')
const typed = (page: Page) => expect.poll(() => input(page).evaluate(content => {
  const copy = content.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.cm-placeholder, .cm-ghost-suggestion, .cm-widgetBuffer').forEach(node => node.remove())
  return [...copy.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')
}))
async function send(page: Page, text: string) {
  await input(page).click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Meta+Enter')
}
const chat = async <T>(page: Page, fn: (control: Control) => T) => (await page.evaluateHandle(() => window.__acbChat)).evaluate(fn)
const paths = (page: Page) => chat(page, c => c.requests.map(r => r.path))
const turnStarted = (page: Page) => expect.poll(() => chat(page, c => c.open())).toBe(true)

test.describe('a running turn', () => {
  test('Claude Code: subagent row with its live progress line, usage meter, stop button, model locked', async ({ page }) => {
    await openPreview(page, 'chat-header')
    const header = page.getByRole('banner')
    await expect(header.getByRole('button', { name: '利用上限: 5時間 24%、1週間 66%' })).toBeVisible()
    await expect(header.getByRole('combobox').first()).toBeEnabled()
    await send(page, '見積書を作って')
    await expect(page.getByRole('button', { name: /^サブエージェント 過去の見積書と価格表を調べる ツール 4件（実行中 1）/ })).toBeVisible()
    const progress = '価格表の10月改定分と過去の見積書の単価を照らし合わせています'
    await expect(page.getByTitle(progress)).toBeVisible()
    // The conversation list shows the same line under 「AIが作業中」.
    const working = page.getByRole('complementary', { name: 'AIへの相談' }).getByRole('region', { name: 'AIが作業中' })
    await expect(working.getByRole('button', { name: /^見積書を作って/ })).toContainText(progress)
    await expect(header.getByRole('button', { name: '停止' })).toBeVisible()
    await expect(header.getByRole('combobox', { name: '応答中はモデルを変更できません' })).toBeDisabled()
  })

  test('Codex: its own model pickers, meter window, and no subagent progress line', async ({ page }) => {
    await openPreview(page, 'chat-header', { agent: 'codex' })
    const header = page.getByRole('banner')
    await expect(header.getByRole('button', { name: '利用上限: 1週間 60%' })).toBeVisible()
    await expect(header.getByRole('combobox', { name: 'Codexモデル' })).toHaveValue('gpt-5.5-codex')
    await send(page, '見積書を作って')
    await expect(page.getByRole('button', { name: /^サブエージェント 過去の見積書と価格表を調べる/ })).toBeVisible()
    await expect(header.getByRole('combobox', { name: 'Codexモデル' })).toBeDisabled()
    // The progress event arrives 300 ms after the rows; give it time to (not) show.
    await page.waitForTimeout(800)
    await expect(page.getByText('価格表の10月改定分と過去の見積書の単価を照らし合わせています')).toHaveCount(0)
  })

  test('the usage meter says "unknown" when the server has no snapshot', async ({ page }) => {
    await openPreview(page, 'chat-header', { limits: 'unknown' })
    await expect(page.getByRole('banner').getByRole('button', { name: '利用上限: 情報なし' })).toBeVisible()
  })

  test('streaming markdown: finished blocks keep their DOM nodes while only the tail grows', async ({ page }) => {
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '手順を書いて')
    await turnStarted(page)
    await chat(page, c => { c.send({ type: 'text-start', id: 't1' }); c.text('t1', '## 手順\n\n最初に資料を集めます。\n\n') })
    const first = page.getByText('最初に資料を集めます。')
    await expect(first).toBeVisible()
    await first.evaluate(element => { (element as HTMLElement & { __acbMark?: boolean }).__acbMark = true })
    await chat(page, c => c.text('t1', '```ts\nconst total = 1'))
    await expect(page.locator('code', { hasText: 'const total = 1' })).toBeVisible()
    await chat(page, c => c.text('t1', '2\n```\n\n次に見積書を作ります。'))
    await expect(page.getByText('次に見積書を作ります。')).toBeVisible()
    await expect(page.locator('code', { hasText: 'const total = 12' })).toBeVisible()
    expect(await first.evaluate(element => (element as HTMLElement & { __acbMark?: boolean }).__acbMark === true),
      'the first paragraph was not re-mounted while the reply streamed').toBe(true)
    await chat(page, c => { c.send({ type: 'text-end', id: 't1' }); c.finish() })
    await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0)
  })
})

test.describe('instructions while the AI works', () => {
  test('delivered: shown inside the running reply, nothing waits, the turn keeps running', async ({ page }) => {
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '見積書を作って')
    await turnStarted(page)
    await send(page, '価格表は10月版で')
    await expect(page.getByText('作業中に追加した指示')).toBeVisible()
    await expect(page.getByText('価格表は10月版で')).toBeVisible()
    await expect(page.getByText(/応答が終わったら送ります/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible()
    expect((await chat(page, c => c.requests.filter(r => r.path === '/api/steer').map(r => r.body)))).toEqual([
      expect.objectContaining({ text: '価格表は10月版で' }),
    ])
  })

  for (const steerStatus of ['unavailable', 'not-delivered'] as const) {
    test(`${steerStatus}: waits above the input and goes out as the next message when the turn ends`, async ({ page }) => {
      await openPreview(page, 'chat-header', { turn: 'manual' })
      await page.evaluate(status => { window.__acbChat.steerStatus = status }, steerStatus)
      await send(page, '見積書を作って')
      await turnStarted(page)
      await send(page, '価格表は10月版で')
      const waiting = page.getByRole('listitem').filter({ hasText: '応答が終わったら送ります' })
      await expect(waiting).toContainText('価格表は10月版で')
      await chat(page, c => c.finish())
      await expect(waiting).toHaveCount(0)
      // An instruction the agent took but never read leaves the reply: it is sent again as a message.
      await expect(page.getByText('作業中に追加した指示')).toHaveCount(0)
      await expect.poll(() => paths(page)).toEqual(expect.arrayContaining(['/api/chat', '/api/steer']))
      await expect.poll(async () => (await paths(page)).filter(p => p === '/api/chat').length).toBe(2)
      await expect(page.getByText('価格表は10月版で')).toBeVisible()
    })
  }

  test('a waiting message can be taken back into the input; after a stop, waiting messages return to the input', async ({ page }) => {
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await chat(page, c => { c.steerStatus = 'unavailable' })
    await send(page, '見積書を作って')
    await turnStarted(page)
    await send(page, '一つ目')
    const waiting = page.getByRole('listitem').filter({ hasText: '応答が終わったら送ります' })
    await waiting.getByRole('button', { name: '取り消す' }).click()
    await expect(waiting).toHaveCount(0)
    await typed(page).toBe('一つ目')

    await page.keyboard.press('Meta+Enter')
    await expect(waiting).toContainText('一つ目')
    await page.getByRole('banner').getByRole('button', { name: '停止' }).click()
    await expect(waiting).toHaveCount(0)
    await typed(page).toBe('一つ目')
    expect((await paths(page)).filter(p => p === '/api/chat')).toHaveLength(1)
  })
})

test('a next-prompt suggestion is asked for after a finished turn and offered as ghost text', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual' })
  await chat(page, c => { c.suggestion = 'はい、本文まで書いてください' })
  await send(page, '骨子を作って')
  await turnStarted(page)
  await chat(page, c => { c.send({ type: 'text-start', id: 't1' }); c.text('t1', '骨子です。'); c.send({ type: 'text-end', id: 't1' }) })
  // Not while the AI works.
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await chat(page, c => c.finish())
  await expect(page.locator('.cm-ghost-suggestion')).toHaveText('はい、本文まで書いてください')
  expect((await paths(page)).some(p => p.startsWith('/api/prompt-suggestion/'))).toBe(true)
})

test('a choice question waits above the input of its own conversation, survives a tab switch, and is answered in place', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual' })
  await send(page, '提案書を作って')
  await turnStarted(page)
  await chat(page, c => { c.send({ type: 'text-start', id: 't1' }); c.text('t1', '確認させてください。'); c.send({ type: 'text-end', id: 't1' }); c.ask() })
  const card = page.getByRole('region', { name: 'Claudeからの質問' }).locator('visible=true')
  await expect(card).toBeVisible()

  // Another conversation does not show it; coming back does, and the reply kept streaming meanwhile.
  const sidebar = page.getByRole('complementary', { name: 'AIへの相談' })
  await sidebar.getByRole('button', { name: 'AIに相談する', exact: true }).click()
  await expect(card).toHaveCount(0)
  // The waiting conversation is listed under 「あなたの番」 with its question.
  const yourTurn = sidebar.getByRole('region', { name: 'あなたの番' })
  await expect(yourTurn.getByRole('button', { name: /^提案書を作って/ })).toBeVisible()
  await expect(sidebar.getByText('あなたの番 1')).toBeVisible()
  // What waits for the member cannot be folded away.
  await expect(yourTurn.getByRole('button', { name: /^あなたの番/ })).toHaveCount(0)
  await chat(page, c => { c.send({ type: 'text-start', id: 't2' }); c.text('t2', '（回答をお待ちしています）'); c.send({ type: 'text-end', id: 't2' }) })
  await sidebar.getByRole('button', { name: /^提案書を作って/ }).click()
  await expect(card).toBeVisible()
  await expect(page.getByText('（回答をお待ちしています）')).toBeVisible()

  await card.getByRole('radio', { name: /^PDF/ }).check()
  await card.getByRole('button', { name: '回答する' }).click()
  await expect(card).toHaveCount(0)
  expect(await chat(page, c => c.answers)).toEqual([{ id: 'ask-toolu_ask', response: { choices: [{ selected: ['PDF'] }] } }])
  await expect(page.getByText('選択肢の質問 · 回答済み')).toBeVisible()
})

test('a reply that finishes while the member is elsewhere is marked 新着 at the top of 「開いている相談」 until they have looked at it and moved on', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual' })
  await send(page, '議事録をまとめて')
  await turnStarted(page)
  const sidebar = page.getByRole('complementary', { name: 'AIへの相談' })
  const row = sidebar.getByRole('button', { name: /^議事録をまとめて/ })
  await expect(sidebar.getByRole('region', { name: 'AIが作業中' })).toContainText('議事録をまとめて')
  await sidebar.getByRole('button', { name: 'AIに相談する', exact: true }).click()
  await chat(page, c => { c.send({ type: 'text-start', id: 't1' }); c.text('t1', 'まとめました。'); c.send({ type: 'text-end', id: 't1' }); c.finish() })
  const open = sidebar.getByRole('region', { name: '開いている相談' })
  await expect(open.locator('[data-conversation-id] > button').first()).toHaveAccessibleName(/^議事録をまとめて/)
  await expect(row).toContainText('新着')
  await expect(row).toContainText('返事が届いています')

  // Reading it keeps the mark; moving on to another conversation clears it, still open to continue.
  await row.click()
  await expect(page.getByText('まとめました。').locator('visible=true')).toBeVisible()
  await expect(row).toContainText('新着')
  await sidebar.getByRole('button', { name: 'AIに相談する', exact: true }).click()
  await expect(row).not.toContainText('新着')
  await expect(open.getByRole('button', { name: /^議事録をまとめて/ })).toBeVisible()
})

test('a new conversation left for another with nothing typed goes away; one with a draft stays', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual' })
  const sidebar = page.getByRole('complementary', { name: 'AIへの相談' })
  const open = sidebar.getByRole('region', { name: '開いている相談' })
  const rows = open.locator('[data-conversation-id]')
  const newConversation = sidebar.getByRole('button', { name: 'AIに相談する', exact: true })
  await expect(rows).toHaveCount(1)
  await expect(input(page)).toBeVisible()

  // Opening new conversations one after another leaves no trail of blank ones.
  await newConversation.click()
  await expect(rows).toHaveCount(1)
  await newConversation.click()
  await expect(rows).toHaveCount(1)

  // An unsent draft is kept when the member moves on; the blank one they left is not.
  await input(page).click()
  await page.keyboard.insertText('来週の会議の議題')
  await newConversation.click()
  await expect(rows).toHaveCount(2)
  // (The preview's history store keeps nothing, so the row shows no 下書き line: pick the other tab.)
  await open.locator('button:not([aria-current])', { hasText: '新しい会話' }).click()
  await expect(rows).toHaveCount(1)
  await typed(page).toBe('来週の会議の議題')
  // Nothing went to 「終わったもの」 on the way.
  await expect(sidebar.getByRole('region', { name: '終わったもの' })).toHaveCount(0)

  // A sent conversation is kept when the member moves on; the blank one they leave for it is not.
  await send(page, 'を整理して')
  await turnStarted(page)
  await chat(page, c => c.finish())
  await newConversation.click()
  const sent = open.getByRole('button', { name: /^来週の会議の議題を整理して/ })
  await sent.click()
  await expect(rows).toHaveCount(1)
  await expect(sent).toHaveAttribute('aria-current', 'page')
})

test('a group heading folds its rows, stays folded after a reload, and a search still shows its matches', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual', storage: 'keep' })
  const sidebar = page.getByRole('complementary', { name: 'AIへの相談' })
  const heading = sidebar.getByRole('button', { name: /^開いている相談/ })
  const row = sidebar.getByRole('button', { name: /^新しい会話/ })
  await expect(row).toBeVisible()
  await expect(heading).toHaveAttribute('aria-expanded', 'true')

  await heading.click()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(heading).toContainText('1件')
  await expect(row).toBeHidden()
  // The conversation itself stays on screen.
  await expect(input(page)).toBeVisible()
  // Keyboard: Enter opens it again, Space folds it.
  await heading.press('Enter')
  await expect(row).toBeVisible()
  await heading.press('Space')
  await expect(row).toBeHidden()

  await page.reload()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(row).toBeHidden()

  // A search shows matches in a folded group; clearing it folds the group again.
  await sidebar.getByRole('textbox', { name: '相談を検索' }).fill('新しい')
  await expect(row).toBeVisible()
  await sidebar.getByRole('button', { name: '検索をクリア' }).click()
  await expect(row).toBeHidden()
})

test('a group heading stays at the top of the list while its rows scroll under it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await openPreview(page, 'chat-header', { turn: 'manual', history: 'many' })
  const sidebar = page.getByRole('complementary', { name: 'AIへの相談' })
  const closed = sidebar.getByRole('button', { name: /^終わったもの/ })
  await expect(sidebar.getByRole('button', { name: /^終わった相談 15/ })).toBeAttached()
  const list = sidebar.locator('.overflow-y-auto')
  const listTop = async () => (await list.boundingBox())!.y
  await list.evaluate(el => { el.scrollTop = el.scrollHeight })
  // Scrolled to the end: the closed group's heading is pinned at the top of the list, not scrolled away.
  await expect.poll(async () => Math.abs(Math.round((await closed.boundingBox())!.y - await listTop()))).toBeLessThanOrEqual(2)
  await expect(closed).toBeInViewport()
  await closed.click()
  await expect(closed).toHaveAttribute('aria-expanded', 'false')
})

test('「確認をお願いします」: the AI asks for a review and stops; 「あなたの番」 until the member answers, files open in the editor', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual' })
  await send(page, '企画書を書いて')
  await turnStarted(page)
  await chat(page, c => {
    c.send({ type: 'text-start', id: 't1' }); c.text('t1', '骨子を作りました。'); c.send({ type: 'text-end', id: 't1' })
    c.send({ type: 'data-review-request', id: 'review-r1', data: { id: 'r1', title: '企画書の骨子', files: ['営業部/企画/骨子.md'], points: ['価格の前提'] } })
    c.finish()
  })
  const card = page.getByRole('group', { name: '確認をお願いします' }).locator('visible=true')
  await expect(card).toContainText('企画書の骨子')
  await expect(card).toContainText('価格の前提')
  const sidebar = page.getByRole('complementary', { name: 'AIへの相談' })
  const mine = sidebar.getByRole('region', { name: 'あなたの番' })
  await expect(mine.getByRole('button', { name: /^企画書を書いて/ })).toContainText('確認をお願いします：企画書の骨子')
  await expect(sidebar.getByText('あなたの番 1')).toBeVisible()

  // A file opens in the editor (the main screen's opener, with the company folder).
  await card.getByRole('button', { name: '営業部/企画/骨子.md' }).click()
  expect(await chat(page, c => c.opened)).toEqual(['/tmp/acb-preview/営業部/企画/骨子.md'])

  // 「この内容で進めて」 answers it: the next turn starts with the fixed message.
  await card.getByRole('button', { name: 'この内容で進めて' }).click()
  await turnStarted(page)
  await expect(page.getByText('確認しました。この内容で次に進めてください。').locator('visible=true')).toBeVisible()
  await expect(mine).toHaveCount(0)
  await expect(card).toContainText('返事済み')
  await expect(card.getByRole('button', { name: 'この内容で進めて' })).toHaveCount(0)
})

test.describe('a long restored conversation', () => {
  const userQuestions = (page: Page) => page.getByText(/^質問\d+: /).locator('visible=true')
  const list = (page: Page) => page.locator('.overflow-auto', { has: page.getByText(/^質問\d+: /) }).locator('visible=true')

  test('opens at the bottom with only the latest messages; 「以前のメッセージを表示」 adds a page without moving what is on screen', async ({ page }) => {
    await openPreview(page, 'chat-header', { history: 'long' })
    const more = page.getByRole('button', { name: '以前のメッセージを表示（残り190件）' })
    await expect(more).toBeVisible({ timeout: 15_000 })
    await expect(userQuestions(page)).toHaveCount(25)
    await expect(userQuestions(page).last()).toHaveText(/^質問120: /)
    await expect.poll(() => list(page).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)

    await list(page).evaluate(el => { el.scrollTop = 0 })
    // Messages rendered off-screen until now take their real height in the
    // next frames (content-visibility); read the position once it settles.
    const anchor = page.getByText(/^質問96: /)
    let before = await anchor.boundingBox()
    await expect.poll(async () => {
      const previous = before
      before = await anchor.boundingBox()
      return previous?.y === before?.y && (await list(page).evaluate(el => el.scrollTop)) === 0
    }, { intervals: [100] }).toBe(true)
    await more.click()
    await expect(page.getByRole('button', { name: '以前のメッセージを表示（残り140件）' })).toBeVisible()
    await expect(userQuestions(page)).toHaveCount(50)
    const after = await anchor.boundingBox()
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0)), 'the message on screen stays where it was').toBeLessThan(3)
  })

  test('both restored tabs are listed; switching keeps each tab\'s draft, keeps the other tab mounted and reopens at the latest message', async ({ page }) => {
    await openPreview(page, 'chat-header', { history: 'long' })
    const sidebar = page.getByRole('complementary', { name: 'AIへの相談' })
    // Both restored tabs are idle: 「開いている相談」, marked.
    await expect(sidebar.getByRole('region', { name: '開いている相談' }).getByText('開いています')).toHaveCount(1)
    await expect(sidebar.getByRole('region', { name: '開いている相談' }).getByText('表示中')).toHaveCount(1)
    await expect(page.getByRole('button', { name: /^以前のメッセージを表示/ })).toBeVisible({ timeout: 15_000 })
    await list(page).evaluate(el => { el.scrollTop = 0 })

    // The blank tab restored as 「別の相談」 (renamed 「新しい会話」 once it is set up).
    await sidebar.getByRole('button', { name: /^(別の相談|新しい会話) / }).click()
    await expect(userQuestions(page)).toHaveCount(0)
    // The long conversation is hidden, not unmounted.
    await expect(page.getByText(/^質問120: /)).toBeAttached()
    await input(page).click()
    await page.keyboard.insertText('別の相談の下書き')

    await sidebar.getByRole('button', { name: /^長い相談（240件）/ }).click()
    await expect(userQuestions(page).last()).toHaveText(/^質問120: /)
    await typed(page).toBe('')
    // Showing a conversation again opens it at the latest message.
    await expect.poll(() => list(page).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)

    await sidebar.getByRole('button', { name: /^(別の相談|新しい会話) / }).click()
    await typed(page).toBe('別の相談の下書き')
  })
})

test('not signed in: 「設定を開く」 on the setup screen opens the agent settings, and closing them returns to it', async ({ page }) => {
  await openPreview(page, 'chat-header', { auth: 'none' })
  const openSettings = page.getByRole('button', { name: '設定を開く' })
  await expect(page.getByText('Claude Code にログインしていません')).toBeVisible()
  const settings = page.getByRole('dialog', { name: '相談の設定' })
  await expect(settings).toHaveCount(0)
  await openSettings.click()
  await expect(settings).toBeVisible()
  await expect(openSettings).toBeHidden()
  await settings.getByRole('button', { name: '✕' }).click()
  await expect(settings).toHaveCount(0)
  await expect(openSettings).toBeVisible()
})

test('editing a message resends it like a normal send: saved first without the later messages, its file references kept', async ({ page }) => {
  await openPreview(page, 'chat-header', { history: 'edit', turn: 'manual' })
  const first = page.getByText('見積書を作って', { exact: true })
  await expect(first).toBeVisible({ timeout: 15_000 })
  await first.hover()
  await page.getByTitle('編集', { exact: true }).first().click()
  await page.locator('textarea').locator('visible=true').fill('見積書をPDFで作って')
  await page.getByRole('button', { name: '送信', exact: true }).click()
  await turnStarted(page)

  type Saved = { messages: Array<{ role: string; content: string }> }
  type Body = { referenceFiles?: string[]; messages: Array<{ role: string; parts: Array<{ text?: string }> }> }
  const requests = await chat(page, c => c.requests.map(r => ({ path: r.path, body: r.body })))
  const chatIndex = requests.findIndex(r => r.path === '/api/chat')
  // The synchronous save right before the request already holds the edit and nothing after it.
  const save = requests.slice(0, chatIndex).reverse().find(r => r.path === 'flushChatSession')
  expect(save, 'saved synchronously before sending').toBeTruthy()
  const saved = (save!.body as unknown as Saved).messages
  expect(saved.filter(m => m.role === 'user').map(m => m.content)).toEqual(['見積書をPDFで作って'])
  expect(saved.some(m => m.content.includes('単価'))).toBe(false)
  // The request: the edited text in place of the old message, with its file references.
  const body = requests[chatIndex].body as unknown as Body
  expect(body.referenceFiles).toEqual(['営業部/価格表/2026-10改定.pdf'])
  expect(body.messages.filter(m => m.role === 'user').map(m => m.parts.map(p => p.text ?? '').join(''))).toEqual(['見積書をPDFで作って'])
  await expect(page.getByText('単価を見直して')).toHaveCount(0)
  await expect(page.locator('[title="営業部/価格表/2026-10改定.pdf"]').locator('visible=true')).toBeVisible()
})

// chat.newConsultation is what a skill's 実行 runs; chat.insertText fills the composer (commands.md).
test('chat commands: a new consultation sends its message; inserted text waits in the composer; another pane is not reached', async ({ page }) => {
  await openPreview(page, 'chat-header', { turn: 'manual' })
  const run = (id: string, args: Record<string, unknown>) =>
    page.evaluate(([id, args]) => (window as unknown as { __acbCommands: { run: (id: string, args: unknown) => Promise<unknown> } }).__acbCommands.run(id, args), [id, args] as const)
  const chatBodies = () => chat(page, c => c.requests.filter(r => r.path === '/api/chat').map(r => JSON.stringify(r.body)))
  await expect(input(page)).toBeVisible()
  await run('chat.newConsultation', { message: '/monthly-report ' })
  await expect.poll(async () => (await chatBodies()).length).toBe(1)
  expect((await chatBodies())[0]).toContain('/monthly-report')
  await turnStarted(page)
  await chat(page, c => c.finish())

  await run('chat.insertText', { text: '来月の予算について' })
  await typed(page).toBe('来月の予算について')
  await run('chat.insertText', { text: '別の欄あて', pane: 'right' })
  await page.waitForTimeout(300)
  await typed(page).toBe('来月の予算について')
  expect(await chatBodies()).toHaveLength(1)
})
