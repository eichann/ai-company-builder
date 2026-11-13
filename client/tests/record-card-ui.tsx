/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the record screens (features/records RecordCard): the real card over a fake main
// process whose card is built by the real `summaryView` / `recordDetailOf`. `?record=meeting` (the
// default) is a meeting with its decisions, homework and many links; `?record=slack` a 来た連絡
// from Slack with the thread slot filled, the member's to settle (`&replies=open`: its 返事のお願い open); `?record=bundle` a 案件 with everyone's やること, an approval
// request and what the AI last did; `?record=reply` a 返事のお願い in 確かめ中 (the AI's turn) that is the member's,
// ［終わりにする］ moving it as the server would (`&type=v4`: an older server's type, close only from 返事をする / 返事待ち) (`?ai=working`: while it works); `?field=real` draws the meeting's real
// 案件・プロジェクト field (no 案件 yet: 「新しいプロジェクトにする」). Links opened outside show in `#opened`.
// `&off=1`: the record's feature is turned off (「使う機能」): the card is 「見るだけ」.
// `?record=project`: a プロジェクト whose 責任者 is the member (owner FB #30): ［終える］, 「…」 ［やめる］ and the fields,
// each moving it as the server would (`act …` lines, with args / note); `&owner=other`: someone else's (nothing to press).
// `&drive=1` (owner decision 2026-11-13): its type's file link offers ［Google Drive のファイルをつなぐ］ (`drive@<version>`,
// `show=<ids>` for a pasted / dropped link, `chosen=<ids>` from the member's own list), with two Drive files linked — the
// member's own by name, someone else's as 「Google Drive のファイル」 — taken off as `unlinkTarget drive <id>@<version>`;
// `&drive=off`: Drive not set up for the company.
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { RecordCard } from '../src/features/records/components/RecordCard'
import { renderRecordBundleField } from '../src/app/recordBundleField'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { RecordSummary } from '../../shared/types/records'
import { bundleActionsOf, bundleDetailOf, recordDetailOf } from '../shared/record-details'
import { summaryView, type RecordCardLink } from '../shared/record-views'
import { installElectronAPI } from './ui/fixtures/electron-api'
import { fakeDropLink } from './ui/fixtures/link-drop'

const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const people = { 'u-sato': '佐藤', 'u-abe': '阿部' }
const params = new URLSearchParams(location.search)
const kind = params.get('record') ?? 'meeting'
const rec = (id: string, type: string, title: string, state: string | null, fields: RecordSummary['fields'] = {}, summary = ''): RecordSummary =>
  ({ id, type, typeVersion: 1, title, summary, path: null, state, fields, version: 3, updatedAt: '2026-11-05T06:00:00.000Z' })
const view = (r: RecordSummary) => summaryView(r, defs.get(r.type))

const meeting = rec('meeting-0000aa', 'meeting', 'A社 研修導入のお打ち合わせ', 'read', {
  meeting_at: '2026-11-05T14:30', assignee: 'u-sato', attendees: '["u-sato","u-abe"]', external_count: 2,
  summary_text: '窓口を2つから3つに増やす方向で合意。金額は150万円の見込み。',
  source_ref: JSON.stringify({ conference: 'c1', event: 'e1', docs: [{ kind: 'notes', id: 'notesDoc12345' }, { kind: 'transcript', id: 'transcriptDoc123' }] }),
})
// As the inbox stores a Slack message: channel `chat` with a `slack:` pointer, in 確認待ち (`unsure`).
// It is the member's (u-sato): ［済んだ］ / ［取り込まない］ move it as the server would (owner FB #20); an end the
// screen is told of (its tab and automatic consultations close, owner FB #29) is listed as `ended <id>`.
let slack = rec('interaction-0000bb', 'interaction', '資料送付のお願い', 'unsure', {
  channel: 'chat', occurred_at: '2026-11-05T17:30:00Z', counterpart_text: '山田 様（C社）', needs_reply: true, source_ref: 'slack:C0123ABCD:1730800000.123456', assignee: 'u-sato',
}, '先日の打ち合わせ資料を送ってほしいとのこと。')
const slackBefore: RecordSummary[] = []
const ME = 'u-sato'
// A 返事のお願い after the member's reply: 確かめ中, the AI's turn (owner report 2026-11-05).
let reply = rec('reply_request-0000c1', 'reply_request', 'Re: 資料送付のお願い', 'checking', { assignee: ME, requested_by: ME, trigger_kind: 'our_reply' })
const replyBefore: RecordSummary[] = []
const replyDef = params.get('type') === 'v4'
  ? { actions: { ...defs.get('reply_request')!.actions, close: { ...defs.get('reply_request')!.actions.close, from: ['open', 'waiting_reply'] } } }
  : defs.get('reply_request')
