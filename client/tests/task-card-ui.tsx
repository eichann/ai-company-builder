/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the task card (features/tasks): the real card over a fake main process whose
// card is built by the real `taskCardOf` from core type definitions. `?task=done` shows a task
// completed on someone's OK; `?shared=1` a task already shown to a department (no 「部署に出す」); `?source=1` links the 来た連絡 it came from (the
// screen always offers a source; the card shows it only then); `?conflict=1` answers every action with 「ほかの人が先に変えました」 after 阿部さん
// changed the due. Actions sent show in `#acted`, run answers in `#runs`. `?task=waiting`: 返事待ち with its 見込み
// (task version 12); `?task=back`: the clock gave it back (見込み 11/6 passed); `?task=todo-team`: a plain task with
// チームの進め方 on; `?task=todo-own`: the member's own task with チームの進め方 off (返事待ちにする still in 「…」). The wait tests install the page clock (Mon 11-02 or Sat 11-07).
// `?task=unassigned`: a task the member asked with nobody holding it (「自分が担当する」 heads the 「…」, 「終わったら」, アーカイブ);
// `?task=archived`: the same task archived (［戻す］, 経緯 「佐藤さんがアーカイブしました」).
// `?similar=1`: 部署に出す answers 「似ているやることがあります」 (the server's `similar`).
// `?kind=none`: a company without the shared folder (records.md "File links without the shared folder"): two files
// of the member's PC (メモ.md is on this PC, 消えた.md is not), a Drive file the member linked and one someone else
// linked; ［Google Drive のファイルをつなぐ］ logs `drive@<version>`, a link taken off `unlinkTarget <kind> <path|id>@<version>`,
// a Drive file opened `external <url>`.
// The owner-only task links a note in a `.personal/` folder (on this Mac); ［＋ 新しいファイル］ makes one through the
// screen's `createTodayFile` (`today <name>` in `#acted`, 「既存.md」 answers a taken name), and `file.open` is logged as `open <path>`.
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TaskCard } from '../src/features/tasks/components/TaskCard'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import type { AiRunView } from '../../shared/types/ai-runs'
import type { RecordSummary } from '../../shared/types/records'
import { taskCardOf } from '../shared/task-card'
import { installElectronAPI } from './ui/fixtures/electron-api'
import { commands } from '../src/shared/commands/commands'
import { fakeDropLink } from './ui/fixtures/link-drop'

const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const ME = 'u-sato'
const people = { [ME]: '佐藤', 'u-abe': '阿部', 'u-tanaka': '田中' }
const params = new URLSearchParams(location.search)
const done = params.get('task') === 'done'
const withSource = params.get('source') === '1'
const shared = params.get('shared') === '1'
const conflict = params.get('conflict') === '1'
// `?task=review`: 「議事録を確認する」 with its meeting's summary, two proposals (one put away) and decisions.
const reviewing = params.get('task') === 'review'
// `?bundle=none`: no 案件 yet, in a department that makes 案件 (［案件につなぐ］［新しい案件にする］).
const noBundle = params.get('bundle') === 'none'
// A task wider than the 案件 it is linked to (records.md "A task and its 案件・プロジェクト"): refused until narrowed.
const wider = params.get('wider') === '1'
// 「新しい〇〇にする」 with the member's own department (開発部) first.
const withPlaces = params.get('places') === '1'
// Who may make a 非公開 one: 開発部's manager, or a plain member.
const rights = params.get('rights')
// 返事待ち (task version 12): waiting, given back by the clock, or a plain task to make wait.
const waitMode = ['waiting', 'back', 'todo-team', 'todo-own'].includes(params.get('task') ?? '') ? params.get('task') : null
const plainTodo = waitMode === 'todo-team' || waitMode === 'todo-own'
// `?folders=1`: linked folders — one 2 members cannot open (`cannotOpen`), one left out on this Mac (総務); `folder.reveal` logs `reveal <path>`.
const withFolders = params.get('folders') === '1'
const menuMode = ['unassigned', 'archived'].includes(params.get('task') ?? '') ? params.get('task') : null
const noFolder = params.get('kind') === 'none'
const typedLinks = [
  { name: 'files', direction: 'out' as const, local: { path: '営業/メモ.md' } },
  { name: 'files', direction: 'out' as const, local: { path: '営業/消えた.md' } },
  { name: 'files', direction: 'out' as const, drive: { fileId: '1AbCdEfGhIjKlMnOp', mine: true, name: 'A社 提案書（下書き）', revisionId: 'rev-1', sha256: 'a'.repeat(64) } },
  { name: 'files', direction: 'out' as const, drive: { fileId: '1ZyXwVuTsRqPoNmLk', mine: false } },
]
const rec = (id: string, type: string, title: string, state: string | null, fields: RecordSummary['fields'] = {}, extra: Partial<RecordSummary> = {}): RecordSummary =>
  ({ id, type, typeVersion: 1, title, summary: '', path: null, state, fields, version: 3, updatedAt: '2026-11-05T06:00:00.000Z', ...extra })
