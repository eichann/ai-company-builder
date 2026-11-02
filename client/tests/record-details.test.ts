// A meeting's and a 来た連絡's own parts (client/shared/record-details.ts). Guards: only well-formed
// ids from the record's pointer ever become a link out (a crafted id cannot point elsewhere); no
// body text is made up — a 連絡's summary only; a Slack sender id is never shown as a name; a
// bundle's やること are grouped by whose turn; the AI band says only what the run and 経緯 say.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import type { AiRunView } from '../../shared/types/ai-runs'
import { aiOnRecord } from '../electron/features/record-views/ipc'
import { bundleDetailOf, recordDetailOf } from '../shared/record-details'

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

test('a bundle\'s やること by whose turn: 「あなたの番」 only for the member, the checker\'s turn while checked, finished apart', () => {
  const t = (id: string, state: string, fields: Record<string, string>) =>
    ({ id, type: 'task', typeVersion: 9, title: id, summary: '', path: null, state, fields, version: 1, updatedAt: '' })
  const linked = [
    t('mine', 'todo', { assignee: 'u-sato' }), t('abe', 'in_progress', { assignee: 'u-abe', due: '2026-11-07T17:00' }),
    t('checked', 'review', { assignee: 'u-abe', reviewer: 'u-sato' }), t('prep', 'preparing', { assignee: 'u-sato' }),
    t('over', 'done', { assignee: 'u-abe' }),
    { id: 'approval-1', type: 'approval', typeVersion: 5, title: '金額', summary: '', path: null, state: 'pending', fields: {}, version: 1, updatedAt: '' },
    { id: 'approval-2', type: 'approval', typeVersion: 5, title: '前の', summary: '', path: null, state: 'approved', fields: {}, version: 1, updatedAt: '' },
  ]
  const b = bundleDetailOf({ fields: { owner: 'u-abe', purpose: '窓口を3つに' } }, linked, 'u-sato', people)
  assert.deepEqual(b.groups.map(g => [g.title, g.tasks.map(x => `${x.id}:${x.turn}`)]), [
    ['あなたの番', ['mine:あなたの番', 'checked:あなたの番']],
    ['AI の番', ['prep:AI の番']],
    ['ほかの人の番・返事待ち', ['abe:阿部さんの番']],
    ['終わったこと', ['over:null']],
  ])
  assert.deepEqual([b.owner, b.purpose, b.done, b.total, b.pendingApprovals], ['阿部', '窓口を3つに', 1, 5, ['approval-1']])
})

test('the AI on a record: working while its run is held or open; 「反映しました」 only when the newest change is the AI\'s', () => {
  const run = (state: string, recordId = 'deal-1') => ({ recordId, state }) as unknown as AiRunView
  const entry = (version: number, actorKind: string) => ({ version, action: 'create', actorId: 'x', actorKind, at: '2026-11-05T06:38:00Z', note: '', changes: [] }) as unknown as LedgerEntry
  assert.deepEqual(aiOnRecord('deal-1', [run('running')], [entry(2, 'ai')], undefined, {}), { working: true, done: null })
  assert.equal(aiOnRecord('deal-1', [run('done')], [entry(1, 'human'), entry(2, 'ai')], undefined, {})?.done?.text, '作りました')
  assert.equal(aiOnRecord('deal-1', [run('waiting_person')], [entry(2, 'ai'), entry(3, 'human')], undefined, {})?.done, null)
  assert.equal(aiOnRecord('deal-1', [run('running', 'deal-2')], [], undefined, {})?.working, false)
})