// A プロジェクト: its buttons come from the real `bundleActionsOf` over the core type, as main builds them.
let project = rec('project-0000p1', 'project', '新人研修の見直し', 'active', { owner: params.get('owner') === 'other' ? 'u-abe' : ME, purpose: '研修を3日に縮める', due: '2026-12-01' })
const projectBefore: RecordSummary[] = []
const driveMode = params.get('drive') !== null
const projectCard = () => {
  const actions = bundleActionsOf(defs.get('project'), project.state, project.fields, ME, people)
  return { record: view(project), version: project.version, detail: { ...bundleDetailOf(project, [], ME, people), ...(actions ? { actions } : {}) }, fields: [], history: [], links: [], viewers: { kind: 'department' as const, text: '営業部のみんな', count: 4 },
    ...(driveMode ? { driveLink: true as const, driveFiles: [{ fileId: '1ProjDocMine0001', mine: true, name: '研修の進め方（作業中）' }, { fileId: '1ProjDocOther001', mine: false, name: null }] } : {}) }
}
const replyCard = () => ({ record: view(reply), version: reply.version, detail: recordDetailOf(reply, people, ME, replyDef) ?? undefined, fields: [], history: [], links: [], viewers: { kind: 'only-you' as const, text: 'あなただけ', count: 1 } })

const realField = params.get('field') === 'real'
const task = (n: number, state = 'todo') => ({ label: 'もとの会議', recordVersion: 2, record: view(rec(`task-00000${n}`, 'task', `宿題 ${n}`, state)) })
// `?replies=open`: a 返事のお願い of it still open (its own record, ended there).
const slackLinks: RecordCardLink[] = params.get('replies') === 'open'
  ? [{ label: '', record: view(rec('reply_request-0000b9', 'reply_request', 'Re: 資料送付のお願い', 'open')) }] : []
const links: RecordCardLink[] = kind === 'slack' ? slackLinks : [
  task(1), task(2), task(3), task(4, 'done'),
  { label: '会議', record: view(rec('decision-000001', 'decision', '窓口は3つにする', 'unconfirmed')),
    removable: { source: 'decision-000001', sourceVersion: 3, link: 'meeting', target: 'meeting-0000aa' } },
  ...(realField
    ? [{ label: '相手', counterpart: true as const, record: view(rec('company-0000ff', 'company', '株式会社エー（A社）', null)) }]
    : [{ label: 'まとまり', bundle: true as const, record: view(rec('deal-0000ee', 'deal', 'A社 研修導入', 'open')),
      removable: { source: 'meeting-0000aa', sourceVersion: 3, link: 'bundle', target: 'deal-0000ee' } }]),
]
const tasks = [
  rec('task-0000b1', 'task', '見積書を作り直す', 'todo', { assignee: 'u-sato', due: '2026-11-07T17:00' }),
  rec('task-0000b2', 'task', 'スケジュール案を出す', 'in_progress', { assignee: 'u-abe' }),
  rec('task-0000b3', 'task', 'お礼メールを送る', 'done', { assignee: 'u-sato' }),
]
const deal = rec('deal-0000cc', 'deal', 'A社 研修導入', 'open', { owner: 'u-abe', purpose: '新人研修の窓口を3つにする' })
const approval = rec('approval-0000dd', 'approval', '金額を 1,500,000円 に改める', 'pending')
const bundleLinks: RecordCardLink[] = [...tasks, approval].map(r => ({ label: 'まとまり', record: view(r) }))
const record = kind === 'slack' ? slack : kind === 'bundle' ? deal : meeting
const opened: string[] = []
const slackCard = () => ({ record: view(slack), version: slack.version, detail: recordDetailOf(slack, people, ME) ?? undefined, fields: [], history: [], links, viewers: { kind: 'only-you' as const, text: 'あなただけ', count: 1 } })
// `&private=edit|read`: a 非公開 案件 (records.md "Private 案件・プロジェクト") — its 参加者, editable or only named.
const privateMode = params.get('private')
let participantRules = [
  { userId: 'u-sato', name: '佐藤', email: null, role: 'member', canWrite: true, via: 'rule' as const },
  { userId: 'u-abe', name: '阿部', email: null, role: 'member', canWrite: false, via: 'rule' as const },
  { userId: 'u-admin', name: '管理', email: null, role: 'admin', canWrite: true, via: 'role' as const },
]
const participantsNow = () => ({
  names: participantRules.filter(m => m.via === 'rule').map(m => m.name), admins: 1, members: privateMode === 'edit' ? participantRules : null,
})
const card = kind === 'bundle'
  ? {
    ...(privateMode ? { privateFolder: { scopeId: 'scope-1', path: '営業部/A社研修' } } : {}),
    record: { ...view(deal), typeLabel: '案件', thing: 'bundle' as const },
    detail: bundleDetailOf(deal, [...tasks, approval], 'u-sato', people),
    fields: [], history: [{ at: '2026-11-05T06:38:00.000Z', text: 'AI：まとまりの分を終える（承認のお願い 1件を作りました）', ai: true }], links: bundleLinks,
    ai: params.get('ai') === 'working' ? { working: true, done: null } : { working: false, done: { at: '2026-11-05T06:38:00.000Z', text: '承認のお願い 1件を作りました' } },
  }
  : { record: view(record), version: 3, detail: recordDetailOf(record, people) ?? undefined, fields: [], history: [], links, viewers: kind === 'slack' ? { kind: 'only-you' as const, text: 'あなただけ', count: 1 } : { kind: 'department' as const, text: '営業部のみんな', count: 4 } }