const task = rec('task-0000aa', 'task', 'A社 見積書を 150万円 で作り直す', done ? 'done' : 'todo', {
  // 終わったら：確かめてから (task version 9): the assignee completes only by naming whose OK.
  assignee: ME, requested_by: 'u-abe', when_done: 'check', due: '2026-11-07T17:00', tags: '["営業","見積"]',
  prep_summary: '前回の見積と議事録を確かめ、窓口を3つにした下書きを作りました。',
  ...(done ? { ok_by: 'u-abe', ok_note: '電話で' } : {}),
}, shared ? {} : { personal: true })
const entries = (conflict ? [{ version: 4, action: 'set_due', actorId: 'u-abe', actorKind: 'human', at: '2026-11-05T07:00:00.000Z', note: '', fromState: null, toState: null, changes: [{ field: 'due', before: '2026-11-07T17:00', after: '2026-11-08T12:00' }] }] : done ? [{ version: 4, action: 'complete', actorId: ME, actorKind: 'human', at: '2026-11-05T07:00:00.000Z', note: '', fromState: 'in_progress', toState: 'done', changes: [{ field: 'ok_by', before: null, after: 'u-abe' }, { field: 'ok_note', before: null, after: '電話で' }] }] : []) as unknown as LedgerEntry[]
const runs = [{ id: 'run-1', recordId: 'task-0000aa', needsPerson: true, label: '外への操作の結果が分かりません。相手先で確かめてから続きを進めます', operations: [{ key: 'mail-send-1', kind: 'outbound', state: 'unknown', ref: null, updatedAt: '' }] }] as unknown as AiRunView[]
const meeting = rec('meeting-0000mm', 'meeting', 'A社 研修導入のお打ち合わせ', 'read', { summary_text: '窓口を3つに増やす方向で合意。' })
const reviewCard = taskCardOf({
  me: ME, defs, def: defs.get('task'), people, entries: [], runs: [],
  detail: { record: rec('task-0000rv', 'task', '議事録を確認する：A社 研修導入のお打ち合わせ', 'todo', { assignee: ME, requested_by: ME, task_kind: 'minutes_review' }),
    links: [{ name: 'meeting', direction: 'out', fixed: true, record: meeting }] },
  meeting: { record: meeting, links: [
    { name: 'meeting', direction: 'in', record: rec('decision-000001', 'decision', '窓口は3つにする', 'unconfirmed', {}) },
    { name: 'meeting', direction: 'in', record: rec('decision-000002', 'decision', '4月から始める', 'unconfirmed', {}) },
    { name: 'meeting', direction: 'in', record: rec('decision-000003', 'decision', '見積は今月中に出す', 'confirmed', { decided_by: 'u-abe' }) },
  ], decisionChecks: {
    // The server's answer (decision version 6): the member decides the first (a meeting reader, no 責任者 who reads it);
    // the second waits for its 責任者; 阿部さん (a 責任者) cannot read this meeting.
    'decision-000001': { may: { confirm: true, reject: true, retract: false }, responsible: [], cannotRead: ['u-abe'] },
    'decision-000002': { may: { confirm: false, reject: false, retract: false }, responsible: ['u-tanaka'], cannotRead: [] },
    'decision-000003': { may: { confirm: false, reject: false, retract: false }, responsible: [], cannotRead: [] },
  } },
})
const waitEntries = [
  { version: 1, action: 'create', actorId: 'u-abe', actorKind: 'human', at: '2026-11-02T00:00:00.000Z', note: '', fromState: null, toState: 'todo', changes: [] },
  { version: 2, action: 'wait', actorId: ME, actorKind: 'human', at: '2026-11-02T01:00:00.000Z', note: '', fromState: 'todo', toState: 'waiting', changes: [] },
  ...(waitMode === 'back' ? [{ version: 3, action: 'wait_over', actorId: 'acb:clock', actorKind: 'external', actorSource: 'ACB の時計', at: '2026-11-06T15:00:00.000Z', note: '返事の見込み（11/6）を過ぎました', fromState: 'waiting', toState: 'todo', changes: [] }] : []),
] as unknown as LedgerEntry[]
const waitCard = waitMode ? taskCardOf({
  me: ME, defs, def: defs.get('task'), people, runs: [], teamMode: waitMode !== 'todo-own', holidays: [],
  entries: plainTodo ? [] : waitEntries,
  detail: { record: rec('task-0000ww', 'task', 'A社 見積の回答をもらう', waitMode === 'waiting' ? 'waiting' : 'todo', {
    assignee: ME, requested_by: waitMode === 'todo-own' ? ME : 'u-abe', due: '2026-11-13',
    ...(plainTodo ? {} : { waiting_on: '先方からの返事', wait_until: '2026-11-06' }),
  }), links: [] },
}) : null
// The menu decisions of 2026-11-03: a task the member asked, nobody holding it yet; or archived.
const menuCard = menuMode ? taskCardOf({
  me: ME, defs, def: defs.get('task'), people, runs: [], teamMode: false, holidays: [],
  entries: (menuMode === 'archived' ? [
    { version: 1, action: 'create', actorId: ME, actorKind: 'human', at: '2026-11-02T00:00:00.000Z', note: '', fromState: null, toState: 'todo', changes: [] },
    { version: 2, action: 'cancel', actorId: ME, actorKind: 'human', at: '2026-11-03T00:00:00.000Z', note: '先方の都合で見送り', fromState: 'todo', toState: 'cancelled', changes: [] },
  ] : []) as unknown as LedgerEntry[],
  detail: { record: rec('task-0000un', 'task', '展示会の備品をそろえる', menuMode === 'archived' ? 'cancelled' : 'todo', { requested_by: ME, when_done: 'notify', due: '2026-11-13' }), links: [] },
}) : null
const shownCard = menuCard ?? waitCard ?? (reviewing ? reviewCard : taskCardOf({
  me: ME, defs, def: defs.get('task'), people, entries, runs: done ? [] : runs,
  ...(withFolders ? { cannotOpen: { '経理/月次': 2 } } : {}),
  detail: {
    record: task,
    links: [
      { name: 'prepared', direction: 'out', record: rec('outbound_message-01', 'outbound_message', 'お礼メール', 'draft') },
      ...(noBundle ? [] : [{ name: 'bundle', direction: 'out' as const, record: rec('deal-0001ab', 'deal', 'A社 問い合わせ対応の効率化', 'open') }]),
      { name: 'tasks', direction: 'in', record: rec('decision-0002', 'decision', '今回だけ20%値引き', 'confirmed', { exception: true }, { exceptionNotice: '例外' }) },
      ...(noFolder ? typedLinks : [
        { name: 'files', direction: 'out' as const, path: '営業/見積書_v2.xlsx', broken: false },
        // Never synced: the server calls it broken; this Mac has it.
        { name: 'files', direction: 'out' as const, path: '営業/.personal/inbox/日付別/2026/20261102/打ち合わせメモ.md', broken: true },
      ]),
      { name: 'related', direction: 'out', record: rec('task-0000bb', 'task', 'スケジュール案を出す', 'todo') },
      // The server says `folder: true` for a folder on the shared branch (records.md "Folder links").
      ...(withFolders ? [{ name: 'files', direction: 'out' as const, path: '経理/月次', broken: false, folder: true as const }, { name: 'files', direction: 'out' as const, path: '総務', broken: false }] : []),
      { name: 'meeting', direction: 'out', fixed: true, record: rec('meeting-0000cc', 'meeting', 'A社 打ち合わせ', 'read') },
      ...(withSource ? [{ name: 'interaction', direction: 'out' as const, fixed: true as const, record: rec('interaction-0000ii', 'interaction', 'Re: 見積のご相談', 'handled') }] : []),
    ],
  },
}))
const card = reviewing || waitCard || menuCard ? shownCard : { ...shownCard, viewers: { kind: 'only-you' as const, text: 'あなただけ', count: 1 } }
const acted: string[] = []
const show = (id: string, line: string) => { acted.push(line); document.getElementById(id)!.textContent = acted.join(',') }

