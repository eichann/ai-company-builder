// A reply's diagrams (chat-ui-and-history.md "Diagrams in a reply") on the real ChatPanel (tests/chat-header-ui.tsx)
// in Chromium. The reply's text is the AI's, and the AI may have read a planted instruction, so the guards are:
// - a diagram never runs script and never reaches the network (sanitised SVG, shown as an <img>; mermaid 'strict');
// - mermaid's file loads only when a reply has a mermaid diagram (not at start: the bundle budget);
// - a block that cannot be drawn stays the code it is;
// - 「返事の形」 is chosen beside the model, and only リッチ reaches the request.
// The preview has no CSP: what is shown here holds without the app's.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Control = {
  requests: Array<{ path: string; body: Record<string, unknown> | null }>
  open(): boolean
  send(chunk: unknown): void
  text(id: string, delta: string): void
  finish(): void
}
// The page's own globals, read without widening Window (chat-panel.spec.ts declares __acbChat its way).
type PageGlobals = { __acbChat: Control; __pwned?: unknown[] }

const input = (page: Page) => page.locator('.cm-content[role="textbox"]').locator('visible=true')
const composer = (page: Page) => page.locator('[data-composer-drop]').locator('visible=true')
const modelSwitch = (page: Page) => composer(page).getByRole('button', { name: /^モデルと考える強さ：/ })
async function chat<T>(page: Page, fn: (control: Control) => T): Promise<T>
async function chat<T, A>(page: Page, fn: (control: Control, arg: A) => T, arg: A): Promise<T>
async function chat<T, A>(page: Page, fn: (control: Control, arg: A) => T, arg?: A): Promise<T> {
  const handle = await page.evaluateHandle(() => (window as unknown as PageGlobals).__acbChat)
  return (handle as unknown as { evaluate(f: typeof fn, a: A | undefined): Promise<T> }).evaluate(fn, arg)
}

async function send(page: Page, text: string) {
  await input(page).click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Meta+Enter')
  await expect.poll(() => chat(page, c => c.open())).toBe(true)
}

/** The AI answers `reply` in a few pieces (fences close mid-stream, as they do) and the turn ends. */
async function reply(page: Page, text: string) {
  await chat(page, c => c.send({ type: 'text-start', id: 't1' }))
  for (let at = 0; at < text.length; at += 40) await chat(page, (c, piece) => c.text('t1', piece), text.slice(at, at + 40))
  await chat(page, c => { c.send({ type: 'text-end', id: 't1' }); c.finish() })
}

/** Every request the page makes that is not the preview server itself. */
function outsideRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.hostname !== '127.0.0.1') seen.push(request.url())
  })
  return seen
}

const diagrams = (page: Page) => page.locator('[data-chat-diagram] img')
const decodedPictures = (page: Page) => diagrams(page).evaluateAll(images => images.map(image => {
  const src = image.getAttribute('src') ?? ''
  return { src: decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, '')), dataUrl: src.startsWith('data:image/svg+xml'), drawn: (image as HTMLImageElement).naturalWidth > 0 }
}))

const FLOWCHART = '```mermaid\nflowchart LR\n  A[申し込み] --> B{入金あり?}\n  B -->|はい| C[受付完了]\n  B -->|いいえ| D[督促]\n```'
const SEQUENCE = '```mermaid\nsequenceDiagram\n  お客さん->>ACB: 問い合わせ\n  ACB-->>お客さん: 返事\n```'
const SVG = '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect x="1" y="1" width="118" height="38" rx="6" fill="#e0f2fe" stroke="#0369a1"/><text x="60" y="25" text-anchor="middle" font-size="14">売上の流れ</text></svg>\n```'