installElectronAPI({
  getRecordCard: async () => ({ success: true, card: { ...(kind === 'slack' ? slackCard() : kind === 'reply' ? replyCard() : kind === 'project' ? projectCard() : privateMode && kind === 'bundle'
    ? { ...card, participants: participantsNow(), viewers: { kind: 'private-folder' as const, text: `『A社 研修導入』の参加者（${participantRules.length}人）`, count: participantRules.length } } : card),
    ...(params.get('off') === '1' ? { featureOff: true as const } : {}) } }),
  getPrivateFolderCreateContext: async () => ({ success: true, context: { role: 'member', managedDepartmentIds: ['d-sales'], department: { id: 'd-sales', name: '営業部', folder: '営業部' }, managerIds: [], members: [
    { userId: 'u-sato', name: '佐藤', email: null, role: 'member' }, { userId: 'u-kato', name: '加藤', email: null, role: 'member' }, { userId: 'u-admin', name: '管理', email: null, role: 'admin' },
  ] } }),
  setPrivateFolderMembers: async (_c, scopeId, input) => {
    say(`members ${scopeId} viewers=${input.viewers.join('|')} editors=${input.editors.join('|')}`)
    participantRules = [...input.viewers.map(id => ({ userId: id, name: id === 'u-kato' ? '加藤' : id === 'u-abe' ? '阿部' : '佐藤', email: null, role: 'member', canWrite: input.editors.includes(id), via: 'rule' as const })), participantRules.at(-1)!]
    return { success: true, members: participantRules }
  },
  actOnTask: async (_c, recordId, input) => {
    say(`act ${recordId} ${input.action}@${input.expectedVersion}${input.args ? ` ${JSON.stringify(input.args)}` : ''}${input.note ? ` note=${input.note}` : ''}`)
    if (recordId === project.id) {
      projectBefore.push(project)
      const to = defs.get('project')!.actions[input.action].to
      project = { ...project, state: to ?? project.state, version: project.version + 1, fields: { ...project.fields, ...(input.args as Record<string, string> | undefined) } }
      return { success: true, recordId }
    }
    if (recordId === reply.id) {
      replyBefore.push(reply)
      reply = { ...reply, state: 'closed', version: reply.version + 1 }
      return { success: true, recordId }
    }
    slackBefore.push(slack)
    const state = input.action === 'settle' ? 'handled' : 'excluded'
    slack = { ...slack, state, version: slack.version + 1, fields: { ...slack.fields, ...(input.action === 'settle' ? { settled_by: ME } : {}) } }
    return { success: true, recordId }
  },
  dropLinkOnRecord: fakeDropLink(say),
  openExternal: async url => { opened.push(url); document.getElementById('opened')!.textContent = opened.join('\n'); return { success: true } },
  unlinkRecordFromRecord: async (_c, recordId, input) => { say(`unlink ${recordId} ${input.link}=${input.target}@${input.expectedVersion}`); return { success: true, recordId, entryVersion: input.expectedVersion + 1 } },
  undoTaskAction: async (_c, recordId, version, expected) => {
    say(`undo ${recordId} ${version}@${expected}`)
    if (recordId === project.id) {
      const was = projectBefore.pop()
      if (was) project = { ...was, version: project.version + 1 }
      return { success: true, recordId }
    }
    if (recordId === reply.id) {
      const was = replyBefore.pop()
      if (was) reply = { ...was, version: reply.version + 1 }
      return { success: true, recordId }
    }
    const before = recordId === slack.id ? slackBefore.pop() : undefined
    if (before) slack = { ...before, version: slack.version + 1 }
    return { success: true, recordId }
  },
  getBundleChoices: async () => ({ success: true, bundles: [{ id: 'project-000011', title: 'A社 研修導入の相談（去年）', typeLabel: 'プロジェクト' }, { id: 'project-000012', title: 'B社 新人研修', typeLabel: 'プロジェクト' }] }),
  createBundle: async (_c, input) => { say(`create ${input.type} ${input.title} folder=${input.folder ?? ''} counterpart=${input.counterpart ?? ''}`); return { success: true, recordId: 'project-0000nn' } },
  linkMinutesBundle: async (_c, meetingId, bundleId) => { say(`linkMeeting ${meetingId}=${bundleId}`); return { success: true } },
  linkDriveFilesToTask: async (_c, recordId, version, options) => {
    const { fileIds, chosen } = options ?? {}
    say(`drive ${recordId}@${version}${fileIds?.length ? ` show=${fileIds.join('+')}` : ''}${chosen ? ` chosen=${chosen.map(f => f.id).join(',')}` : ''}`)
    return { success: true, recordId, linked: chosen ? chosen.map(f => f.name) : ['研修の資料'] }
  },
  unlinkTargetFromTask: async (_c, recordId, target, version) => {
    say(`unlinkTarget ${recordId} ${target.kind} ${target.kind === 'drive' ? target.fileId : target.path}@${version}`)
    return { success: true, recordId, entryVersion: version + 1 }
  },
  getTaskDriveChoices: async () => [{ id: '1PickedEarlier001', name: '去年の研修資料.pdf', source: 'picked' as const }],
  getGoogleStatus: async () => ({ success: true, data: {
    available: true, reason: null, connected: true, status: 'active', googleEmail: 'me@div.example', domain: 'div.example', practice: false, featuresOff: [], seen: [],
    features: ['minutes', 'drive'], companyFeatures: params.get('drive') === 'off' ? ['minutes'] : ['minutes', 'drive'],
  } as never }),
  linkRecordToRecord: async (_c, recordId, input) => { say(`link ${recordId} ${input.link}=${input.target}@${input.expectedVersion}`); return { success: true, recordId, entryVersion: input.expectedVersion + 1 } },
})
function say(line: string) { opened.push(line); document.getElementById('opened')!.textContent = opened.join('\n') }

function Preview() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <pre id="opened" className="text-[10px]" />
      <RecordCard companyId="co-preview" rootPath="/Users/me/company" recordId={kind === 'reply' ? reply.id : kind === 'project' ? project.id : record.id}
        renderSource={r => (r.type === 'interaction' ? <div data-testid="thread">スレッドの前後と返事の下書き：{r.title}</div> : null)}
        renderApproval={id => <div data-testid="approval">承認のお願いのカード：{id}</div>}
        consultations={params.get('consult') === 'none' ? [] : [{ sessionId: 's-1', title: 'A社 打ち合わせのあと', updatedAt: '2026-11-05T07:00:00.000Z' }]}
        onConsult={(r, fresh) => { opened.push(`consult ${r.id} ${fresh}`); document.getElementById('opened')!.textContent = opened.join('\n') }}
        onEnded={id => say(`ended ${id}`)}
        renderBundleField={f => (realField
          ? renderRecordBundleField('co-preview', f, { type: 'project', name: 'プロジェクト', source: 'core' }, '営業部')
          : <div data-testid="bundle-field">{f.bundle?.title ?? 'なし'}・{f.removable ? '外せる' : '外せない'}</div>)} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
