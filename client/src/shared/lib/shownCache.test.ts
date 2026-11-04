// A view mounted again shows what it showed last (owner FB #14) — but never another company's,
// never a record read as gone, never after sign-out, and memory stays bounded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShownCache, forgetAllShown, settleShown } from './shownCache'

type Card = { success: true; title: string } | { success: false; notFound?: boolean; error: string }
const card = (title: string): Card => ({ success: true, title })
const offline: Card = { success: false, error: '表示できませんでした。' }
const gone: Card = { success: false, notFound: true, error: '見つかりません。' }

test('a card shown before comes back for its company and key; a newer answer replaces it', () => {
  const cache = createShownCache<Card>()
  assert.equal(cache.shown('c1', 'task-1'), undefined)
  cache.remember('c1', 'task-1', card('v1'))
  assert.deepEqual(cache.shown('c1', 'task-1'), card('v1'))
  assert.equal(cache.shown('c1', 'task-2'), undefined)
  cache.remember('c1', 'task-1', card('v2'))
  assert.deepEqual(cache.shown('c1', 'task-1'), card('v2'))
})

test('a card read as gone (no longer readable) is forgotten; an offline failure keeps the shown one', () => {
  const cache = createShownCache<Card>()
  cache.remember('c1', 'task-1', card('v1'))
  cache.remember('c1', 'task-1', offline)
  assert.deepEqual(cache.shown('c1', 'task-1'), card('v1'))
  cache.remember('c1', 'task-1', gone)
  assert.equal(cache.shown('c1', 'task-1'), undefined)
  // What the view puts on screen: gone replaces the card, offline does not.
  assert.equal(settleShown(card('v1'), gone), gone)
  assert.deepEqual(settleShown(card('v1'), offline), card('v1'))
  assert.equal(settleShown(null, offline), offline)
})

test('another company never sees what one company showed, even when it comes back', () => {
  const cache = createShownCache<Card>()
  cache.remember('c1', 'task-1', card('secret'))
  assert.equal(cache.shown('c2', 'task-1'), undefined)
  assert.equal(cache.shown('c1', 'task-1'), undefined)
})

test('sign-out and a company switch forget every view\'s cache', () => {
  const tasks = createShownCache<Card>()
  const records = createShownCache<Card>()
  tasks.remember('c1', 'task-1', card('a'))
  records.remember('c1', 'decision-1', card('b'))
  forgetAllShown()
  assert.equal(tasks.shown('c1', 'task-1'), undefined)
  assert.equal(records.shown('c1', 'decision-1'), undefined)
})

test('memory stays bounded: the least recently shown goes first', () => {
  const cache = createShownCache<Card>(3)
  for (const k of ['a', 'b', 'c']) cache.remember('c1', k, card(k))
  cache.shown('c1', 'a')
  cache.remember('c1', 'd', card('d'))
  assert.equal(cache.shown('c1', 'b'), undefined)
  for (const k of ['a', 'c', 'd']) assert.deepEqual(cache.shown('c1', k), card(k))
})