test('a reply\'s mermaid and SVG blocks are drawn as pictures, and mermaid\'s file loads only once a mermaid diagram comes', async ({ page }) => {
  const mermaidLoads: string[] = []
  page.on('request', request => { if (request.url().includes('mermaid.tiny')) mermaidLoads.push(request.url()) })
  const state = await openPreview(page, 'chat-header', { turn: 'manual' })
  await send(page, '手続きの流れを図にして')
  await reply(page, `SVG だけ先に：\n\n${SVG}\n\nここまで。`)
  await expect(diagrams(page)).toHaveCount(1)
  expect(mermaidLoads, 'no mermaid before a mermaid diagram').toEqual([])

  await send(page, 'mermaid でも')
  await reply(page, `流れはこうです。\n\n${FLOWCHART}\n\nやりとり：\n\n${SEQUENCE}\n\n以上です。`)
  await expect(diagrams(page)).toHaveCount(3, { timeout: 20_000 })
  const pictures = await decodedPictures(page)
  for (const picture of pictures) {
    expect(picture.dataUrl).toBe(true)
    expect(picture.drawn, 'the picture has a size').toBe(true)
  }
  expect(pictures[1].src, 'the flowchart\'s words are in the picture').toContain('入金あり?')
  expect(mermaidLoads).toHaveLength(1)
  // SCREENSHOTS=<dir> keeps a picture of the drawn reply (for the pull request), like the other chat specs.
  if (process.env.SCREENSHOTS) {
    await diagrams(page).nth(1).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/chat-diagrams.png` })
    await modelSwitch(page).click()
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/chat-reply-style-menu.png` })
    await page.keyboard.press('Escape')
  }
  // The source stays at hand, folded.
  await page.getByText('図のもとの書き方').first().click()
  await expect(page.getByText('売上の流れ').first()).toBeVisible()
  expectNoPageErrors(state)
})

