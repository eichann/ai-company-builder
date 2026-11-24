// Preview of 「会議のあと」 (4b-4 PR6-A) as AppShell composes it under a job's やること (entry only). The preload API is faked:
// `readAfterMeeting` answers the run's files from the data below, `noteAfterMeeting` keeps the mark here (refusing an item
// already handed on, as main does), and every press is listed in window.__acbAfterMeeting.
// /tests/after-meeting-ui.html (&off=1: the company's switch off; &weekly=1: the Friday report's やること; &result=approval:
// a result waiting for 田中さん's approval; &theme=dark)
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { AfterMeetingPart } from '../src/features/after-meeting/entry'
import { commands } from '../src/shared/commands/commands'
import { EMPTY_MARK, itemKey, refusedKeys, type AfterMeetingMark, type AfterMeetingRead, type ResultItem } from '../shared/after-meeting'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const HEX = 'b'.repeat(32)
const asked: unknown[] = []
;(window as unknown as { __acbAfterMeeting: unknown[] }).__acbAfterMeeting = asked

let mark: AfterMeetingMark = { ...EMPTY_MARK, applies: [], undone: [] }
const results: ResultItem[] = params.get('result') === 'approval'
  ? [{ 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '1001', 項目: '金額', 状態: '承認待ち', 承認: 'approval-abc123', 承認する人: '田中' }]
  : []
if (results.length > 0) mark = { ...mark, applies: [{ id: 'a-0000000000000001', at: new Date().toISOString(), kind: 'apply', keys: [itemKey(results[0])] }] }

const read = (): AfterMeetingRead => ({
  success: true, mark, results, meetingId: 'meeting-abc123', problem: null, stages: ['A（高）', 'B（中）', 'C（低）'],
  run: { folder: '営業/.personal/提案書/2026-11-24_サンプル社', decision: 'proceed', confidence: 0.9, minutesDocVersion: 'notes:7', at: new Date().toISOString() },
  proposals: [
    { 書き先: 'hubspot', 取引: '1001', 項目: '確度', 値: 'B（中）', 根拠: '来月から始めたいと先方が話した', 理由: '導入時期が決まった' },
    { 書き先: 'hubspot', 取引: '1001', 項目: '金額', 値: 300000 },
    { 書き先: '係数表', 取引: '1001', 項目: '計上月', 値: [{ 月: '2026-12', 金額: 300000 }] },
  ],
})

installElectronAPI({
  readAfterMeeting: async () => { asked.push({ read: true }); return read() },
  noteAfterMeeting: async (_c, _r, _o, change) => {
    asked.push({ note: change })
    if (change.kind === 'apply' || change.kind === 'undo') {
      if (refusedKeys(change, mark, results, Date.now()).length > 0) return { success: false, code: 'ALREADY', error: 'この項目は、もう反映しているか、反映の途中です。画面を読み直しました。' }
      mark = { ...mark, applies: [...mark.applies, { id: change.id, at: new Date().toISOString(), kind: change.kind, keys: change.keys, ...(change.kind === 'apply' ? { items: change.items } : {}) }] }
    } else if (change.kind === 'draft-dismissed') mark = { ...mark, draftDismissed: true }
    else if (change.kind === 'cancel') mark = { ...mark, applies: mark.applies.filter(a => a.id !== change.id) }
    return { success: true, mark }
  },
})
// `&nostart=1`: the chat pane does not take it (no consultation starts): the card takes its press back.
commands.register('chat.consultAbout', args => { asked.push({ consult: args }); return params.get('nostart') === '1' ? undefined : true }, { target: 'chat' })
commands.register('record.open', args => { asked.push({ open: args }) })

const weekly = params.get('weekly') === '1'
createRoot(document.getElementById('root')!).render(
  <div className="max-w-3xl bg-bg p-4">
    <AfterMeetingPart enabled={params.get('off') !== '1'} companyId="co1" rootPath="/Users/demo/会社" busy={false}
      onComplete={async () => { asked.push({ complete: true }); return null }}
      task={{ id: `task-${HEX}`, title: weekly ? '今週の定例レポートを作る' : '11月24日の会議のたたき台を確かめる', madeAt: '2026-11-27T00:05:00.000Z', open: true }} />
  </div>,
)
