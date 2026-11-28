// 「連絡」1枚 across a company change (shared/lib/companyEra.ts, tasks-ui.md "Working through a list"): an answer to a press
// or a read made for company A never lands on company B's screen — no words, no read, no row. Each test names what it guards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endCompanyEra } from '../../shared/lib/companyEra'
import type { ContactFinishAnswer, ContactReadResult, ContactUndoAnswer, ContactUndoRequest, ContactView } from '../../../shared/contact-card'
import { pressFinish, pressUndo, type ContactSaid } from './contactPress'
import { createContactStore } from './contactStore'

const view: ContactView = {
  interaction: { id: 'interaction-bbb222', title: 'A社 見積のご相談', state: 'handled', version: 7, assignee: 'u-me', maySettle: false },
  replyRequests: [{ id: 'reply_request-aaa111', title: '返事', state: 'open', version: 4, assignee: 'u-me', due: null, guidelineDue: null, waitUntil: null, drafts: [], may: { replied_elsewhere: true, close: true, drop: true } }],
  tasks: [],
}
const request = { interaction: { expectedVersion: 7 }, replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'replied_elsewhere' as const } }
const done: ContactFinishAnswer = {
  success: true, result: {
    interaction: { recordId: 'interaction-bbb222', outcome: 'unchanged', state: 'handled', recordVersion: 7, version: null },
    replyRequest: { recordId: 'reply_request-aaa111', outcome: 'done', state: 'closed', recordVersion: 5, version: 5 },
  },
}
/** A request whose answer the test hands back when it likes. */
function later<T>() {
  let answer!: (v: T) => void
  const promise = new Promise<T>(r => { answer = r })
  return { promise, answer }
}

test('［返した］ answered after another company was opened (or a sign-out) says nothing and reads nothing on the new screen', async () => {
  const sent = later<ContactFinishAnswer>()
  const said: ContactSaid[] = []
  let reads = 0
  const pressed = pressFinish(() => sent.promise, { request, end: 'replied_elsewhere', hadDrafts: false }, { say: s => said.push(s), reread: () => { reads += 1 } })
  endCompanyEra()
  sent.answer(done)
  await pressed
  assert.equal(said.length, 0)
  assert.equal(reads, 0)
  // In the same company the answer is shown with its ［取り消す］ and the contact read again.
  await pressFinish(async () => done, { request, end: 'replied_elsewhere', hadDrafts: false }, { say: s => said.push(s), reread: () => { reads += 1 } })
  assert.equal(said.length, 1)
  assert.deepEqual(said[0].undo, { replyRequest: { id: 'reply_request-aaa111', version: 5, expectedVersion: 5 } })
  assert.equal(reads, 1)
})

test('［取り消す］ answered after a company change says nothing on the new screen — refused or not', async () => {
  for (const answer of [
    { success: true, result: { interaction: null, replyRequest: done.success ? done.result.replyRequest : null! } },
    { success: false, offline: false, gone: false, code: 'CHANGED_SINCE', part: 'replyRequest', error: '変わりました' },
  ] as ContactUndoAnswer[]) {
    const sent = later<ContactUndoAnswer>()
    const said: ContactSaid[] = []
    const pressed = pressUndo(() => sent.promise, { replyRequest: { id: 'reply_request-aaa111', version: 5, expectedVersion: 5 } }, { say: s => said.push(s), reread: () => said.push({ text: 'read', refused: false, undo: null }) })
    endCompanyEra()
    sent.answer(answer)
    await pressed
    assert.deepEqual(said, [])
  }
})

test('a contact read for company A that answers after the company changed is never shown (its row and its card stay unread)', async () => {
  const read = later<ContactReadResult>()
  const store = createContactStore(() => read.promise)
  let told = 0
  store.subscribe(() => { told += 1 })
  store.want('co-a', ['interaction-bbb222@3'])
  endCompanyEra()
  read.answer({ success: true, contact: view })
  await read.promise
  await new Promise(r => setTimeout(r, 0))
  assert.equal(store.view('interaction-bbb222'), undefined)
  assert.equal(told, 0)
})