installElectronAPI({
  getTaskCard: async () => ({ success: true, card }),
  dropLinkOnRecord: fakeDropLink(line => show('acted', line)),
  patchChatSession: async (_c, sessionId, patch) => { show('acted', `topic ${sessionId}=${String(patch.topicRecordId)}`); return {} as never },
  // The titles 「…に切り替えますか？」 names (a consultation about another やること dropped on the card).
  getConsultationTopics: async (_c, ids) => ({ success: true, topics: Object.fromEntries(ids.map(id => [id, {
    own: { id, title: id === 'task-0000bb' ? '会場を押さえる' : 'A社 見積書を 150万円 で作り直す', thing: 'task' as const, typeLabel: null, kindName: 'やること' }, bundle: null,
  }])) }),
  createBundle: async (_c, input) => { show('acted', `create ${input.type} ${input.title} folder=${input.folder ?? ''}`); return { success: true, recordId: 'deal-0009zz' } },
  linkRecordToRecord: async (_c, recordId, input) => {
    show('acted', `link ${recordId} ${input.link}=${input.target}@${input.expectedVersion}${input.narrow ? ' narrow' : ''}`)
    if (wider && !input.narrow) return { success: false, offline: false, code: 'WIDER_THAN_BUNDLE', error: 'このやることは、つなぐ先より多くの人に見えています。' }
    return { success: true, recordId, entryVersion: input.expectedVersion + 1 }
  },
  unlinkRecordFromRecord: async (_c, recordId, input) => { show('acted', `unlink ${recordId} ${input.link}=${input.target}@${input.expectedVersion}`); return { success: true, recordId, entryVersion: input.expectedVersion + 1 } },
  getBundleChoices: async () => ({ success: true, bundles: [{ id: 'deal-0001ab', title: 'A社 問い合わせ対応の効率化', typeLabel: '案件' }, { id: 'deal-0002cd', title: 'B社 新人研修', typeLabel: '案件' }] }),
  // `?proposals=none`: a member the type's `who` does not let press (an older server's type, not the requester).
  getTaskProposals: async () => {
    const may = params.get('proposals') === 'none'
      ? { adopt: false, dismiss: false, proposeAgain: false, keepApart: false }
      : { adopt: true, dismiss: true, proposeAgain: true, keepApart: true }
    return { success: true, readerId: ME, readerName: '佐藤', proposals: [
      { id: 'task-0000p1', title: '見積を直す', state: 'proposed', version: 1, assignee: ME, assigneeName: '佐藤', due: '2026-11-07T17:00',
        basis: '来週までに修正した見積をお送りします', addedBy: ME, addedByName: '佐藤', similarTo: null, may },
      { id: 'task-0000p2', title: 'セキュリティ資料を送る', state: 'proposed', version: 1, assignee: 'u-abe', assigneeName: '阿部', due: null,
        basis: 'セキュリティの資料もいただけますか', addedBy: 'u-abe', addedByName: '阿部', similarTo: null, may },
      { id: 'task-0000p4', title: '見積を直して送る', state: 'proposed', version: 1, assignee: ME, assigneeName: '佐藤', due: null,
        basis: '見積は金額を直してから送る', addedBy: 'u-abe', addedByName: '阿部', similarTo: { id: 'task-0000p1', title: '見積を直す' }, may },
      { id: 'task-0000p3', title: '会食の店を探す', state: 'dismissed', version: 2, assignee: ME, assigneeName: '佐藤', due: null,
        basis: null, addedBy: ME, addedByName: '佐藤', similarTo: null, may },
    ] }
  },
  actOnTask: async (_c, recordId, input) => {
    if (conflict) return { success: false, offline: false, code: 'VERSION_CONFLICT', error: 'ほかの人が先に変えました。' }
    // A tag the server refuses: the card shows its words.
    if ((input.args?.tags as string[] | undefined)?.includes('禁止')) return { success: false, offline: false, code: 'BAD_VALUE', error: 'このタグは付けられません。' }
    show('acted', `${input.action}@${input.expectedVersion}${input.note ? `:${input.note}` : ''}${input.ok ? `:ok=${input.ok.by ?? ''}/${input.ok.note ?? ''}` : ''}${input.args?.due ? `:due=${String(input.args.due)}` : ''}${input.args && 'waiting_on' in input.args ? `:on=${String(input.args.waiting_on)}` : ''}${input.args && 'wait_until' in input.args ? `:until=${String(input.args.wait_until)}` : ''}${input.args?.tags ? `:tags=${(input.args.tags as string[]).join('|')}` : ''}${['assignee', 'reviewer', 'when_done'].filter(k => input.args?.[k]).map(k => `:${k}=${String(input.args![k])}`).join('')}`)
    return { success: true, recordId }
  },
  undoTaskAction: async (_c, recordId, version, expected) => { show('acted', `undo ${version}@${expected}`); return { success: true, recordId } },
  linkFileToTask: async (_c, recordId, companyPath, version) => { show('acted', `link ${companyPath}@${version}`); return { success: true, recordId } },
  unlinkFileFromTask: async (_c, recordId, companyPath, version) => { show('acted', `unlink ${companyPath}@${version}`); return { success: true, recordId } },
  exists: async (path: string) => path.endsWith('打ち合わせメモ.md') || path.endsWith('/営業/メモ.md'),
  unlinkTargetFromTask: async (_c, recordId, target, version) => {
    show('acted', `unlinkTarget ${target.kind} ${target.kind === 'local' ? target.path : target.fileId}@${version}`)
    return { success: true, recordId, entryVersion: version + 1 }
  },
  linkDriveFilesToTask: async (_c, recordId, version, fileIds) => {
    show('acted', `drive@${version}${fileIds?.length ? ` show=${fileIds.join('+')}` : ''}`)
    // `?drive=slow`: the chooser stays open a while (the card is busy).
    if (params.get('drive') === 'slow') await new Promise(r => setTimeout(r, 1500))
    return { success: true, recordId, linked: ['B社 見積'] }
  },
  // `?drive=off`: the company has not set Drive up; `?drive=first`: offered, not allowed yet.
  getGoogleStatus: async () => ({ success: true, data: {
    available: true, reason: null, connected: true, status: 'active', googleEmail: 'me@div.example', domain: 'div.example', practice: false, featuresOff: [], seen: [],
    features: params.get('drive') === 'off' || params.get('drive') === 'first' ? ['minutes'] : ['minutes', 'drive'],
    companyFeatures: params.get('drive') === 'off' ? ['minutes', 'mail'] : ['minutes', 'mail', 'drive'],
  } as never }),
  openExternal: async (url: string) => { show('acted', `external ${url}`); return { success: true } as never },
  gitListFiles: async () => ({ success: true, files: ['営業/見積書_v2.xlsx', '営業/提案書.md', '経理/請求書.xlsx'] }),
  shareTask: async (_c, recordId, folder, version) => {
    show('acted', `share ${folder}@${version}`)
    return { success: true, recordId, ...(params.get('similar') === '1' ? { similar: { id: 'task-other01', title: 'A社に見積を送る' } } : {}) }
  },
  getPrivateFolderCreateContext: async () => ({ success: true, context: { role: 'member', managedDepartmentIds: rights === 'manager' ? ['d-dev'] : [], department: null, managerIds: [], members: [] } }),
  createPrivateFolder: async (_c, input) => { show('acted', `private ${input.parentPath}/${input.name}`); return { success: true, scopeId: 'scope-1', path: `${input.parentPath}/${input.name}`, viewerCount: 3 } },
  shareTaskToBundle: async (_c, recordId, version) => { show('acted', `share to bundle@${version}`); return { success: true, recordId } },
  suggestTaskTags: async (_c, title, inUse) => ({ source: 'ai', tags: title.includes('見積') ? inUse.filter(t => t === '経理') : [] }),
  reconcileTaskRun: async (_c, runId, key, isDone) => { show('acted', `reconcile ${runId} ${key} ${isDone}`); return { success: true, recordId: '' } },
})

