// The cleaning of a rich reply's HTML (chat-ui-and-history.md "Rich replies": `sanitizeReplyHtml`), in Chromium:
// it needs the browser's HTML and CSS parsers. The text is the AI's, which may have read a planted instruction, so
// what comes out must run nothing, load nothing, send nothing, cover nothing and not move for ever — on its own,
// without the closed frame the chat adds (PR2): here the cleaned reply is drawn in a frame that WOULD let scripts
// run and requests leave, and the same frame with the reply as written shows that the checks can fail.
// The audit (`audit` below) restates the allowlist independently of the cleaner's own lists.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'
import { ALL_TRAPS, CORNER_TRAPS, GOOD_REPLY, REVIEW_TRAPS, SEAMLESS_TRAPS, TRAPS } from './fixtures/reply-html-traps'

type Clean = { html: string; css: string }
type PageGlobals = { __pwned?: unknown[] }

const open = (page: Page) => openPreview(page, 'chat-reply-cleaning')
const clean = (page: Page, markup: string): Promise<Clean> =>
  page.evaluate(text => window.__acbReplyCleaning!.sanitizeReplyHtml(text), markup)

/**
 * Cleans each markup (and, with `step`, every piece of it cut every `step` characters, as a reply is while it is
 * written) and lists what in the result breaks the allowlist, or changes when cleaned again.
 */
