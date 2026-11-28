// 「連絡」1枚 (inbox.md "One contact", owner decision 2026-11-28 「5番」): which buttons the card shows (only what the server's
// `may` allows), what one press sends (both records in one request), what ［取り消す］ sends (both entries), the words
// after a refusal, and where the contact goes in the inbox. Each test names what it guards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContactReplyView, ContactView } from '../../../shared/contact-card'
import { contactLook, contactPlace, finishRequestOf, refusalWords, undoRequestOf, type ContactButton } from './contactModel'

const NONE = { replied_elsewhere: false, close: false, drop: false }
const ALL = { replied_elsewhere: true, close: true, drop: true }
const reply = (over: Partial<ContactReplyView> = {}): ContactReplyView => ({
  id: 'reply_request-aaa111', title: '返事', state: 'open', version: 4, assignee: 'u-me', due: '2026-12-02', guidelineDue: null,
  waitUntil: null, drafts: [], may: ALL, ...over,
})
const contact = (replies: ContactReplyView[], tasks: ContactView['tasks'] = [], over: Partial<ContactView['interaction']> = {}): ContactView => ({
  interaction: { id: 'interaction-bbb222', title: 'A社 見積のご相談', state: 'handled', version: 7, assignee: 'u-me', maySettle: false, ...over },
  replyRequests: replies, tasks,
})
const labels = (bs: readonly (ContactButton | null)[]) => bs.map(b => b?.label ?? null)

test('the button follows the reply\'s state: 返事が要る ［返した］, 返事待ち ［済んだ（もう待たない）］, 確かめ中 ［済んだ］ — each the server\'s finishing action', () => {
  const open = contactLook(contact([reply({ state: 'open' })]))
  assert.deepEqual([open.main?.label, (open.main as Extract<ContactButton, { kind: 'finish' }>).end], ['返した', 'replied_elsewhere'])
  assert.equal(open.status.word, '返事が要る（期限 12/2）')
  const waiting = contactLook(contact([reply({ state: 'waiting_reply', waitUntil: '2026-12-05' })]))
  assert.deepEqual([waiting.main?.label, (waiting.main as Extract<ContactButton, { kind: 'finish' }>).end], ['済んだ（もう待たない）', 'close'])
  assert.equal(waiting.status.word, '返事待ち（12/5 に追いかけ）')
  const checking = contactLook(contact([reply({ state: 'checking' })]))
  assert.deepEqual([checking.main?.label, (checking.main as Extract<ContactButton, { kind: 'finish' }>).end], ['済んだ', 'close'])
  assert.equal(checking.status.word, '返事が来ました・確かめています')
})

test('only the buttons the server says the member may press are shown: none for someone else\'s reply, none the server did not allow', () => {
  // Someone else's (the server answers no `may`): read only, named when the list knows the name.
  const other = contactLook(contact([reply({ assignee: 'u-tanaka', may: NONE })]), id => (id === 'u-tanaka' ? '田中' : null))
  assert.equal(other.main, null)
  assert.deepEqual(other.menu, [])
  assert.deepEqual(other.others, ['田中さんが返します（期限 12/2）'])
  assert.equal(other.status.word, '田中さんが返します（期限 12/2）')
  // May end it but not 「もう返した」: the state's main button is not offered, the drop alone stays in 「…」.
  const onlyDrop = contactLook(contact([reply({ may: { replied_elsewhere: false, close: false, drop: true } })]))
  assert.equal(onlyDrop.main, null)
  assert.deepEqual(labels(onlyDrop.menu), ['返事は要らなくなった'])
  // 返事待ち without `close` allowed: no ［済んだ（もう待たない）］.
  const noClose = contactLook(contact([reply({ state: 'waiting_reply', may: { replied_elsewhere: true, close: false, drop: false } })]))
  assert.equal(noClose.main, null)
  assert.deepEqual(noClose.menu, [])
  // A finished one has no button at all.
  assert.equal(contactLook(contact([reply({ state: 'closed', may: NONE })])).main, null)
})

