// A rich reply drawn whole in its closed frame (chat-ui-and-history.md "Rich replies: the reply's closed frame"), in the
// real chat (chat-header-ui.html?turn=manual) and, for the frame alone, chat-rich-reply-ui.html. The text is the AI's,
// which may have read a planted instruction: two guards — the cleaning and the closed frame — and each must hold
// alone. `outside` records every request that would leave the preview server.
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'
import { ALL_TRAPS, GOOD_REPLY } from './fixtures/reply-html-traps'

type Control = { open(): boolean; send(chunk: unknown): void; text(id: string, delta: string): void; finish(): void; toggleTheme(): void }
type PageGlobals = { __acbChat: Control; __pwned?: unknown[] }

const input = (page: Page) => page.locator('.cm-content[role="textbox"]').locator('visible=true')
async function send(page: Page, text: string) {
  await input(page).click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Meta+Enter')
  await expect.poll(() => chat(page, c => c.open())).toBe(true)
}
const chat = async <T>(page: Page, fn: (control: Control) => T) =>
  (await page.evaluateHandle(() => (window as unknown as PageGlobals).__acbChat)).evaluate(fn)
/** Words of text part `id` arriving. */
const say = async (page: Page, id: string, text: string) =>
  (await page.evaluateHandle(() => (window as unknown as PageGlobals).__acbChat)).evaluate((c, [id, text]) => c.text(id, text), [id, text])
/** The whole reply, streamed `size` characters at a time with a pause between: as the AI writes it. */
async function reply(page: Page, text: string, { size = text.length, pause = 0, id = 't1' } = {}) {
  await page.evaluate(id => (window as unknown as PageGlobals).__acbChat.send({ type: 'text-start', id }), id)
  for (let at = 0; at < text.length; at += size) {
    await say(page, id, text.slice(at, at + size))
    if (pause) await page.waitForTimeout(pause)
  }
}
const finish = (page: Page, id = 't1') => page.evaluate(id => { const c = (window as unknown as PageGlobals).__acbChat; c.send({ type: 'text-end', id }); c.finish() }, id)
const frames = (page: Page) => page.locator('iframe[data-rich-reply-frame]')
const shownFrame = (page: Page) => frames(page).and(page.locator('[style*="visibility: visible"]')).last()
const list = (page: Page) => page.locator('.overflow-auto.space-y-6').locator('visible=true')
const fence = (info: string, body: string) => '```' + info + '\n' + body.trim() + '\n```'

/** Every request leaving for anywhere but the preview server, and every new window (kept from the network, recorded). */
async function outside(context: BrowserContext): Promise<{ requests: string[]; windows: string[] }> {
  const seen = { requests: [] as string[], windows: [] as string[] }
  await context.route(url => !['data:', 'blob:', 'about:'].includes(url.protocol) && url.hostname !== '127.0.0.1', route => {
    seen.requests.push(route.request().url())
    return route.abort()
  })
  context.on('page', popup => seen.windows.push(popup.url()))
  return seen
}

/** Presses, hovers and checks everything in the shown frame (not a web link: that is the member opening it), then tabs. */
async function pokeEverything(page: Page, frame: ReturnType<Page['frameLocator']>) {
  for (const element of await frame.locator('body *').all()) {
    const isWebLink = await element.evaluate(el => el.matches('a[href^="http"]')).catch(() => true)
    await element.hover({ force: true, timeout: 300 }).catch(() => {})
    if (!isWebLink) await element.click({ force: true, timeout: 300 }).catch(() => {})
  }
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
  await page.waitForTimeout(800)
}

/** What happened inside a frame: a script that ran, something fixed over the page, motion for ever, where it is. */
const insideState = (frame: ReturnType<Page['frameLocator']>) => frame.locator('html').evaluate(() => ({
  ran: document.title === 'RAN' || document.documentElement.hasAttribute('data-ran'),
  at: location.href,
  fixed: [...document.querySelectorAll('*')].filter(el => /fixed|sticky/.test(getComputedStyle(el).position)).length,
  endless: document.getAnimations().filter(a => {
    const timing = a.effect?.getComputedTiming()
    return !timing || !(Number(timing.iterations) <= 10) || !(Number(timing.duration) <= 10_000)
  }).length,
}))