commands.register('file.open', ({ path }) => { show('acted', `open ${path}`) })
commands.register('folder.reveal', ({ path }) => { show('acted', `reveal ${path}`) })
commands.register('record.open', ({ recordId }) => { show('acted', `open ${recordId}`) })
const TODAY = '営業/.personal/inbox/日付別/2026/20261103'
const createTodayFile = async (name: string) => {
  show('acted', `today ${name}`)
  return name === '既存.md' ? { error: '同じ名前のファイルまたはフォルダがすでにあります。別の名前にしてください。' } : { path: `${TODAY}/${name}` }
}

function Preview() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <pre id="acted" className="text-[10px]" />
      <TaskCard companyId="co-preview" rootPath="/Users/me/company" recordId={card.record.id} renderPrepared={r => <div data-testid="prepared">用意したもの：{r.title}</div>}
        renderSource={r => <div>元のメール：{r.title}</div>}
        shareFolders={[{ folder: '営業', name: '営業部' }, { folder: '経理', name: '経理部' }]}
        onConsult={(r, fresh) => show('acted', `consult ${r.id}${fresh ? ' fresh' : ''}`)}
        onNudge={r => show('acted', `nudge ${r.id}`)}
        bundleKind={{ type: 'deal', name: '案件', source: 'plugin' }} bundleFolder="営業部"
        {...(withPlaces ? { bundlePlaces: { defaultFolder: '開発部', choices: [
          { folder: '営業部', name: '営業部', kind: { type: 'deal', name: '案件', source: 'plugin' as const }, departmentId: 'd-sales' },
          { folder: '開発部', name: '開発部', kind: { type: 'project', name: 'プロジェクト', source: 'core' as const }, departmentId: 'd-dev' },
        ] } } : {})}
        consultations={params.get('consult') === 'none' ? [] : [{ sessionId: 's-1', title: '見積の相談', updatedAt: '2026-11-05T07:00:00.000Z' }]}
        sharedFolder={!noFolder} tagsInUse={['営業', '見積', '経理']} createTodayFile={createTodayFile} notDownloadedFolderOf={p => (p === '総務' || p.startsWith('総務/') ? '総務' : null)} onDetachConsultation={id => show('acted', `detach ${id}`)} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
