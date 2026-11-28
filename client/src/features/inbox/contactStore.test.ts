// A contact no longer the member's to read (inbox.md "One contact in the app", Codex review of UX stage 2): its title is
// shown by none of its ids — not through a 返事のお願い read before, not by a read already on its way, not in a row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NotificationItem } from '../../../../shared/types/notifications'
import type { NoticesState } from '../../../shared/notifications-app'
import type { ContactReadResult, ContactView } from '../../../shared/contact-card'
import { createContactStore, shownView } from './contactStore'
import { inboxView, INBOX_NEWS_SINCE } from './model'

const SECRET = 'B社 役員人事の件（この人たちだけ）'
const I = 'interaction-aaa111'
const R = 'reply_request-bbb222'
const view: ContactView = {
  interaction: { id: I, title: SECRET, state: 'handled', version: 3, assignee: 'u-me', maySettle: false },
  replyRequests: [{ id: R, title: '返事', state: 'open', version: 2, assignee: 'u-me', due: null, guidelineDue: null, waitUntil: null, drafts: [], may: { replied_elsewhere: true, close: true, drop: true } }],
  tasks: [],
}
const GONE: ContactReadResult = { success: false, gone: true }
const settle = () => new Promise(r => setTimeout(r, 0))
function later<T>() {
  let answer!: (v: T) => void
  const promise = new Promise<T>(r => { answer = r })
  return { promise, answer }
}
/** The server's notice about R, after the member lost I (it still lists R's own notice with the server's own title). */
const noticeAboutR: NotificationItem = {
  id: 'n1', kind: 'reply_arrived', recordId: R, recordType: 'reply_request', recordTitle: '返事', version: 2,
  text: '返事が来ました', createdAt: '2026-11-27T01:00:00Z', read: false,
}
const notices: NoticesState = { available: true, myTurn: { total: 0, items: [] }, notices: { available: true, unread: 1, items: [noticeAboutR] } }

test('the 来た連絡 answering 404 takes its 返事のお願い\'s cached view with it: the secret title is in no entry, no view and no row', async () => {
  const answers = new Map<string, ContactReadResult>([[I, { success: true, contact: view }], [R, { success: true, contact: view }]])
  const store = createContactStore(async (_c, id) => answers.get(id)!)
  store.want('co-a', [`${I}@1`, `${R}@1`])
  await settle()
  assert.equal(store.view(R)?.interaction.title, SECRET)
  // Taken off 「この人たちだけ」: the contact is the missing 404; R is not read again (no new notice about it).
  answers.set(I, GONE)
  store.want('co-a', [`${I}@2`, `${R}@1`])
  await settle()
  for (const id of [I, R]) {
    assert.equal(store.view(id), undefined, id)
    assert.equal(store.entry(id)?.kind, 'gone', id)
  }
  assert.doesNotMatch(JSON.stringify([...store.snapshot()]), /役員人事/)
  const rows = inboxView(notices, [], undefined, INBOX_NEWS_SINCE, id => shownView(store.snapshot().get(id)))
  assert.doesNotMatch(JSON.stringify(rows), /役員人事/)
})

test('a read through the 返事のお願い already on its way when the 404 came (even one started after it) never puts the contact back', async () => {
  const viaR = later<ContactReadResult>()
  const viaI = later<ContactReadResult>()
  let first = true
  const store = createContactStore((_c, id) => {
    if (id === R) return viaR.promise
    if (first) { first = false; return Promise.resolve({ success: true, contact: view }) }
    return viaI.promise
  })
  store.want('co-a', [`${I}@1`])
  await settle()
  // The 404's read of I starts first; R's (a new notice) starts after it, before its answer — and answers last.
  store.want('co-a', [`${I}@2`, `${R}@1`])
  viaI.answer(GONE)
  await settle()
  viaR.answer({ success: true, contact: view })
  await settle()
  for (const id of [I, R]) assert.equal(store.view(id), undefined, id)
})

test('a read started after the 404 that the server answers again (put back on the list) shows the contact again', async () => {
  let answer: ContactReadResult = { success: true, contact: view }
  const store = createContactStore(async () => answer)
  store.want('co-a', [`${R}@1`])
  await settle()
  answer = GONE
  store.want('co-a', [`${I}@1`])
  await settle()
  assert.equal(store.view(R), undefined)
  answer = { success: true, contact: view }
  store.want('co-a', [`${R}@2`])
  await settle()
  assert.equal(store.view(I)?.interaction.title, SECRET)
})