async function audit(page: Page, markups: string[], step = 0): Promise<string[]> {
  return page.evaluate(({ markups, step }) => {
    const sanitize = window.__acbReplyCleaning!.sanitizeReplyHtml
    const ELEMENTS = new Set(['div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i',
      'u', 's', 'small', 'mark', 'sub', 'sup', 'code', 'pre', 'kbd', 'q', 'abbr', 'time', 'blockquote', 'ul', 'ol', 'li',
      'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'figure',
      'figcaption', 'section', 'article', 'header', 'footer', 'aside', 'main', 'details', 'summary', 'img', 'input', 'label', 'a'])
    const ATTRIBUTES = new Set(['class', 'style', 'title', 'lang', 'dir', 'role', 'aria-label', 'aria-hidden', 'src', 'alt',
      'width', 'height', 'colspan', 'rowspan', 'scope', 'span', 'start', 'reversed', 'type', 'open', 'datetime', 'name',
      'id', 'checked', 'value', 'for', 'href'])
    const BAD_CSS = /url\s*\(|@import|@font-face|@layer|image-set|cross-fade|attr\s*\(|\\|<|position\s*:\s*(?:fixed|sticky)|infinite|\d[dsl]?v(?:h|w|min|max)\b|\dcq(?:w|h|i|b|min|max)\b|:root|:scope|(?:^|[\n,}])\s*&|:host|\bhtml\b|\bbody\b|evil\.example/i
    const seconds = (time: string) => { const m = /^([\d.]+)(ms|s)$/.exec(time.trim()); return m ? Number(m[1]) / (m[2] === 'ms' ? 1000 : 1) : Infinity }
    function motion(css: string): string[] {
      const found: string[] = []
      for (const m of css.matchAll(/animation-iteration-count:\s*([^;}]+)/g)) if (m[1].split(',').some(v => !(Number(v) <= 10))) found.push(`runs ${m[1]}`)
      for (const m of css.matchAll(/(?:animation|transition)-(?:duration|delay):\s*([^;}]+)/g)) if (m[1].split(',').some(v => Math.abs(seconds(v.replace(/^-/, ''))) > 10)) found.push(`long ${m[1]}`)
      for (const m of css.matchAll(/animation-name:\s*([^;}]+)/g)) if (m[1].split(',').length > 3) found.push(`many ${m[1]}`)
      return found
    }
    function picture(src: string): string[] {
      const svg = new DOMParser().parseFromString(decodeURIComponent(src.replace('data:image/svg+xml;charset=utf-8,', '')), 'image/svg+xml')
      const found: string[] = []
      if (svg.querySelector('parsererror')) found.push('picture: not a picture')
      for (const el of svg.querySelectorAll('*')) {
        if (/^(script|foreignobject|image|a|iframe|img|set|animate)$/i.test(el.localName)) found.push(`picture: <${el.localName}>`)
        if (el.localName === 'style' && /@import|url\(\s*['"]?(?!#)|evil/i.test(el.textContent ?? '')) found.push('picture: style')
        // A picture in a reply does not move (CSS motion in an SVG image runs; SMIL is not kept).
        if (el.localName === 'style' && /animation|transition|@keyframes/i.test(el.textContent ?? '')) found.push('picture: motion')
        for (const a of el.attributes) {
          if (/^on/i.test(a.name) || /evil|javascript:/i.test(a.value)) found.push(`picture: ${a.name}`)
          if (/animation|transition/i.test(`${a.name}:${a.value}`) && a.name !== 'class') found.push(`picture: motion ${a.name}`)
        }
      }
      return found
    }
    const PROPERTIES = ['color', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
      'background-clip', 'background-origin', 'opacity', 'border', 'outline', 'box-shadow', 'box-sizing', 'margin', 'padding', 'width',
      'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio', 'display', 'flex', 'grid', 'gap', 'row-gap',
      'column-gap', 'align', 'justify', 'place', 'order', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'overflow',
      'transform', 'vertical-align', 'float', 'clear', 'object-fit', 'object-position', 'font-size', 'font-weight', 'font-style',
      'font-family', 'font-variant', 'font-feature-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text', 'white-space',
      'word-break', 'overflow-wrap', 'hyphens', 'list-style-type', 'list-style-position', 'counter-reset', 'counter-increment',
      'content', 'caption-side', 'table-layout', 'empty-cells', 'color-scheme', 'accent-color', 'fill', 'stroke', 'stroke-width',
      'animation', 'transition']
    const listed = (name: string) => /^--[A-Za-z0-9_-]+$/.test(name) || PROPERTIES.some(base => name === base || name.startsWith(`${base}-`))
    // The CSS read back by the browser: only listed properties, only the kept kinds of rule.
    function properties(css: string, inline: boolean): string[] {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(inline ? `x { ${css} }` : css)
      const found: string[] = []
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule || rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || rule instanceof CSSKeyframesRule || rule instanceof CSSKeyframeRule)) found.push(`rule ${rule.constructor.name}`)
          if ('style' in rule) for (const name of Array.from((rule as CSSStyleRule).style)) if (!listed(name)) found.push(`property ${name}`)
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
        }
      }
      walk(sheet.cssRules)
      return found
    }
    // CSS the frame puts after the reply's own (PR2's guards) still reads as its own rule: nothing is left open.
    function closed(css: string, inline: boolean): string[] {
      const sheet = new CSSStyleSheet()
      if (inline) {
        sheet.replaceSync(`x { ${css}; --acb-after: 1 }`)
        return (sheet.cssRules[0] as CSSStyleRule | undefined)?.style.getPropertyValue('--acb-after').trim() === '1' ? [] : ['style left open']
      }
      sheet.replaceSync(`${css}\n.acb-after { color: red }`)
      return (sheet.cssRules[sheet.cssRules.length - 1] as CSSStyleRule | undefined)?.selectorText === '.acb-after' ? [] : ['css left open']
    }
    function check({ html, css }: { html: string; css: string }): string[] {
      const found: string[] = [...properties(css, false), ...closed(css, false)]
      const bad = BAD_CSS.exec(css)
      if (bad) found.push(`css: ${bad[0]}`)
      found.push(...motion(css))
      // Read as the frame will read it.
      const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
      if (doc.head.childNodes.length) found.push('something in the head')
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT)
      if (walker.nextNode()) found.push('a comment')
      for (const el of doc.body.querySelectorAll('*')) {
        if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') found.push(`namespace ${el.localName}`)
        if (!ELEMENTS.has(el.localName)) found.push(`<${el.localName}>`)
        if (el.localName === 'input' && !['radio', 'checkbox'].includes(el.getAttribute('type') ?? '')) found.push(`input ${el.getAttribute('type')}`)
        for (const a of el.attributes) {
          const value = a.value
          if (/^on/i.test(a.name) || !ATTRIBUTES.has(a.name)) found.push(`@${a.name}`)
          if (a.name === 'href' && (el.localName !== 'a' || !/^https?:\/\/[^/]/.test(value) || /^https?:\/\/[^/]*@/.test(value))) found.push(`href=${value}`)
          if (a.name === 'src') {
            if (el.localName !== 'img') found.push('src on another element')
            else if (value.startsWith('data:image/svg+xml;charset=utf-8,')) found.push(...picture(value))
            else if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) found.push(`src=${value.slice(0, 40)}`)
          }
          if (a.name !== 'href' && a.name !== 'src' && /evil\.example|javascript:/i.test(value)) found.push(`${a.name}=${value}`)
          if (a.name === 'style') {
            const style = BAD_CSS.exec(value)
            if (style) found.push(`style: ${style[0]}`)
            found.push(...properties(value, true), ...closed(value, true))
            found.push(...motion(value))
          }
        }
      }
      return found
    }
    const problems: string[] = []
    for (const markup of markups) {
      const cuts = step ? Array.from({ length: Math.ceil(markup.length / step) + 1 }, (_, i) => Math.min(i * step, markup.length)) : [markup.length]
      for (const cut of cuts) {
        const piece = markup.slice(0, cut)
        const cleaned = sanitize(piece)
        for (const found of check(cleaned)) problems.push(`[${cut}] ${found}`)
        // Read again (as the frame does), it says the same: nothing in it changes meaning on a second reading.
        if (sanitize(cleaned.html).html !== cleaned.html) problems.push(`[${cut}] changes when cleaned again`)
      }
    }
    return [...new Set(problems)]
  }, { markups, step })
}

