// The 元のスレッド's Slack text (owner FB 2026-11-04: `*bold*` showed its stars). Protects: Slack's
// `*bold*` is drawn bold, and nothing in a message's text is ever drawn as HTML — a tag, an
// attribute or an entity in it stays literal text, bold or not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chatTextRuns } from '../../../shared/threads'
import { ChatText } from './components/RecordThreadPanel'

const html = (text: string) => renderToStaticMarkup(React.createElement(ChatText, { text }))

test('Slack\'s *bold* is drawn bold; stars with a space inside or across lines stay as they are', () => {
  assert.deepEqual(chatTextRuns('明日の*14時*からです'), [
    { text: '明日の', bold: false }, { text: '14時', bold: true }, { text: 'からです', bold: false },
  ])
  assert.equal(html('*至急* 確認ください'), '<strong class="font-semibold">至急</strong><span> 確認ください</span>')
  assert.deepEqual(chatTextRuns('2 * 3 * 4'), [{ text: '2 * 3 * 4', bold: false }])
  assert.deepEqual(chatTextRuns('*一行目\n二行目*'), [{ text: '*一行目\n二行目*', bold: false }])
})

test('a message\'s text is never HTML: tags, attributes and entities stay literal, also inside bold', () => {
  const out = html('<img src=x onerror="alert(1)"> *<script>alert(2)</script>* &amp; <b>x</b>')
  assert.ok(!/<img|<script|<b>/.test(out), out)
  assert.ok(out.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), out)
  assert.ok(out.includes('<strong class="font-semibold">&lt;script&gt;alert(2)&lt;/script&gt;</strong>'), out)
  assert.ok(out.includes('&amp;amp; &lt;b&gt;x&lt;/b&gt;'), out)
})
