/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the task card (features/tasks): the real card over a fake main process whose
// card is built by the real `taskCardOf` from core type definitions. `?task=done` shows a task
// completed on someone's OK. Actions sent show in `#acted`, run answers in `#runs`.
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
const done = new URLSearchParams(location.search).get('task') === 'done'
const rec = (id: string, type: string, title: string, state: string | null, fields: RecordSummary['fields'] = {}, extra: Partial<RecordSummary> = {}): RecordSummary =>
  ({ id, type, typeVersion: 1, title, summary: '', path: null, state, fields, version: 3, updatedAt: '2026-11-05T06:00:00.000Z', ...extra })
const task = rec('task-0000aa', 'task', 'A社 見積書を 150万円 で作り直す', done ? 'done' : 'todo', {
  assignee: ME, requested_by: 'u-abe', due: '2026-11-07T17:00', tags: '["営業","見積"]',
  prep_summary: '前回の見積と議事録を確かめ、窓口を3つにした下書きを作りました。',
  ...(done ? { ok_by: 'u-abe', ok_note: '電話で' } : {}),
}, { personal: true })
const entries = (done ? [{ version: 4, action: 'complete', actorId: ME, actorKind: 'human', at: '2026-11-05T07:00:00.000Z', note: '', fromState: 'in_progress', toState: 'done', changes: [{ field: 'ok_by', before: null, after: 'u-abe' }, { field: 'ok_note', before: null, after: '電話で' }] }] : []) as unknown as LedgerEntry[]
const runs = [{ id: 'run-1', recordId: 'task-0000aa', needsPerson: true, label: '外への操作の結果が分かりません。相手先で確かめてから続きを進めます', operations: [{ key: 'mail-send-1', kind: 'outbound', state: 'unknown', ref: null, updatedAt: '' }] }] as unknown as AiRunView[]
const card = taskCardOf({
  me: ME, defs, def: defs.get('task'), people, entries, runs: done ? [] : runs,
  detail: {
    record: task,
    links: [
      { name: 'prepared', direction: 'out', record: rec('outbound_message-01', 'outbound_message', 'お礼メール', 'draft') },
      { name: 'bundle', direction: 'out', record: rec('deal-0001ab', 'deal', 'A社 問い合わせ対応の効率化', 'open') },
      { name: 'tasks', direction: 'in', record: rec('decision-0002', 'decision', '今回だけ20%値引き', 'confirmed', { exception: true }, { exceptionNotice: '例外' }) },
      { name: 'files', direction: 'out', path: '営業/見積書_v2.xlsx', broken: false },
    ],
  },
})
const acted: string[] = []
const show = (id: string, line: string) => { acted.push(line); document.getElementById(id)!.textContent = acted.join(',') }

installElectronAPI({
  getTaskCard: async () => ({ success: true, card }),
  actOnTask: async (_c, recordId, input) => {
    show('acted', `${input.action}@${input.expectedVersion}${input.note ? `:${input.note}` : ''}${input.ok ? `:ok=${input.ok.by ?? ''}/${input.ok.note ?? ''}` : ''}${input.args?.due ? `:due=${String(input.args.due)}` : ''}`)
    return { success: true, recordId }
  },
  linkFileToTask: async (_c, recordId, companyPath, version) => { show('acted', `link ${companyPath}@${version}`); return { success: true, recordId } },
  unlinkFileFromTask: async (_c, recordId, companyPath, version) => { show('acted', `unlink ${companyPath}@${version}`); return { success: true, recordId } },
  gitListFiles: async () => ({ success: true, files: ['営業/見積書_v2.xlsx', '営業/提案書.md', '経理/請求書.xlsx'] }),
  reconcileTaskRun: async (_c, runId, key, isDone) => { show('acted', `reconcile ${runId} ${key} ${isDone}`); return { success: true, recordId: '' } },
})

function Preview() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <pre id="acted" className="text-[10px]" />
      <TaskCard companyId="co-preview" rootPath="/Users/me/company" recordId="task-0000aa" renderPrepared={r => <div data-testid="prepared">用意したもの：{r.title}</div>} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