test('one read answers for the contact and every 返事のお願い of it, and an older answer landing later never replaces a newer one', async () => {
  const first = later<ContactReadResult>()
  const second = later<ContactReadResult>()
  const answers = [first, second]
  const store = createContactStore(() => answers.shift()!.promise)
  store.want('co-a', ['reply_request-aaa111@3'])
  store.refresh('co-a', 'reply_request-aaa111')
  second.answer({ success: true, contact: { ...view, interaction: { ...view.interaction, version: 9 } } })
  await second.promise
  first.answer({ success: true, contact: view })
  await first.promise
  await new Promise(r => setTimeout(r, 0))
  assert.equal(store.view('reply_request-aaa111')?.interaction.version, 9)
  assert.equal(store.view('interaction-bbb222')?.interaction.version, 9)
})

test('an older read through the 返事のお願い never puts back the contact as it was before the card\'s press (Codex review)', async () => {
  const older = later<ContactReadResult>()
  const newer = later<ContactReadResult>()
  const store = createContactStore((_companyId, id) => (id === 'reply_request-aaa111' ? older.promise : newer.promise))
  // The row's notices name the 返事のお願い; then the card presses and reads the contact again through its interaction.
  store.want('co-a', ['reply_request-aaa111@3'])
  store.refresh('co-a', 'interaction-bbb222')
  store.want('co-a', ['interaction-bbb222@card'])
  newer.answer({ success: true, contact: { ...view, interaction: { ...view.interaction, version: 9 } } })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(store.view('reply_request-aaa111')?.interaction.version, 9)
  older.answer({ success: true, contact: view })
  await new Promise(r => setTimeout(r, 0))
  for (const id of ['interaction-bbb222', 'reply_request-aaa111']) assert.equal(store.view(id)?.interaction.version, 9, id)
})

test('［取り消す］ that did not reach the server stays to be pressed again; a refused one does not (Codex review)', async () => {
  const undo = { replyRequest: { id: 'reply_request-aaa111', version: 5, expectedVersion: 5 } }
  const said: ContactSaid[] = []
  const deps = { say: (s: ContactSaid) => said.push(s), reread: () => {} }
  await pressUndo(async () => ({ success: false, offline: true, gone: false, code: null, part: null, error: 'つながりません' }), undo, deps)
  await pressUndo(async () => ({ success: false, offline: false, gone: false, code: 'CHANGED_SINCE', part: 'replyRequest', error: '変わりました' }), undo, deps)
  assert.deepEqual(said.map(s => s.undo), [undo, null])
})

test('a ［返した］ whose answer was lost can be sent again as it was; a refused one cannot (independent review)', async () => {
  const press = { request, end: 'replied_elsewhere' as const, hadDrafts: false }
  const said: ContactSaid[] = []
  const deps = { say: (s: ContactSaid) => said.push(s), reread: () => {} }
  await pressFinish(async () => ({ success: false, offline: true, gone: false, code: null, part: null, error: 'つながりません' }), press, deps)
  await pressFinish(async () => ({ success: false, offline: false, gone: false, code: 'VERSION_CONFLICT', part: 'interaction', error: '先に変えました' }), press, deps)
  assert.deepEqual(said.map(s => s.resend), [press, undefined])
})

test('the 「Gmail でアーカイブされたまま」 line is asked after the contact came back, at its finish entry, and shown only when the ledger says so', async () => {
  const both = { interaction: { version: 8, expectedVersion: 8 }, replyRequest: { id: 'reply_request-aaa111', version: 5, expectedVersion: 5 } }
  const back: ContactUndoAnswer = { success: true, result: {
    interaction: { recordId: 'interaction-bbb222', outcome: 'done', state: 'unsure', recordVersion: 9, version: 9 },
    replyRequest: { recordId: 'reply_request-aaa111', outcome: 'done', state: 'preparing', recordVersion: 6, version: 6 },
  } }
  const asked: number[] = []
  const run = async (stays: boolean, request: ContactUndoRequest = both, answer = back) => {
    const said: ContactSaid[] = []
    await pressUndo(async () => answer, request, { say: s => said.push(s), reread: () => {}, stillArchived: async v => { asked.push(v); return stays } })
    return said[0].text
  }
  assert.match(await run(true), /元に戻しました（返事のお願いも連絡も）。メールは Gmail でアーカイブされたままです/)
  assert.doesNotMatch(await run(false), /Gmail/)
  // Only the 返事のお願い came back (the contact was not this finish's): Gmail is not asked.
  const replyOnly: ContactUndoAnswer = { success: true, result: { interaction: null, replyRequest: back.success ? back.result.replyRequest : null! } }
  assert.doesNotMatch(await run(true, { replyRequest: both.replyRequest }, replyOnly), /Gmail/)
  assert.deepEqual(asked, [8, 8])
})