/** Traps that show in the frame's own document whether they ran (an opaque frame cannot reach the page's globals). */
const LOCAL_TRAPS = `
<script>document.title = 'RAN'</script>
<img src="x" onerror="document.documentElement.setAttribute('data-ran', '')">
<svg onload="document.title = 'RAN'"></svg>
<a href="https://evil.example/top" target="_top" id="top-link">アプリごと移るリンク</a>
<form action="https://evil.example/form" target="_top"><button id="top-form">送る</button></form>
`

test.describe('in the chat', () => {
  test('a reply with ```acb-html is drawn whole — its words too — in one closed frame; ```html stays code', async ({ page, context }) => {
    const seen = await outside(context)
    const state = await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '経費の精算を教えて')
    await reply(page, `**結論**：締め日は毎月25日です。\n\n${fence('acb-html', GOOD_REPLY)}\n\nわからないことがあれば聞いてください。`)
    await finish(page)
    await expect(frames(page)).toHaveCount(1)
    const frame = frames(page).first()
    await expect(frame).toHaveAttribute('style', /visibility: visible/)
    // The closed frame: no script, no origin of its own, and its own policy first in its document.
    expect(await frame.getAttribute('sandbox')).toBe('allow-popups')
    const srcdoc = (await frame.getAttribute('srcdoc'))!
    expect(srcdoc.indexOf(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;`)).toBeGreaterThan(0)
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<style'))
    expect(await frame.evaluate((el: HTMLIFrameElement) => el.contentDocument === null), 'the chat cannot reach into it').toBe(true)
    // The words and the HTML in the same frame; nothing of the reply outside it.
    const inside = page.frameLocator('iframe[data-rich-reply-frame]')
    await expect(inside.getByText('締め日は毎月25日です', { exact: false })).toBeVisible()
    await expect(inside.locator('h3', { hasText: '経費の精算' })).toBeVisible()
    await expect(inside.getByText('わからないことがあれば聞いてください。')).toBeVisible()
    await expect(page.locator('[data-assistant-text] pre, [data-assistant-text] code')).toHaveCount(0)
    // Its words, table and all, can be chosen and copied as one.
    const chosen = await inside.locator('body').evaluate(body => { const range = document.createRange(); range.selectNodeContents(body); getSelection()!.addRange(range); return getSelection()!.toString() })
    expect(chosen).toContain('締め日は毎月25日です')
    expect(chosen).toContain('今月')
    expect(chosen).toContain('わからないことがあれば')
    // The hidden copy the chat measures: no script, nothing to press.
    const measure = page.locator('iframe[data-rich-reply-measure]')
    expect(await measure.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(await measure.evaluate(el => [el.hasAttribute('inert'), el.getAttribute('aria-hidden'), getComputedStyle(el).visibility])).toEqual([true, 'true', 'hidden'])
    expect((await measure.getAttribute('srcdoc'))!).toContain(`content="default-src 'none'; img-src data:;`)

    // SCREENSHOTS=<dir>: the reply beside the chat, light and dark (for the PR).
    if (process.env.SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/rich-reply-light.png` })
      await chat(page, c => c.toggleTheme())
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${process.env.SCREENSHOTS}/rich-reply-dark.png` })
      await chat(page, c => c.toggleTheme())
    }
    await send(page, 'HTML の例は？')
    await reply(page, `HTML の例です。\n\n${fence('html', '<table><tr><td>保守</td></tr></table>')}`)
    await finish(page)
    await expect(page.locator('[data-assistant-text]').last()).toContainText('<table><tr><td>保守</td></tr></table>')
    await expect(page.locator('[data-assistant-text]').last().locator('iframe')).toHaveCount(0)
    await expect(frames(page)).toHaveCount(1)
    expect(seen).toEqual({ requests: [], windows: [] })
    expectNoPageErrors(state)
  })

  test('the demo\'s traps, written a piece at a time and then pressed, hovered and tabbed: nothing runs, leaves, covers or loops', async ({ page, context }) => {
    const seen = await outside(context)
    const state = await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, 'まとめて')
    await reply(page, `まとめました。\n\n${fence('acb-html', ALL_TRAPS + LOCAL_TRAPS)}\n\n以上です。`, { size: 400, pause: 15 })
    await finish(page)
    const inside = page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1')
    await expect(inside.getByText('以上です。')).toBeVisible()
    await pokeEverything(page, inside)
    const result = await insideState(inside)
    expect(result.ran, 'nothing in the reply ran').toBe(false)
    expect(result.at).toBe('about:srcdoc')
    expect(result.fixed, 'nothing is fixed over the chat').toBe(0)
    expect(result.endless, 'no motion goes on for ever').toBe(0)
    expect(await page.evaluate(() => (window as unknown as PageGlobals).__pwned ?? [])).toEqual([])
    expect(page.url()).toContain('/tests/chat-header-ui.html')
    expect(seen, 'no request and no window left the app').toEqual({ requests: [], windows: [] })
    expectNoPageErrors(state)
  })

  test('a pressed web link leaves only as a new window to that address (the app opens it in the browser), never in the frame', async ({ page, context }) => {
    const seen = await outside(context)
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '案内は？')
    await reply(page, `こちらです。\n\n${fence('acb-html', '<p><a href="https://example.com/guide?q=1">案内のページ</a></p>')}`)
    await finish(page)
    const inside = page.frameLocator('iframe[data-rich-reply-frame]')
    await inside.getByText('案内のページ').click()
    await expect.poll(() => seen.requests).toEqual(['https://example.com/guide?q=1'])
    await expect.poll(() => seen.windows.length).toBe(1)
    expect(await inside.locator('html').evaluate(() => location.href)).toBe('about:srcdoc')
  })

  test('the frame is as tall as its reply, with no scroll inside; past 20,000 px it stops and says where the rest is', async ({ page }) => {
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '表にして')
    await reply(page, `表です。\n\n${fence('acb-html', GOOD_REPLY)}`)
    await finish(page)
    const frame = shownFrame(page)
    await expect(frame).toBeVisible()
    const inside = page.frameLocator('iframe[data-rich-reply-frame]')
    const content = await inside.locator('.acb-root').evaluate(el => el.getBoundingClientRect().height)
    const height = (await frame.boundingBox())!.height
    expect(Math.abs(height - content), `frame ${height}, content ${content}`).toBeLessThanOrEqual(2)
    await expect(page.locator('[data-rich-reply-over]')).toHaveCount(0)

    await send(page, 'もっと長く')
    await reply(page, 'とても長い返事です。\n\n```acb-html\n<div style="height: 30000px">高い</div>\n```')
    await finish(page)
    await expect(page.locator('[data-rich-reply-over]')).toHaveText(/続きは［大きく見る］で見られます/)
    await expect.poll(async () => (await shownFrame(page).boundingBox())?.height).toBe(20_000)
  })

  // Codex review: the shown frame cannot say it grew, so its height is the tallest it can become.
  test('what the member opens or switches in the frame (a step, a tab) and a taller dark layout are never cut off', async ({ page }) => {
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '手順とタブで')
    const tall = (words: string) => Array.from({ length: 12 }, (_, i) => `<p>${words}${i + 1}</p>`).join('')
    await reply(page, `${fence('acb-html', `<style>@media (prefers-color-scheme: dark) { .pad { padding-bottom: 400px } }</style><p class="pad">はじめ</p>
<div class="acb-tabs"><input type="radio" name="t" id="t1" checked><label for="t1">短い</label><input type="radio" name="t" id="t2"><label for="t2">長い</label>
<div class="acb-tab"><p>一行</p></div><div class="acb-tab">${tall('タブ')}</div></div>
<details><summary>くわしく</summary>${tall('手順')}</details>`)}\n\n最後の行です。`)
    await finish(page)
    const inside = page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1')
    const fits = async () => {
      const content = await inside.locator('.acb-root').evaluate(el => el.getBoundingClientRect().height)
      const frame = (await shownFrame(page).boundingBox())!.height
      return frame + 1 >= content
    }
    await expect(inside.getByText('最後の行です。')).toBeVisible()
    await inside.getByText('長い', { exact: true }).click()
    await inside.getByText('くわしく').click()
    await expect(inside.getByText('手順12')).toBeVisible()
    expect(await fits(), 'opened and switched, everything still in the frame').toBe(true)
    await chat(page, c => c.toggleTheme())
    await expect.poll(() => page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1').locator('html').evaluate(el => el.classList.contains('dark'))).toBe(true)
    await page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1').getByText('長い', { exact: true }).click()
    await page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1').getByText('くわしく').click()
    expect(await fits(), 'the dark layout, opened, still in the frame').toBe(true)
  })

  test('a reply being written grows in its frame without a blank moment, redrawn at most about every 80 ms', async ({ page }) => {
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '比べて')
    const rows = Array.from({ length: 30 }, (_, i) => `<tr><td>項目${i + 1}</td><td>${i * 1000}円</td></tr>`).join('\n')
    const text = `比べました。\n\n${fence('acb-html', `<table class="acb-compare"><tbody>\n${rows}\n</tbody></table>`)}\n\n以上です。`
    // Watch, from the page, every frame the chat makes and whether the reply is ever empty once drawn.
    await page.evaluate(() => {
      const w = window as unknown as { __made: number; __blank: number; __drawn: boolean }
      w.__made = 0; w.__blank = 0; w.__drawn = false
      // A frame shown before its document has loaded is an empty moment, as is no frame shown at all.
      const loaded = new WeakSet<Element>()
      new MutationObserver(records => {
        for (const r of records) for (const n of r.addedNodes) {
          if (!(n as Element).matches?.('iframe[data-rich-reply-frame]')) continue
          w.__made++
          n.addEventListener('load', () => loaded.add(n as Element))
        }
      }).observe(document.body, { childList: true, subtree: true })
      const tick = () => {
        const box = document.querySelector('[data-rich-reply]')
        if (box) {
          const visible = [...box.querySelectorAll('iframe[data-rich-reply-frame][style*="visibility: visible"]')]
          if (visible.some(frame => loaded.has(frame))) w.__drawn = true
          else if (w.__drawn) w.__blank++
          if (visible.some(frame => !loaded.has(frame))) w.__blank++
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const started = Date.now()
    await reply(page, text, { size: 12, pause: 8 })
    await finish(page)
    const took = Date.now() - started
    await expect(page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1').getByText('以上です。')).toBeVisible()
    const { made, blank } = await page.evaluate(() => { const w = window as unknown as { __made: number; __blank: number }; return { made: w.__made, blank: w.__blank } })
    expect(blank, 'never empty once drawn').toBe(0)
    expect(made, `${made} frames in ${took} ms`).toBeGreaterThan(2)
    expect(made, `${made} frames in ${took} ms`).toBeLessThanOrEqual(Math.ceil(took / 80) + 3)
    await expect(frames(page)).toHaveCount(1)
  })

  test('a reply being written in its frame follows the bottom, but not while the member has scrolled up to read', async ({ page }) => {
    await openPreview(page, 'chat-header', { list: 'open', history: 'long', turn: 'manual' })
    const fromBottom = () => list(page).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)
    await send(page, '続きを表で')
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `<p>行${i + 1}</p>`).join('\n')
    await reply(page, `表です。\n\n\`\`\`acb-html\n${rows(40)}\n`)
    await expect(shownFrame(page)).toBeVisible()
    await expect.poll(fromBottom).toBeLessThan(5)

    await list(page).evaluate(el => { el.scrollTop = el.scrollTop - 800 })
    await expect.poll(fromBottom).toBeGreaterThan(500)
    const before = await list(page).evaluate(el => [el.scrollTop, el.scrollHeight])
    await say(page, 't1', Array.from({ length: 40 }, (_, i) => `<p>追加${i + 1}</p>`).join('\n') + '\n')
    await expect.poll(() => list(page).evaluate(el => el.scrollHeight)).toBeGreaterThan(before[1] + 400)
    await page.waitForTimeout(300)
    expect(await list(page).evaluate(el => el.scrollTop), 'the reader stays where they scrolled to').toBe(before[0])
    await finish(page)
  })

  test('light / dark follows the app at once, the reply\'s own dark colours included, without an empty moment', async ({ page }) => {
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '色つきで')
    await reply(page, fence('acb-html', '<style>.c { color: rgb(1, 2, 3) } @media (prefers-color-scheme: dark) { .c { color: rgb(250, 251, 252) } }</style><p class="c">色の段落</p>'))
    await finish(page)
    const colour = () => page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1').locator('.c').evaluate(el => getComputedStyle(el).color)
    await expect.poll(colour).toBe('rgb(1, 2, 3)')
    await chat(page, c => c.toggleTheme())
    await expect.poll(colour).toBe('rgb(250, 251, 252)')
    expect(await page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1').locator('html').evaluate(el => el.classList.contains('dark'))).toBe(true)
    await expect(page.locator('[data-rich-reply]')).toHaveAttribute('data-rich-reply-state', 'frame')
    await expect(frames(page)).toHaveCount(1)
  })

  test('a 16:9 slide is scaled to the chat\'s width, whole', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 })
    await openPreview(page, 'chat-header', { turn: 'manual' })
    await send(page, '1枚の図で')
    await reply(page, fence('acb-slide', '<div style="display: flex; justify-content: space-between; height: 720px"><b>左はし</b><b id="right">右はし</b></div>'))
    await finish(page)
    const frame = shownFrame(page)
    await expect(frame).toBeVisible()
    const width = (await frame.boundingBox())!.width
    const slide = await page.frameLocator('iframe[data-rich-reply-frame] >> nth=-1').locator('.acb-slide-inner').evaluate(el => el.getBoundingClientRect().toJSON())
    expect(slide.width).toBeLessThanOrEqual(width + 1)
    expect(slide.width).toBeGreaterThan(width - 2)
    expect(Math.abs(slide.height - slide.width * 9 / 16)).toBeLessThan(2)
  })
})

