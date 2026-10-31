import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { ChatMarkdownImage } from './components/ChatMarkdownImage'
import { chatMarkdownSafety } from './chatMarkdownSafety'
import { isOpenableImageUrl, openRemoteImage } from './remoteImage'

// MarkdownMessage itself pulls in react-syntax-highlighter's ESM styles, which plain node
// cannot load, so this renders react-markdown with the exact safety props it spreads.
async function renderChat(content: string): Promise<string> {
  return renderToStaticMarkup(React.createElement(Markdown, {
    remarkPlugins: [...chatMarkdownSafety.remarkPlugins],
    skipHtml: chatMarkdownSafety.skipHtml,
    components: chatMarkdownSafety.components,
  }, content))
}

test('chat markdown never renders a remote image as <img>', async () => {
  const requested: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => { requested.push(String(input)); throw new Error('no network') }) as typeof fetch
  try {
    const html = await renderChat([
      '前置き ![x](https://example.com/a.png?q=secret)',
      '',
      '<img src="https://example.com/b.png">',
      '',
      '<p><img src="https://example.com/c.png"></p>',
      '',
      '![](//example.com/d.png) ![y](http://example.com/e.png)',
    ].join('\n'))
    assert.doesNotMatch(html, /<img\b/i)
    assert.doesNotMatch(html, /example\.com\/b\.png/)
    assert.doesNotMatch(html, /example\.com\/c\.png/)
    assert.match(html, /画像「x」: https:\/\/example\.com\/a\.png\?q=secret（クリックで開く）/)
    assert.match(html, /画像「y」: http:\/\/example\.com\/e\.png（クリックで開く）/)
    assert.deepEqual(requested, [])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('unsafe or local schemes are shown as text, not loaded and not openable', () => {
  for (const src of ['javascript:alert(1)', 'local-file:///etc/passwd', 'data:image/png;base64,AAAA', '', '//example.com/x.png']) {
    const html = renderToStaticMarkup(React.createElement(ChatMarkdownImage, { src, alt: 'z' }))
    assert.doesNotMatch(html, /<img\b/i, src)
    assert.doesNotMatch(html, /<button\b/i, src)
    assert.equal(isOpenableImageUrl(src), false, src)
  }
})

test('clicking asks first; only a confirmed http(s) URL reaches openExternal', async () => {
  const opened: string[] = []
  const prompts: string[] = []
  const deps = (answer: boolean) => ({
    confirm: (m: string) => { prompts.push(m); return answer },
    openExternal: async (u: string) => { opened.push(u) },
  })
  assert.equal(await openRemoteImage('https://example.com/a.png', deps(false)), false)
  assert.deepEqual(opened, [])
  assert.match(prompts[0], /https:\/\/example\.com\/a\.png/)
  assert.equal(await openRemoteImage('https://example.com/a.png', deps(true)), true)
  assert.deepEqual(opened, ['https://example.com/a.png'])
  assert.equal(await openRemoteImage('file:///etc/passwd', deps(true)), false)
  assert.deepEqual(opened, ['https://example.com/a.png'])
})
