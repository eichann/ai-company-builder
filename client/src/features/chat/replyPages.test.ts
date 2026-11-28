// Guards the one way a rich reply becomes a page (chat-ui-and-history.md "Rich replies: ［大きく見る］…"): every button
// goes through `keepReplyPage`, so a half-written reply is never kept and presses never make a second copy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepReplyPage, type ReplyPages } from './replyPages'
import type { ReplyPageSaveResult } from '../../../shared/reply-pages'

function folder(scope: string) {
  const saved: string[] = []
  const onDisk = new Set<string>()
  let hold: Promise<void> = Promise.resolve()
  const pages: ReplyPages = {
    scope: () => scope,
    save: async (html): Promise<ReplyPageSaveResult> => {
      saved.push(html)
      await hold
      const path = `/会社/営業部/.personal/ページ/AI の返事 (${saved.length}).html`
      onDisk.add(path)
      return { success: true, path, name: path.slice(path.lastIndexOf('/') + 1) }
    },
    stillThere: async path => onDisk.has(path),
  }
  return { pages, saved, onDisk, holdSaves: (until: Promise<void>) => { hold = until } }
}

test('a reply still being written is never kept as a page', async () => {
  const { pages, saved } = folder('c-writing')
  const outcome = await keepReplyPage(pages, '表です。', true, () => '<!doctype html>書きかけ')
  assert.equal(outcome.kind, 'skipped')
  assert.deepEqual(saved, [])
})

test('presses while the reply is being kept keep nothing more: one page per reply, the same one after', async () => {
  const { pages, saved, holdSaves } = folder('c-presses')
  let release = () => {}
  holdSaves(new Promise<void>(resolve => { release = resolve }))
  const first = keepReplyPage(pages, '長い返事', false, () => '<!doctype html>1')
  const pressedAgain = keepReplyPage(pages, '長い返事', false, () => '<!doctype html>2')
  release()
  const [kept, again] = await Promise.all([first, pressedAgain])
  assert.equal(again.kind, 'skipped', 'a second press while the first keeps')
  assert.equal(kept.kind, 'kept')
  assert.equal(saved.length, 1)
  const later = await keepReplyPage(pages, '長い返事', false, () => '<!doctype html>3')
  assert.deepEqual(later, kept, 'pressed after it was kept: the same file')
  assert.equal(saved.length, 1)
  // Another reply is its own page, kept even while this one would be.
  assert.equal((await keepReplyPage(pages, '別の返事', false, () => '<!doctype html>4')).kind, 'kept')
})

test('a page the member deleted is kept again; a refusal is said and the next press tries again', async () => {
  const { pages, saved, onDisk } = folder('c-gone')
  const kept = await keepReplyPage(pages, '返事', false, () => 'x')
  onDisk.clear()
  const again = await keepReplyPage(pages, '返事', false, () => 'x')
  assert.ok(kept.kind === 'kept' && again.kind === 'kept' && again.page.path !== kept.page.path)
  assert.equal(saved.length, 2)
  const refusing: ReplyPages = { ...pages, scope: () => 'c-refused', save: async () => ({ success: false, error: 'ページを置く今日のフォルダが見つかりません。' }) }
  assert.deepEqual(await keepReplyPage(refusing, '返事', false, () => 'x'), { kind: 'failed', error: 'ページを置く今日のフォルダが見つかりません。' })
  assert.equal((await keepReplyPage({ ...refusing, save: pages.save }, '返事', false, () => 'x')).kind, 'kept')
})
