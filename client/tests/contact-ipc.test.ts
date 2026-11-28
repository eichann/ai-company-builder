// 「連絡」1枚 in main (client/electron/features/inbox/contact-ipc.ts, inbox.md "One contact"): only the fields the server
// reads leave this PC, a malformed request never reaches the server, the server's refusal keeps its code and part (the
// card's words depend on them), a contact the member cannot read is `gone`, and an answer of the wrong shape is not shown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContactApi } from '../electron/features/inbox/contact-ipc'

type Sent = { url: string; method: string; body: unknown }
function api(answer: (s: Sent) => { status: number; json: unknown } | 'down') {
  const sent: Sent[] = []
  const contact = createContactApi({
    baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit) => {
      const s = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined }
      sent.push(s)
      const a = answer(s)
      if (a === 'down') throw new Error('down')
      return new Response(JSON.stringify(a.json), { status: a.status })
    }) as typeof fetch,
  })
  return { contact, sent }
}
const VIEW = {
  interaction: { id: 'interaction-bbb222', title: 'A社', state: 'handled', version: 7, assignee: 'u-me', maySettle: false },
  replyRequests: [{ id: 'reply_request-aaa111', title: '返事', state: 'open', version: 4, assignee: 'u-me', due: null, guidelineDue: null, waitUntil: null, drafts: [], may: { replied_elsewhere: true, close: 'yes', drop: true } }],
  tasks: [],
}

test('a finish sends exactly the two parts the server reads, to the contact\'s own route', async () => {
  const { contact, sent } = api(() => ({ status: 200, json: { success: true, data: {
    interaction: { recordId: 'interaction-bbb222', outcome: 'done', state: 'handled', recordVersion: 8, version: 8 },
    replyRequest: { recordId: 'reply_request-aaa111', outcome: 'done', state: 'closed', recordVersion: 5, version: 5 },
  } } }))
  const r = await contact.finish('co-1', 'interaction-bbb222', {
    interaction: { expectedVersion: 7, extra: 'x' },
    replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'replied_elsewhere', askedBy: 'someone' },
  })
  assert.equal(r.success, true)
  assert.equal(sent[0].url, 'https://acb.example/api/companies/co-1/inbox/items/interaction-bbb222/finish')
  assert.deepEqual(sent[0].body, { interaction: { expectedVersion: 7 }, replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'replied_elsewhere' } })
})

test('a malformed press never reaches the server', async () => {
  const { contact, sent } = api(() => ({ status: 200, json: {} }))
  for (const input of [
    { interaction: { expectedVersion: 7 }, replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'ai_close' } },
    { interaction: {}, replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'close' } },
    { interaction: { expectedVersion: 7 }, replyRequest: { id: '../x', expectedVersion: 4, action: 'close' } },
  ]) assert.equal((await contact.finish('co-1', 'interaction-bbb222', input)).success, false)
  assert.equal((await contact.finish('co-1', '../../records', { interaction: { expectedVersion: 7 }, replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'close' } })).success, false)
  assert.equal((await contact.undo('co-1', 'interaction-bbb222', { replyRequest: { id: 'reply_request-aaa111' } })).success, false)
  assert.equal(sent.length, 0)
})

test('the server\'s refusal keeps its code and part; unreachable is offline; a contact not to be read is gone', async () => {
  const { contact } = api(s => (s.url.endsWith('/undo') ? 'down'
    : s.method === 'GET' ? { status: 404, json: { success: false, error: '見つかりません', code: 'RECORD_NOT_FOUND' } }
    : { status: 409, json: { success: false, error: 'ほかの人が先に変えました', code: 'VERSION_CONFLICT', part: 'interaction', version: 9 } }))
  const refused = await contact.finish('co-1', 'interaction-bbb222', { interaction: { expectedVersion: 7 }, replyRequest: { id: 'reply_request-aaa111', expectedVersion: 4, action: 'close' } })
  assert.deepEqual(refused, { success: false, offline: false, gone: false, code: 'VERSION_CONFLICT', part: 'interaction', error: 'ほかの人が先に変えました' })
  const down = await contact.undo('co-1', 'interaction-bbb222', { replyRequest: { id: 'reply_request-aaa111', version: 5, expectedVersion: 5 } })
  assert.equal(down.success === false && down.offline, true)
  assert.deepEqual(await contact.read('co-1', 'interaction-bbb222'), { success: false, gone: true })
})

test('only an explicit true from the server is a button the card may show', async () => {
  const { contact } = api(() => ({ status: 200, json: { success: true, data: VIEW } }))
  const r = await contact.read('co-1', 'interaction-bbb222')
  assert.equal(r.success, true)
  assert.deepEqual(r.success && r.contact.replyRequests[0].may, { replied_elsewhere: true, close: false, drop: true })
  // A view of the wrong shape is not shown as a contact.
  const { contact: broken } = api(() => ({ status: 200, json: { success: true, data: { interaction: { id: 'x' } } } }))
  assert.equal((await broken.read('co-1', 'interaction-bbb222')).success, false)
})
