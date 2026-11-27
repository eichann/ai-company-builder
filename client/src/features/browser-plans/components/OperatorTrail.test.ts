// The operator's trail on the person's card (agent-browser.md "The operator's trail on the card"): its words are outside
// text written by an AI that reads pages, so they stay collapsed behind 「係の AI のメモを見る」, under the label that says
// it is the operator's memo and not a checked fact, and render as plain text — never markup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BROWSER_ANSWER_PROBLEM_WORDS, BROWSER_TRAIL_WORDS as W, type BrowserOperatorTrail } from '../../../../shared/browser-operator-trail'
import { InspectionBody } from './BrowserInspectionCard'

const TRAIL: BrowserOperatorTrail = [{
  phase: 'preview',
  steps: [{ action: 'click', page: '/events', label: '検索する', reason: '<img src=x onerror=alert(1)> 一覧を絞るため' }],
  more: 0,
  end: { kind: 'stop', reason: '確認の画面で、どちらの回か決められないため' },
  notes: '<b>2ページ目</b>まで見た',
}]

const card = { title: '下見', state: 'not_read' as const, headline: '下見の途中で止まりました。', sections: [], checks: [], notes: [] }

test('the card shows the operator\'s memo collapsed, labelled as its own words, as plain text only', () => {
  const html = renderToStaticMarkup(React.createElement(InspectionBody, { view: { card, readAt: '2026-11-27T00:00:00.000Z', siteLabel: 'shop.example.test', trail: TRAIL } }))
  const [shown, memo] = html.split('<details')
  assert.ok(memo, 'the memo is behind a disclosure')
  // Collapsed by default: no `open` on the disclosure.
  assert.doesNotMatch(memo.slice(0, memo.indexOf('>')), /\bopen\b/)
  assert.match(memo, new RegExp(`<summary[^>]*>${W.open}</summary>`))
  assert.ok(memo.includes(W.heading))
  // Nothing the operator wrote stands before the disclosure; the fixed headline does.
  for (const words of ['一覧を絞るため', 'どちらの回か', '2ページ目']) assert.equal(shown.includes(words), false, words)
  assert.ok(shown.includes('下見の途中で止まりました。'))
  // Its words are text: markup arrives escaped, never as elements.
  assert.equal(memo.includes('<img'), false)
  assert.equal(memo.includes('<b>'), false)
  assert.ok(memo.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(memo.includes(`${W.stopReason}：確認の画面で、どちらの回か決められないため`))
  assert.ok(memo.includes('押した「検索する」'))
})

test('a run the app ended on an answer out of form names the rule it broke, in the app\'s fixed words', () => {
  const ended: BrowserOperatorTrail = [{ phase: 'preview', steps: [], more: 0, end: null, notes: null, problem: 'plan-unread' }]
  const html = renderToStaticMarkup(React.createElement(InspectionBody, { view: { card, readAt: '2026-11-27T00:00:00.000Z', siteLabel: 'shop.example.test', trail: ended } }))
  assert.ok(html.includes(W.problem(BROWSER_ANSWER_PROBLEM_WORDS['plan-unread'])))
  assert.equal(html.includes(W.appEnded), false)
})

test('a card without a trail shows no memo', () => {
  const html = renderToStaticMarkup(React.createElement(InspectionBody, { view: { card, readAt: '2026-11-27T00:00:00.000Z', siteLabel: 'shop.example.test' } }))
  assert.equal(html.includes('<details'), false)
})
