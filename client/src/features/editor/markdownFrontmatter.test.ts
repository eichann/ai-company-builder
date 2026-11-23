// A SKILL.md's `---` block is data for the AI: the preview shows a quiet box with its name and
// description instead of rendering it as a bold underlined heading (owner 2026-11-23).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { previewFrontmatter } from './markdownFrontmatter'
import { MarkdownPreview } from './components/MarkdownPreview'

const SKILL = '---\nname: proposal\ndescription: "提案書を作る。\\n顧客ごとに"\nallowed-tools: Read\n---\n\n# 提案書の作り方\n\n本文'

test('the block is taken out of the text and its name and description kept', () => {
  assert.deepEqual(previewFrontmatter(SKILL), {
    info: { name: 'proposal', description: '提案書を作る。\n顧客ごとに' },
    body: '\n# 提案書の作り方\n\n本文',
  })
  // A block without either: hidden, no box.
  assert.deepEqual(previewFrontmatter('---\nid: task-1\ntype: task\n---\n本文'), { info: null, body: '本文' })
  // No block, or one never closed: the text as it is.
  assert.deepEqual(previewFrontmatter('# 見出し\n\n---\n\n下'), { info: null, body: '# 見出し\n\n---\n\n下' })
  assert.deepEqual(previewFrontmatter('---\nname: x\n本文'), { info: null, body: '---\nname: x\n本文' })
})

test('the preview draws the box and never the block as a heading', () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownPreview, { content: SKILL, basePath: '/c', paneId: 'p' }))
  assert.match(html, /data-frontmatter="true"[^>]*>.*proposal.*提案書を作る。/s)
  assert.doesNotMatch(html, /<h2>/, 'a setext heading is what the block became before')
  assert.doesNotMatch(html, /allowed-tools/)
  assert.match(html, /<h1>提案書の作り方<\/h1>/)
})
