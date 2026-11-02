// 見られる人 on a record's card (records.md, `POST …/viewers`). Guards: the card says only what the
// server answered for that record; a record left out of the answer (the member cannot read it, or
// an older server) shows nothing rather than a guess.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordViewsApi } from '../electron/features/record-views/ipc'

const DETAIL = {
  record: { id: 'decision-abc123', type: 'decision', title: '窓口は3つ', summary: '', state: 'unconfirmed', version: 2, fields: {}, path: null, folder: null },
  links: [],
}

function api(viewers: unknown, status = 200) {
  const asked: unknown[] = []
  return {
    asked,
    api: createRecordViewsApi({
      baseUrl: () => 'https://acb.test', cookies: () => ['session=abc'], log: { warn: () => {} },
      fetch: (async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname
        if (path.endsWith('/viewers')) { asked.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ data: viewers }), { status }) }
        if (path.endsWith('/records/item/decision-abc123')) return new Response(JSON.stringify({ data: DETAIL }), { status: 200 })
        return new Response(JSON.stringify({ data: { entries: [], types: [], runs: [] } }), { status: 200 })
      }) as unknown as typeof fetch,
    }),
  }
}

test('the card carries the server\'s 見られる人 for that record, asked for that record only', async () => {
  const h = api({ records: { 'decision-abc123': { kind: 'department', text: '営業部のみんな', count: 4 } }, files: {} })
  const card = await h.api.card('co1', 'decision-abc123')
  assert.deepEqual(card.success && card.card.viewers, { kind: 'department', text: '営業部のみんな', count: 4 })
  assert.deepEqual(h.asked, [{ records: ['decision-abc123'] }])
})

test('a record left out of the answer, or no answer, shows nothing', async () => {
  for (const h of [api({ records: {}, files: {} }), api({ error: 'x' }, 500)]) {
    const card = await h.api.card('co1', 'decision-abc123')
    assert.equal(card.success && 'viewers' in card.card, false)
  }
})
