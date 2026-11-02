/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the task card (features/tasks): the real card over a fake main process whose
// card is built by the real `taskCardOf` from core type definitions. `?task=done` shows a task
// completed on someone's OK; `?shared=1` a task already shown to a department (no 「部署に出す」); `?source=1` gives the card a source
// (what a connector draws in the slot); `?conflict=1` answers every action with 「ほかの人が先に変えました」 after 阿部さん
// changed the due. Actions sent show in `#acted`, run answers in `#runs`.
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
    { name: 'meeting', direction: 'in', record: rec('decision-000001', 'decision', '窓口は3つにする', 'unconfirmed', { owner: ME }) },
    { name: 'meeting', direction: 'in', record: rec('decision-000002', 'decision', '4月から始める', 'unconfirmed', { owner: 'u-abe' }) },
  ] },
})
const shownCard = reviewing ? reviewCard : taskCardOf({
  me: ME, defs, def: defs.get('task'), people, entries, runs: done ? [] : runs,
  detail: {
    record: task,
    links: [
      { name: 'prepared', direction: 'out', record: rec('outbound_message-01', 'outbound_message', 'お礼メール', 'draft') },
      ...(noBundle ? [] : [{ name: 'bundle', direction: 'out' as const, record: rec('deal-0001ab', 'deal', 'A社 問い合わせ対応の効率化', 'open') }]),
      { name: 'tasks', direction: 'in', record: rec('decision-0002', 'decision', '今回だけ20%値引き', 'confirmed', { exception: true }, { exceptionNotice: '例外' }) },
      { name: 'files', direction: 'out', path: '営業/見積書_v2.xlsx', broken: false },
      { name: 'related', direction: 'out', record: rec('task-0000bb', 'task', 'スケジュール案を出す', 'todo') },
      { name: 'meeting', direction: 'out', fixed: true, record: rec('meeting-0000cc', 'meeting', 'A社 打ち合わせ', 'read') },
    ],
  },
})
const card = reviewing ? shownCard : { ...shownCard, viewers: { kind: 'only-you' as const, text: 'あなただけ', count: 1 } }
const acted: string[] = []
const show = (id: string, line: string) => { acted.push(line); document.getElementById(id)!.textContent = acted.join(',') }

installElectronAPI({
  getTaskCard: async () => ({ success: true, card }),
  createBundle: async (_c, input) => { show('acted', `create ${input.type} ${input.title} folder=${input.folder ?? ''}`); return { success: true, recordId: 'deal-0009zz' } },
  linkRecordToRecord: async (_c, recordId, input) => { show('acted', `link ${recordId} ${input.link}=${input.target}@${input.expectedVersion}`); return { success: true, recordId, entryVersion: input.expectedVersion + 1 } },
  unlinkRecordFromRecord: async (_c, recordId, input) => { show('acted', `unlink ${recordId} ${input.link}=${input.target}@${input.expectedVersion}`); return { success: true, recordId, entryVersion: input.expectedVersion + 1 } },
  getBundleChoices: async () => ({ success: true, bundles: [{ id: 'deal-0001ab', title: 'A社 問い合わせ対応の効率化', typeLabel: '案件' }, { id: 'deal-0002cd', title: 'B社 新人研修', typeLabel: '案件' }] }),
  getTaskProposals: async () => ({ success: true, proposals: [
    { id: 'task-0000p1', title: '見積を直す', state: 'proposed', version: 1, assignee: ME, assigneeName: '佐藤', due: '2026-11-07T17:00' },
    { id: 'task-0000p2', title: 'セキュリティ資料を送る', state: 'proposed', version: 1, assignee: 'u-abe', assigneeName: '阿部', due: null },
    { id: 'task-0000p3', title: '会食の店を探す', state: 'dismissed', version: 2, assignee: ME, assigneeName: '佐藤', due: null },
  ] }),
  actOnTask: async (_c, recordId, input) => {
    if (conflict) return { success: false, offline: false, code: 'VERSION_CONFLICT', error: 'ほかの人が先に変えました。' }
    show('acted', `${input.action}@${input.expectedVersion}${input.note ? `:${input.note}` : ''}${input.ok ? `:ok=${input.ok.by ?? ''}/${input.ok.note ?? ''}` : ''}${input.args?.due ? `:due=${String(input.args.due)}` : ''}${input.args?.tags ? `:tags=${(input.args.tags as string[]).join('|')}` : ''}`)
    return { success: true, recordId }
  },
  undoTaskAction: async (_c, recordId, version, expected) => { show('acted', `undo ${version}@${expected}`); return { success: true, recordId } },
  linkFileToTask: async (_c, recordId, companyPath, version) => { show('acted', `link ${companyPath}@${version}`); return { success: true, recordId } },
  unlinkFileFromTask: async (_c, recordId, companyPath, version) => { show('acted', `unlink ${companyPath}@${version}`); return { success: true, recordId } },
  gitListFiles: async () => ({ success: true, files: ['営業/見積書_v2.xlsx', '営業/提案書.md', '経理/請求書.xlsx'] }),
  shareTask: async (_c, recordId, folder, version) => { show('acted', `share ${folder}@${version}`); return { success: true, recordId } },
  suggestTaskTags: async (_c, title, inUse) => ({ source: 'ai', tags: title.includes('見積') ? inUse.filter(t => t === '経理') : [] }),
  reconcileTaskRun: async (_c, runId, key, isDone) => { show('acted', `reconcile ${runId} ${key} ${isDone}`); return { success: true, recordId: '' } },
})

function Preview() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <pre id="acted" className="text-[10px]" />
      <TaskCard companyId="co-preview" rootPath="/Users/me/company" recordId={card.record.id} renderPrepared={r => <div data-testid="prepared">用意したもの：{r.title}</div>}
        renderSource={r => withSource ? <div>元のメール：{r.title}</div> : null}
        shareFolders={[{ folder: '営業', name: '営業部' }, { folder: '経理', name: '経理部' }]}
        onConsult={(r, fresh) => show('acted', `consult ${r.id}${fresh ? ' fresh' : ''}`)}
        bundleKind={{ type: 'deal', name: '案件', source: 'plugin' }} bundleFolder="営業部"
        consultations={[{ sessionId: 's-1', title: '見積の相談', updatedAt: '2026-11-05T07:00:00.000Z' }]}
        tagsInUse={['営業', '見積', '経理']} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