/** Every request that would leave for anywhere but the preview server (kept from the network and recorded). */
async function outsideRequests(page: Page): Promise<string[]> {
  const seen: string[] = []
  await page.route(url => !['data:', 'blob:', 'about:'].includes(url.protocol) && url.hostname !== '127.0.0.1', route => {
    seen.push(route.request().url())
    return route.abort()
  })
  return seen
}

/**
 * Draws `html` + `css` in a frame of the page that lets everything run (no sandbox, no CSP: only the cleaning
 * protects it), presses, hovers and checks everything in it, tabs through it, and reports what happened. A press
 * on a web link is held back, as the chat's frame will (PR2); javascript: and every other link is left to the browser.
 */
async function drawOpen(page: Page, { html, css }: Clean) {
  await page.evaluate(({ html, css }) => new Promise<void>(resolve => {
    (window as unknown as PageGlobals).__pwned = []
    document.getElementById('reply')?.remove()
    const frame = document.createElement('iframe')
    frame.id = 'reply'
    frame.style.cssText = 'width: 900px; height: 700px; border: 0'
    frame.onload = () => {
      frame.contentDocument!.addEventListener('click', event => {
        const link = (event.target as Element).closest?.('a[href]')
        if (link && /^https?:/i.test(link.getAttribute('href') ?? '')) event.preventDefault()
      }, true)
      resolve()
    }
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`
    document.body.append(frame)
  }), { html, css })
  const frame = page.frameLocator('#reply')
  const covering: string[] = []
  const elements = await frame.locator('body *').all()
  for (const element of elements) {
    await element.hover({ force: true, timeout: 300 }).catch(() => {})
    await element.click({ force: true, timeout: 300 }).catch(() => {})
    const position = await element.evaluate(el => [getComputedStyle(el).position, getComputedStyle(el, '::after').position, getComputedStyle(el, '::before').position].join(' ')).catch(() => '')
    if (/fixed|sticky/.test(position)) covering.push(position)
  }
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
  await page.waitForTimeout(800)
  const state = await page.evaluate(() => {
    const doc = (document.getElementById('reply') as HTMLIFrameElement | null)?.contentDocument
    const all = doc ? [...doc.querySelectorAll('*')] : []
    return {
      pwned: (window as unknown as PageGlobals).__pwned ?? [],
      // The frame left the reply (a refresh, a link that navigated it).
      leftTheReply: !doc || doc.location.href !== 'about:srcdoc',
      fixed: all.filter(el => /fixed|sticky/.test(getComputedStyle(el).position)).length,
      endless: (doc?.getAnimations() ?? []).filter(a => {
        const timing = a.effect?.getComputedTiming()
        return !timing || !(Number(timing.iterations) <= 10) || !(Number(timing.duration) <= 10_000)
      }).length,
    }
  })
  return { ...state, fixed: state.fixed + covering.length }
}

test('a reply as the AI writes it keeps its look and its parts that move without a script', async ({ page }) => {
  const state = await open(page)
  const { html, css } = await clean(page, GOOD_REPLY)
  for (const kept of ['<h3>経費の精算</h3>', '<div class="acb-key"><strong>要点</strong>', '<table class="acb-compare">', '<td colspan="1">',
    '<details open="">', '<input type="radio" name="m" id="m1" checked="">', '<label for="m1">今月</label>',
    '<label><input type="checkbox" checked=""> 確かめた</label>', '<a href="https://example.com/guide?q=1">案内のページ</a>',
    'src="data:image/png;base64,', 'style="width: 45%"', 'alt="売上の図"', 'src="data:image/svg+xml;charset=utf-8,']) {
    expect(html, kept).toContain(kept)
  }
  for (const kept of ['.acb-key {', 'var(--color-text)', '#m1:checked ~ .acb-tab:nth-of-type(1)', '@keyframes grow',
    'animation-iteration-count: 1', 'animation-duration: 0.6s', 'transition-duration: 0.3s', '@media (prefers-color-scheme: dark)']) {
    expect(css, kept).toContain(kept)
  }
  expect(await audit(page, [GOOD_REPLY])).toEqual([])
  expectNoPageErrors(state)
})

test('no planted part survives the cleaning: nothing that runs, loads, sends, covers the app or moves for ever', async ({ page }) => {
  const state = await open(page)
  expect(await audit(page, [TRAPS, SEAMLESS_TRAPS, REVIEW_TRAPS, CORNER_TRAPS, ALL_TRAPS])).toEqual([])
  const { html, css } = await clean(page, ALL_TRAPS)
  // What is not allowed keeps its words, never itself.
  for (const words of ['人をあざむくリンク', 'パスワードつきのリンク', '名前のわな', 'javascript: のリンク', 'data: のリンク', '大文字小文字のリンク', 'タブを挟んだリンク', 'ファイルのリンク', 'スキームなしのリンク', '流れ続ける文字', 'チェックで画面を覆う']) {
    expect(html, words).toContain(words)
  }
  expect(html).toContain('<a href="https://evil.example/link">外へのリンク</a>')
  // The newly allowed inputs: radio and checkbox only, with nothing that sends or runs.
  expect(html).toMatch(/<input type="checkbox" id="trap-check"( style="[^"<>]*")?>/)
  expect(html).toContain('<label for="trap-check" class="trapbox">')
  expect(html).toContain('<input type="radio" name="ok" id="r1">')
  expect(html).toContain('<input type="checkbox" checked="">')
  expect(html).toContain('<input type="radio">')
  expect(html).not.toMatch(/<input(?![^>]*type="(?:radio|checkbox)")/)
  // A link is a web link or no link: never one that goes nowhere or somewhere else.
  expect(html).not.toMatch(/<a(?=[\s>])(?![^>]*\shref="https?:\/\/)/)
  // What was removed with its contents shows nothing of it (a script's or a style's text is not words to read).
  // <plaintext> (last) turns the rest of its piece into words by the parser's own rule, so it is left out here.
  const removed = await clean(page, ALL_TRAPS.replace(/<plaintext>[\s\S]*$/, ''))
  expect(removed.html).not.toMatch(/__pwned|@import|evil\.example\/(?!link")/)
  // The motion that was allowed stops; the rules around it stay what they were.
  expect(css).toContain('@keyframes evil')
  expect(css).not.toMatch(/\.anim \{[^}]*iteration/)
  expect(css).toContain('.hovertrap:hover')
  expectNoPageErrors(state)
})

test('the cleaned reply runs nothing, reaches nothing and covers nothing even in a frame that would let it', async ({ page }) => {
  const outside = await outsideRequests(page)
  const state = await open(page)
  const result = await drawOpen(page, await clean(page, ALL_TRAPS))
  expect(result.pwned, 'nothing in the reply ran').toEqual([])
  expect(outside, 'no request left the app').toEqual([])
  expect(result.leftTheReply, 'the frame still shows the reply').toBe(false)
  expect(result.fixed, 'nothing is fixed over the app').toBe(0)
  expect(result.endless, 'no motion goes on for ever').toBe(0)
  await expect(page.frameLocator('#reply').getByText('角のわな')).toBeVisible()
  expectNoPageErrors(state)
})

test('the same frame with the reply as written does run, load, cover and loop: the checks above can fail', async ({ page }) => {
  const outside = await outsideRequests(page)
  await open(page)
  const result = await drawOpen(page, { html: ALL_TRAPS.replace(/<plaintext>[\s\S]*$/, '').replace(/<meta[^>]*>/, ''), css: '' })
  expect(result.pwned.length).toBeGreaterThan(0)
  expect(outside.length).toBeGreaterThan(0)
  expect(result.fixed).toBeGreaterThan(0)
  expect(result.endless).toBeGreaterThan(0)
  const navigated = await drawOpen(page, { html: TRAPS, css: '' })
  expect(navigated.leftTheReply, 'a planted refresh moves the frame away').toBe(true)
})

test('a reply cut anywhere while it is still being written is cleaned just as safely', async ({ page }) => {
  const state = await open(page)
  expect(await audit(page, [ALL_TRAPS, GOOD_REPLY], 3)).toEqual([])
  // Cut inside an attribute, a CSS rule, a comment, a <style>, a picture: what is shown so far is still clean.
  const cuts = ['<p><a href="javascript:al', '<img src="https://evil.example/x.png', '<style>.a { background: url(https://evil.example/u',
    '<style>.a { position: fixed; inset: 0', '<!-- <img src=x onerror=alert(1)>', '<svg viewBox="0 0 9 9" onload="alert(1)"><image href="https://evil.example/s',
    '<p style="background: url(https://evil.example/p', '<div class="a"><input type="text" value="', '<table><tr><td>表<script>alert(', '<style>@import url(https://evil.example/i.css']
  expect(await audit(page, cuts)).toEqual([])
  expect((await clean(page, cuts[0])).html).toBe('<p></p>')
  expectNoPageErrors(state)
})
