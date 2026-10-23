// The real ChatPanel (tests/chat-header-ui.tsx) with a mocked preload API and
// a mocked chat server. Pure parts are pinned elsewhere — message window
// arithmetic and markdown blocks (chat-rendering.test.ts), tool-row grouping
// (tool-rows.test.ts), meter view (rate-limit-meter.test.ts). These tests pin how ChatPanel wires them
// together on screen, which is what the ChatPanel split (R3) can break.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

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

test.describe('a running turn', () => {
  test('Claude Code: subagent row with its live progress line, usage meter, stop button, model locked', async ({ page }) => {
    await openPreview(page, 'chat-header')
    const header = page.getByRole('banner')
    await expect(header.getByRole('button', { name: '利用上限: 5時間 24%、1週間 66%' })).toBeVisible()
    await expect(header.getByRole('combobox').first()).toBeEnabled()
    await send(page, '見積書を作って')
    await expect(page.getByRole('button', { name: /^サブエージェント 過去の見積書と価格表を調べる ツール 4件（実行中 1）/ })).toBeVisible()
    await expect(page.getByText('価格表の10月改定分と過去の見積書の単価を照らし合わせています')).toBeVisible()
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
    const sidebar = page.getByRole('complementary', { name: '相談一覧' })
    await expect(sidebar.getByRole('heading', { name: '開いている相談 2件' })).toBeVisible()
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
