// A meeting's and a 来た連絡's own parts (client/shared/record-details.ts). Guards: only well-formed
// ids from the record's pointer ever become a link out (a crafted id cannot point elsewhere); no
// body text is made up — a 連絡's summary only; a Slack sender id is never shown as a name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordDetailOf } from '../shared/record-details'

const people = { 'u-sato': '佐藤', 'u-abe': '阿部' }

test('a meeting opens its own Google documents and its day, nothing from a malformed pointer', () => {
  const ref = JSON.stringify({ conference: 'c', event: 'e', docs: [{ kind: 'notes', id: 'notesDoc12345' }, { kind: 'transcript', id: '../../evil?x=1' }] })
  const m = recordDetailOf({ type: 'meeting', summary: '', fields: { meeting_at: '2026-11-05T14:30', source_ref: ref, attendees: '["u-sato","u-gone"]', external_count: 2, assignee: 'u-abe', summary_text: '要約' } }, people)
  assert.equal(m?.kind, 'meeting')
  if (m?.kind !== 'meeting') return
  assert.deepEqual(m.opens.map(o => o.url), ['https://docs.google.com/document/d/notesDoc12345/edit', 'https://calendar.google.com/calendar/r/day/2026/11/5'])
  assert.deepEqual(m.attendees, ['佐藤'])
  assert.equal(m.assignee, '阿部')
  assert.equal(m.summary, '要約')
  const broken = recordDetailOf({ type: 'meeting', summary: '', fields: { source_ref: '{not json' } }, people)
  assert.deepEqual(broken?.kind === 'meeting' && broken.opens, [])
})

test('a 来た連絡 opens the original in Slack or Gmail only from a well-formed pointer', () => {
  const slack = recordDetailOf({ type: 'interaction', summary: '資料を送ってほしい', fields: { channel: 'slack', source_ref: 'slack:C0123ABCD:1730800000.123456', from_address: 'slack:U999', needs_reply: true } }, people)
  assert.deepEqual(slack?.kind === 'incoming' && { open: slack.open?.url, from: slack.from, summary: slack.summary, needsReply: slack.needsReply },
    { open: 'https://slack.com/archives/C0123ABCD/p1730800000123456', from: null, summary: '資料を送ってほしい', needsReply: true })
  const gmail = recordDetailOf({ type: 'interaction', summary: '', fields: { channel: 'email', source_ref: 'gmail:18c2f0a1b2c3d4e5', from_address: 'suzuki@a.example' } }, people)
  assert.deepEqual(gmail?.kind === 'incoming' && [gmail.open?.url, gmail.from], ['https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3d4e5', 'suzuki@a.example'])
  for (const ref of ['slack:C01/../x:1730800000.1', 'slack:C0123ABCD:nope', 'gmail:a/b', 'https://evil.example']) {
    const d = recordDetailOf({ type: 'interaction', summary: '', fields: { source_ref: ref } }, people)
    assert.equal(d?.kind === 'incoming' && d.open, null, ref)
  }
})