test('a planted diagram runs nothing and reaches nothing: no script, handler, outside reference or loose mermaid', async ({ page }) => {
  const outside = outsideRequests(page)
  await page.route(url => url.hostname !== '127.0.0.1', route => route.abort())
  const state = await openPreview(page, 'chat-header', { turn: 'manual' })
  await page.evaluate(() => { (window as unknown as PageGlobals).__pwned = [] })
  const evilSvg = [
    '```svg',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50" onload="window.__pwned.push(\'svg-onload\')">',
    '<script>window.__pwned.push(\'svg-script\')</script>',
    '<style>@import url(https://evil.example/style.css); rect { fill: url(https://evil.example/fill.png) }</style>',
    '<image href="https://evil.example/image.png" width="10" height="10"/>',
    '<use xlink:href="https://evil.example/sprite.svg#a"/>',
    '<a href="javascript:window.__pwned.push(\'link\')"><text x="5" y="20">押して</text></a>',
    '<foreignObject width="100" height="50"><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/frame"></iframe><img xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/fo.png" onerror="window.__pwned.push(\'fo\')"/></foreignObject>',
    '<rect width="40" height="20" fill="#0369a1" onclick="window.__pwned.push(\'click\')" style="background:url(https://evil.example/bg.png)"><set attributeName="href" to="javascript:alert(1)"/></rect>',
    '<text x="50" y="40">見出し</text>',
    '</svg>',
    '```',
  ].join('\n')
  const evilMermaid = [
    '```mermaid',
    '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%',
    'flowchart TD',
    '  A["<img src=https://evil.example/label.png onerror=window.__pwned.push(1)>"] --> B["<script>window.__pwned.push(2)</script>次へ"]',
    '  B --> C[終わり]',
    '  click A callback "押してください"',
    '  click C "javascript:window.__pwned.push(3)"',
    '  click B href "https://evil.example/link"',
    '```',
  ].join('\n')
  await send(page, '図を出して')
  await reply(page, `一つ目：\n\n${evilSvg}\n\n二つ目：\n\n${evilMermaid}\n\n以上。`)
  await expect(diagrams(page)).toHaveCount(2, { timeout: 20_000 })
  // Pressing a picture does nothing either.
  for (const image of await diagrams(page).all()) await image.click()
  await page.waitForTimeout(500)

  expect(await page.evaluate(() => (window as unknown as PageGlobals).__pwned), 'nothing in a diagram ran').toEqual([])
  expect(outside, 'no request left the app').toEqual([])
  for (const picture of await decodedPictures(page)) expect(picture.dataUrl).toBe(true)
  // Read as the picture is read: what elements, attributes and styles it holds (planted words drawn as text are fine).
  const planted = await diagrams(page).evaluateAll(images => images.map(image => {
    const svg = decodeURIComponent((image.getAttribute('src') ?? '').replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const found: string[] = []
    if (doc.querySelector('parsererror')) found.push('not a picture')
    for (const element of doc.querySelectorAll('*')) {
      if (/^(script|foreignobject|image|iframe|img|a|set|animate|animatetransform|animatemotion|feimage)$/i.test(element.localName)) found.push(`<${element.localName}>`)
      if (element.localName === 'style' && /@import|url\(\s*['"]?(?!#)|evil/i.test(element.textContent ?? '')) found.push('style')
      for (const attribute of element.attributes) {
        if (/^on/i.test(attribute.name)) found.push(attribute.name)
        if (/href$|^src$/i.test(attribute.name) && !attribute.value.startsWith('#')) found.push(`${attribute.name}=${attribute.value}`)
        if (/url\(\s*['"]?(?!#)|javascript:|evil\.example/i.test(attribute.value)) found.push(`${attribute.name}=${attribute.value}`)
      }
    }
    return found
  }))
  expect(planted, 'no element, handler or outside reference survives').toEqual([[], []])
  // What survives is still a picture: the words drawn, the planted parts gone.
  const [svg, mermaid] = await decodedPictures(page)
  expect(svg.src).toContain('見出し')
  expect(mermaid.src).toContain('終わり')
  // mermaid's measuring left nothing in the page.
  expect(await page.locator('body > [id^="dacb-diagram"], body > svg[id^="acb-diagram"]').count()).toBe(0)
  expectNoPageErrors(state)
})

test('a diagram that cannot be drawn stays the code it is', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { turn: 'manual' })
  await send(page, '図にして')
  await reply(page, '途中まで：\n\n```mermaid\nflowchart TD\n  A --> \n  --> --> ((\n```\n\n```svg\n<svg><rect></svg\n```\n\n以上。')
  await expect(page.getByText('flowchart TD')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('<svg><rect></svg')).toBeVisible()
  await expect(page.getByText('図を描いています…')).toHaveCount(0)
  await expect(diagrams(page)).toHaveCount(0)
  expectNoPageErrors(state)
})

test('「返事の形」 is chosen beside the model; only リッチ goes with the request, from the next message on', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { turn: 'manual' })
  const chatBodies = () => chat(page, c => c.requests.filter(r => r.path === '/api/chat').map(r => r.body?.replyStyle ?? null))
  await send(page, '一回目')
  await chat(page, c => c.finish())
  await modelSwitch(page).click()
  const menu = page.getByRole('menu', { name: 'モデルと考える強さ' })
  await expect(menu.getByRole('group', { name: '返事の形' }).getByRole('menuitemradio', { name: 'ふつう' })).toHaveAttribute('aria-checked', 'true')
  await menu.getByRole('menuitemradio', { name: 'リッチ（図も使う）' }).click()
  await expect(modelSwitch(page)).toHaveAccessibleName(/・リッチ$/)
  await send(page, '二回目')
  await chat(page, c => c.finish())
  await modelSwitch(page).click()
  await page.getByRole('menuitemradio', { name: 'ふつう' }).click()
  await expect(modelSwitch(page)).toHaveAccessibleName('モデルと考える強さ：Opus 5.5・Medium')
  await send(page, '三回目')
  expect(await chatBodies()).toEqual([null, 'rich', null])
  expectNoPageErrors(state)
})