test('with a draft, ［下書きを確かめて送る］ is the main button and ［返した（下書きは送らない）］ waits in 「…」', () => {
  const look = contactLook(contact([reply({ drafts: [{ id: 'outbound_message-ccc333', version: 2 }] })]))
  assert.deepEqual(look.main, { kind: 'checkDraft', draftId: 'outbound_message-ccc333', label: '下書きを確かめて送る', hint: '宛先と中身を確かめてから送ります' })
  assert.deepEqual(labels(look.menu), ['返した（下書きは送らない）', '返事は要らなくなった'])
  assert.match(look.menu[0].hint ?? '', /下書きは送らずに片づけます（取り消すと戻ります）/)
  assert.equal(look.status.word, '下書きがあります（期限 12/2）')
})

test('one press sends both parts at the versions the card read; ［取り消す］ sends both entries back', () => {
  const view = contact([reply()])
  const main = contactLook(view).main as Extract<ContactButton, { kind: 'finish' }>
  assert.deepEqual(finishRequestOf(view, main), {
    interaction: { expectedVersion: 7 },
    replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'replied_elsewhere' },
  })
  const drop = contactLook(view).menu.find(b => b.kind === 'finish' && b.end === 'drop') as Extract<ContactButton, { kind: 'finish' }>
  assert.equal(drop.asksReason, true)
  assert.equal(finishRequestOf(view, drop, '  電話で話がつきました ')?.replyRequest.note, '電話で話がつきました')
  // Both parts written: both entries taken back, each at the record's version now.
  assert.deepEqual(undoRequestOf({
    interaction: { recordId: 'interaction-bbb222', outcome: 'done', state: 'handled', recordVersion: 8, version: 8 },
    replyRequest: { recordId: 'reply_request-aaa111', outcome: 'done', state: 'closed', recordVersion: 5, version: 5 },
  }), { interaction: { version: 8, expectedVersion: 8 }, replyRequest: { id: 'reply_request-aaa111', version: 5, expectedVersion: 5 } })
  // The contact was over already (`unchanged`): only the 返事のお願い is taken back.
  assert.deepEqual(undoRequestOf({
    interaction: { recordId: 'interaction-bbb222', outcome: 'unchanged', state: 'handled', recordVersion: 7, version: null },
    replyRequest: { recordId: 'reply_request-aaa111', outcome: 'done', state: 'closed', recordVersion: 5, version: 5 },
  }), { replyRequest: { id: 'reply_request-aaa111', version: 5, expectedVersion: 5 } })
})

test('a refusal says nothing changed (both or neither), in the member\'s words; offline says to check what is shown', () => {
  const refused = (code: string | null, extra: Partial<{ offline: boolean; gone: boolean; error: string }> = {}) =>
    ({ success: false as const, offline: false, gone: false, code, part: 'interaction' as const, error: 'サーバーの言葉です。', ...extra })
  assert.match(refusalWords(refused('VERSION_CONFLICT'), 'finish'), /先に変えたため、どちらも変えていません/)
  assert.match(refusalWords(refused('CHANGED_SINCE'), 'undo'), /取り消せませんでした（どちらもそのままです）/)
  assert.match(refusalWords(refused('NOT_THIS_CONTACT'), 'finish'), /この連絡のものではなくなりました/)
  assert.equal(refusalWords(refused('FEATURE_OFF'), 'finish'), 'サーバーの言葉です。どちらも変えていません')
  assert.match(refusalWords(refused(null, { offline: true, error: 'つながりません' }), 'finish'), /届いたかどうかは/)
  assert.equal(refusalWords(refused(null, { gone: true }), 'finish'), 'この連絡は、もう見られません')
})

test('a contact whose reply is over but a やること is left goes to 「確認したもの」 and says how many are left', () => {
  const tasks = [
    { id: 'task-ddd444', title: '経費を承認する', state: 'todo', version: 2, assignee: 'u-me' },
    { id: 'task-eee555', title: '資料を送る', state: 'done', version: 3, assignee: 'u-me' },
  ]
  const over = contact([reply({ state: 'closed', may: NONE })], tasks)
  assert.equal(contactPlace(over), 'seen')
  assert.equal(contactLook(over).leftWork, '返事は済みました・やることが 1 件残っています')
  assert.equal(contactLook(over).status.word, '返事は済みました・やることが 1 件残っています')
  // Still replying, or nothing left to do, or never a reply: where its notices put it.
  assert.equal(contactPlace(contact([reply()], tasks)), null)
  assert.equal(contactPlace(contact([reply({ state: 'closed', may: NONE })], [tasks[1]])), null)
  assert.equal(contactPlace(contact([], tasks)), null)
})