test('a long conversation of rich replies draws only those near the screen and keeps the reading place', async ({ page }) => {
  await openPreview(page, 'chat-header', { list: 'open', history: 'long', rich: '1' })
  await expect(page.getByRole('button', { name: /^以前のメッセージを表示/ })).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => shownFrame(page).count()).toBeGreaterThan(0)
  const live = () => frames(page).count()
  expect(await live(), 'a handful of frames, not fifty').toBeLessThanOrEqual(8)
  // Up through the conversation: frames follow the screen, and those taken down keep their height.
  for (let step = 0; step < 12; step++) {
    await list(page).evaluate(el => { el.scrollTop = Math.max(0, el.scrollTop - 1500) })
    await page.waitForTimeout(120)
    expect(await live()).toBeLessThanOrEqual(8)
  }
  const top = await list(page).evaluate(el => [el.scrollTop, el.scrollHeight])
  await list(page).evaluate(el => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(500)
  await list(page).evaluate((el, at) => { el.scrollTop = at }, top[0])
  await page.waitForTimeout(500)
  expect(await list(page).evaluate(el => el.scrollHeight), 'heights kept: the list is as long as before').toBe(top[1])
})

test('every piece of a reply is cleaned — its words, each block, one still being written — and none can leave its place', async ({ page }) => {
  await openPreview(page, 'chat-rich-reply')
  const reply = `前置き<script>x()</script> [リンク](javascript:alert(1))\n\n${fence('acb-html', '<p>表</p></div></div></div><p class="out">外へ</p><img src=x onerror="alert(1)"><style>.a{color:red}</style>')}\n\n${fence('acb-slide', '<b onclick="alert(1)">図</b>')}\n\n\`\`\`acb-html\n<p>途中</p><script>alert(1)</script><p>書きか`
  const { body, css } = await page.evaluate(reply => window.__acbRichReply!.contentOf(reply, false), reply)
  expect(body).not.toMatch(/<script|\son\w+=|javascript:/i)
  expect(css).toContain('.a')
  const places = await page.evaluate(body => {
    const root = new DOMParser().parseFromString(`<div id="root">${body}</div>`, 'text/html').getElementById('root')!
    return { pieces: [...root.children].map(el => el.className), out: root.querySelector('.out')?.closest('.acb-piece')?.className, last: root.lastElementChild!.textContent }
  }, body)
  expect(places.pieces).toEqual(['acb-piece acb-markdown', 'acb-piece acb-html', 'acb-piece acb-slide not-prose', 'acb-piece acb-html'])
  expect(places.out, 'a block cannot close the frame\'s own wrappers').toBe('acb-piece acb-html')
  expect(places.last, 'a block still being written shows up to its last whole tag').toBe('途中')
})

