// A contact no longer the member's to read (inbox.md "One contact in the app", Codex review of UX stage 2): its title is
// shown by none of its ids — not through a 返事のお願い read before, not by a read already on its way, not in a row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NotificationItem } from '../../../../shared/types/notifications'
import type { NoticesState } from '../../../shared/notifications-app'
import type { ContactReadResult, ContactView } from '../../../shared/contact-card'
import { createContactStore, rowContact } from './contactStore'
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
  const rows = inboxView(notices, [], undefined, INBOX_NEWS_SINCE, id => rowContact(store.snapshot().get(id)))
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

/** The notices main read before the member was taken off the list: the server's notice about I carried its title then. */
const noticeAboutI: NotificationItem = {
  id: 'n2', kind: 'intake_unsure', recordId: I, recordType: 'interaction', recordTitle: SECRET, version: 1,
  text: `「${SECRET}」を確かめてください`, createdAt: '2026-11-27T00:30:00Z', read: true,
}
const staleNotices: NoticesState = { available: true, myTurn: { total: 0, items: [] }, notices: { available: true, unread: 1, items: [noticeAboutR, noticeAboutI] } }

test('a contact gone after the notices were read is no row at all: not its contact row, not the plain notice rows it fell back to', async () => {
  let answer: ContactReadResult = { success: true, contact: view }
  const store = createContactStore(async () => answer)
  store.want('co-a', [`${R}@2`, `${I}@1`])
  await settle()
  const before = inboxView(staleNotices, [], undefined, INBOX_NEWS_SINCE, id => rowContact(store.snapshot().get(id)))
  assert.match(JSON.stringify(before), /役員人事/)
  // Taken off 「この人たちだけ」 (the card opened, read again): the notices on screen are still the ones from before.
  answer = GONE
  store.refresh('co-a', I)
  await settle()
  const after = inboxView(staleNotices, [], undefined, INBOX_NEWS_SINCE, id => rowContact(store.snapshot().get(id)))
  assert.doesNotMatch(JSON.stringify(after), /役員人事/)
  assert.deepEqual([...after.waiting, ...after.news, ...after.moving, ...after.seen], [])
  assert.deepEqual(after.counts, { waiting: 0, news: 0, seen: 0, elsewhere: 0 })
  assert.deepEqual(after.newsNoticeIds, [])
})

test('a contact becoming gone asks for the notices again (for its company); a shown or failed read does not', async () => {
  let answer: ContactReadResult = { success: true, contact: view }
  const asked: string[] = []
  const store = createContactStore(async () => answer, undefined, async c => { asked.push(c); return null })
  store.want('co-a', [`${I}@1`])
  await settle()
  answer = { success: false, gone: false, offline: true, error: '連絡を読めませんでした' }
  store.refresh('co-a', I)
  await settle()
  assert.deepEqual(asked, [])
  answer = GONE
  store.refresh('co-a', I)
  await settle()
  assert.deepEqual(asked, ['co-a'])
})

test('the notices read again after the 404: an id the server still lists gets its own notice row back (its own title), the others stay gone; no read is started for it', async () => {
  let answer: ContactReadResult = { success: true, contact: view }
  let reads = 0
  const again = later<ReadonlySet<string> | null>()
  const store = createContactStore(async () => { reads++; return answer }, undefined, () => again.promise)
  store.want('co-a', [`${R}@2`, `${I}@1`])
  await settle()
  answer = GONE
  store.refresh('co-a', I)
  await settle()
  const readsAtGone = reads
  // Until main's new read answers, nothing of the contact is a row.
  const waiting = inboxView(staleNotices, [], undefined, INBOX_NEWS_SINCE, id => rowContact(store.snapshot().get(id)))
  assert.deepEqual([...waiting.news, ...waiting.seen], [])
  // That read (made after the 404) still lists the 返事のお願い — the server shows it to the member — and not the 来た連絡.
  again.answer(new Set([R]))
  await settle()
  assert.equal(store.entry(R), undefined)
  assert.equal(store.entry(I)?.kind, 'gone')
  const rows = inboxView(staleNotices, [], undefined, INBOX_NEWS_SINCE, id => rowContact(store.snapshot().get(id)))
  assert.deepEqual([...rows.news, ...rows.seen].map(r => [r.key, r.title]), [[`record:${R}`, '返事']])
  assert.doesNotMatch(JSON.stringify(rows), /役員人事/)
  store.want('co-a', [`${R}@2`, `${I}@1`])
  await settle()
  assert.equal(reads, readsAtGone)
})

test('a read of the notices that did not happen (null), or a read of the contact written since, keeps what it has', async () => {
  let answer: ContactReadResult = { success: true, contact: view }
  const again = later<ReadonlySet<string> | null>()
  const store = createContactStore(async () => answer, undefined, () => again.promise)
  store.want('co-a', [`${R}@2`, `${I}@1`])
  await settle()
  answer = GONE
  store.refresh('co-a', I)
  await settle()
  // Put back on the list and read again before main's answer came: the newer read stands.
  answer = { success: true, contact: view }
  store.refresh('co-a', R)
  await settle()
  again.answer(new Set([I, R]))
  await settle()
  assert.equal(store.entry(I)?.kind, 'shown')
  const offline = createContactStore(async () => GONE, undefined, async () => null)
  offline.want('co-a', [`${I}@1`])
  await settle()
  assert.equal(offline.entry(I)?.kind, 'gone')
})

test('an older read of the notices landing after a second 404 of the same id never lifts it (only its own 404\'s read may)', async () => {
  const asks: Array<ReturnType<typeof later<ReadonlySet<string> | null>>> = []
  const store = createContactStore(async () => GONE, undefined, () => { const a = later<ReadonlySet<string> | null>(); asks.push(a); return a.promise })
  store.want('co-a', [`${R}@1`])
  await settle()
  store.want('co-a', [`${R}@2`])
  await settle()
  asks[0].answer(new Set([R]))
  await settle()
  assert.equal(store.entry(R)?.kind, 'gone')
  asks[1].answer(new Set([R]))
  await settle()
  assert.equal(store.entry(R), undefined)
})

test('the notices not read again (offline) are asked once more at the next look (back online, the panel shown), then lifted', async () => {
  let online = false
  let asked = 0
  const store = createContactStore(async () => GONE, undefined, async () => { asked++; return online ? new Set([R]) : null })
  store.want('co-a', [`${R}@1`])
  await settle()
  assert.deepEqual([asked, store.entry(R)?.kind], [1, 'gone'])
  online = true
  store.want('co-a', [`${R}@1`])
  await settle()
  assert.deepEqual([asked, store.entry(R)?.kind], [2, undefined])
  // Nothing left to ask: the next look asks nothing.
  store.want('co-a', [`${R}@1`])
  await settle()
  assert.equal(asked, 2)
})
