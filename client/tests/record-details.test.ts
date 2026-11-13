// A meeting's and a 来た連絡's own parts (client/shared/record-details.ts). Guards: only well-formed
// ids from the record's pointer ever become a link out (a crafted id cannot point elsewhere); no
// body text is made up — a 連絡's summary only; a Slack sender id is never shown as a name; a
// bundle's やること are grouped by whose turn; the AI band says only what the run and 経緯 say.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import type { AiRunView } from '../../shared/types/ai-runs'
import { aiOnRecord } from '../electron/features/record-views/ipc'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { parseTypeFile } from '../../shared/core/record-types'
import { bundleActionsOf, bundleDetailOf, recordDetailOf } from '../shared/record-details'

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

// Owner FB #30: a プロジェクト can be ended in the app. Guards: only what the type's `who` gives the member
// by what the app knows (its 責任者) is offered — never to anyone else, so nothing the server refuses is
// shown; ［終える］ is the main button and ［やめる］ in 「…」 with the fields to change; a finished one only
// ［もう一度始める］; 終える / やめる end it (its tab closes), もう一度始める does not.
const project = coreTypeDefinitions().find(d => d.name === 'project')!
const names = (a: ReturnType<typeof bundleActionsOf>) => a && { main: a.main?.title ?? null, more: a.more.map(x => x.title) }

test('a プロジェクト\'s buttons: its 責任者 gets ［終える］ and 「…」 ［やめる］ and the fields; a finished one ［もう一度始める］', () => {
  const active = bundleActionsOf(project, 'active', { owner: 'u-sato', purpose: '窓口を3つに', due: '2026-12-01' }, 'u-sato', people)
  assert.deepEqual(names(active), { main: '終える', more: ['やめる', '責任者を替える', 'なんのためを書く', '期限を変える'] })
  assert.deepEqual([active!.main!.ends, active!.main!.noteOffered], [true, false])
  const cancel = active!.more.find(a => a.action === 'cancel')!
  assert.deepEqual([cancel.ends, cancel.noteOffered, cancel.noteRequired, cancel.args], [true, true, false, []])
  // The fields come prefilled; 責任者を替える chooses among the members, the member first as 自分.
  assert.deepEqual(active!.more.find(a => a.action === 'set_due')!.args, [{ name: 'due', label: '期限', kind: 'date', value: '2026-12-01' }])
  assert.equal(active!.more.find(a => a.action === 'set_owner')!.ends, false)
  assert.deepEqual(active!.people.map(p => p.id), ['u-sato', 'u-abe'])
  for (const state of ['done', 'cancelled']) {
    const back = bundleActionsOf(project, state, { owner: 'u-sato' }, 'u-sato', people)
    assert.deepEqual(names(back), { main: 'もう一度始める', more: [] }, state)
    assert.equal(back!.main!.ends, false)
  }
})

test('a プロジェクト\'s buttons are never offered to someone the type does not name (an admin or manager is the server\'s to allow)', () => {
  assert.equal(bundleActionsOf(project, 'active', { owner: 'u-abe' }, 'u-sato', people), null)
  assert.equal(bundleActionsOf(project, 'active', { owner: 'u-sato' }, null, people), null)
  assert.equal(bundleActionsOf(undefined, 'active', { owner: 'u-sato' }, 'u-sato', people), null)
})

// Owner FB #34 (2026-11-13): a プロジェクト the AI made without a 責任者 had no button for anyone.
// Project v2's 責任者を替える has `who_fallback: [anyone]` (the server's whoWithFallback): with no
// 責任者 every reader gets that one action — never 終える / やめる / the other fields.
test('a プロジェクト without a 責任者: every reader gets 責任者を替える only (its who_fallback); once named, only the 責任者', () => {
  for (const fields of [{}, { owner: null }, { owner: '' }, { purpose: '窓口を3つに' }] as Array<Record<string, string | null>>) {
    const none = bundleActionsOf(project, 'active', fields, 'u-sato', people)
    assert.deepEqual(names(none), { main: null, more: ['責任者を替える'] }, JSON.stringify(fields))
    assert.deepEqual(none!.more[0].args.map(a => [a.name, a.kind, a.value]), [['owner', 'person', null]])
    assert.deepEqual(none!.people.map(p => p.id), ['u-sato', 'u-abe'])
  }
  // Finished: nothing (set_owner is from active only; reopen stays the 責任者's).
  assert.equal(bundleActionsOf(project, 'done', {}, 'u-sato', people), null)
  // A 責任者 named: the fallback is gone.
  assert.equal(bundleActionsOf(project, 'active', { owner: 'u-abe' }, 'u-sato', people), null)
  // A type without who_fallback (project v1, as an older server sends it): nothing, as before.
  const v1 = { ...project, actions: Object.fromEntries(Object.entries(project.actions).map(([k, a]) => [k, { ...a, whoFallback: undefined }])) }
  assert.equal(bundleActionsOf(v1, 'active', {}, 'u-sato', people), null)
})