test.describe('the frame alone (the cleaning skipped)', () => {
  test('raw traps in the chat\'s frame run nothing, load nothing, move nothing out of the frame', async ({ page, context }) => {
    const seen = await outside(context)
    const state = await openPreview(page, 'chat-rich-reply')
    await page.evaluate(html => window.__acbRichReply!.draw({ html, css: '' }), ALL_TRAPS.replace(/<plaintext>[\s\S]*$/, '') + LOCAL_TRAPS)
    const inside = page.frameLocator('#reply')
    await pokeEverything(page, inside)
    await inside.locator('#top-link').click({ force: true }).catch(() => {})
    await inside.locator('#top-form').click({ force: true }).catch(() => {})
    await page.waitForTimeout(500)
    expect((await insideState(inside)).ran, 'no script ran').toBe(false)
    expect(await page.locator('#reply').evaluate((el: HTMLIFrameElement) => el.contentDocument === null), 'no origin shared with the app').toBe(true)
    expect(page.url(), 'the app was not moved away').toContain('/tests/chat-rich-reply-ui.html')
    expect(seen.requests, 'nothing loaded or sent').toEqual([])
    expectNoPageErrors(state)
  })

  test('the same frame with its sandbox or its policy taken off does run, load or move the app: the checks above can fail', async ({ page, context }) => {
    const seen = await outside(context)
    await openPreview(page, 'chat-rich-reply')
    const html = ALL_TRAPS.replace(/<plaintext>[\s\S]*$/, '') + LOCAL_TRAPS
    await page.evaluate(html => window.__acbRichReply!.draw({ html, css: '', policy: false }), html)
    await page.waitForTimeout(500)
    expect(seen.requests.length, 'without the policy, the traps load').toBeGreaterThan(0)
    await page.evaluate(html => window.__acbRichReply!.draw({ html, css: '', sandbox: false }), LOCAL_TRAPS)
    expect(await page.locator('#reply').evaluate((el: HTMLIFrameElement) => el.contentDocument !== null), 'without the sandbox, the app can be reached').toBe(true)
    await page.frameLocator('#reply').locator('#top-link').click({ force: true }).catch(() => {})
    await expect.poll(() => page.url(), 'without the sandbox, a link moves the app away').not.toContain('/tests/chat-rich-reply-ui.html')
  })
})