// The app's fallback is narrower than the server's: a `who` naming `link:<link>.<field>` people (a parent
// まとまり's 責任者, unknown to the app) never opens it, even with the record's own person field empty.
test('who_fallback is not offered when who names a linked record\'s people (the app cannot know them)', () => {
  const text = ['---', 'label: 小さな案件', 'version: 1', 'storage: server', 'implements: [bundle]', 'fields:',
    '  owner: { label: 責任者, kind: person, source: server }', '  purpose: { label: なんのため, kind: text, source: server }',
    'links:', '  parent: { label: 親, interface: bundle, cardinality: one }',
    'states: [open, done]', 'initial: open', 'final: [done]', 'actions:',
    '  set_owner: { label: 責任者を替える, from: [open], who: [owner, link:parent.owner], who_fallback: [anyone], args: { owner: person } }', '---', ''].join('\n')
  const parsed = parseTypeFile('small', text)
  assert.ok(parsed.ok, JSON.stringify(parsed))
  assert.equal(bundleActionsOf(parsed.definition, 'open', {}, 'u-sato', people), null)
  // Without the link entry the same type does offer it (the guard, not the type, decides).
  const plain = parseTypeFile('small', text.replace('who: [owner, link:parent.owner]', 'who: [owner]'))
  assert.ok(plain.ok, JSON.stringify(plain))
  assert.deepEqual(names(bundleActionsOf(plain.definition, 'open', {}, 'u-sato', people)), { main: null, more: ['責任者を替える'] })
})

test('a business plugin\'s 案件 gets its own type\'s actions the same way; the AI\'s steps, link setters and fields without an editor are left out', () => {
  const text = ['---', 'label: 案件', 'version: 1', 'storage: server', 'implements: [bundle]', 'fields:',
    '  owner: { label: 責任者, kind: person, source: server }', '  purpose: { label: なんのため, kind: text, source: server }',
    '  stage: { label: 段階, kind: choice, options: [a, b], source: server }', 'links:', '  related: { label: 関係, target: deal, cardinality: many }',
    'states: [open, won, lost]', 'initial: open', 'final: [won, lost]', 'actions:',
    '  win: { label: 受注にする, from: [open], to: won, who: [owner, admin] }',
    '  lose: { label: 失注にする, from: [open], to: lost, who: [owner], note: required }',
    '  set_stage: { label: 段階を変える, from: [open], who: [owner], args: { stage: choice } }',
    '  relate: { label: 関係をつなぐ, from: [open], who: [owner], links: [related] }',
    '  ai_note: { label: AI がまとめる, from: [open], to: won, who: [ai] }',
    '  reopen: { label: 商談に戻す, from: [won, lost], to: open, who: [owner] }', '---', ''].join('\n')
  const parsed = parseTypeFile('deal', text)
  assert.ok(parsed.ok, JSON.stringify(parsed))
  const deal = parsed.definition
  const open = bundleActionsOf(deal, 'open', { owner: 'u-sato' }, 'u-sato', people)
  assert.deepEqual(names(open), { main: '受注にする', more: ['失注にする'] })
  assert.deepEqual([open!.more[0].ends, open!.more[0].noteRequired], [true, true])
  assert.deepEqual(names(bundleActionsOf(deal, 'lost', { owner: 'u-sato' }, 'u-sato', people)), { main: '商談に戻す', more: [] })
})
