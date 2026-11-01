/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the card's 元のスレッド (outbound-mail.md "Replies"), composed as the screen does
// (src/app/recordSource.tsx): a Slack 連絡 with its thread and the member's reply draft, and a task
// whose 連絡 the member cannot see (the server's 404: nothing shown). The fake main writes the hash
// a send carried and the edit it received into lines the spec reads.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { renderRecordSource } from '../src/app/recordSource'
import { useAppStore } from '../src/stores/appStore'
import type { OutboundMailView } from '../../shared/types/outbound-mail'
import type { ThreadView } from '../shared/threads'
import { installElectronAPI } from './ui/fixtures/electron-api'

useAppStore.setState({ currentCompany: { id: 'co-preview', name: 'プレビュー株式会社', rootPath: '/preview', departments: [], createdAt: new Date() } })

const SHOWN_HASH = `sha256:${'b2'.repeat(32)}`
const reply: OutboundMailView = {
  id: 'outbound_message-0123456789abcdef', state: 'draft', version: 1, hash: SHOWN_HASH, channel: 'slack', interactionId: 'interaction-0123456789ab',
  from: 'sato@div.example', to: [], cc: [], subject: '', body: '承知しました。明日までにお送りします。', bodyDeleted: false, linkCount: 0,
  meetingId: null, bundleId: null, sentAt: null, providerMessageId: null, lastChangedBy: 'ai', updatedAt: '2026-11-02T03:10:00Z',
}
const thread: ThreadView = {
  recordId: 'interaction-0123456789ab', interactionId: 'interaction-0123456789ab', channel: 'chat', more: false, unavailable: null,
  messages: [
    { id: '1793400000.000100', fromName: '鈴木 一郎', fromAddress: null, to: [], cc: [], at: '2026-11-02T03:00:00Z', subject: null, text: '見積をいただけますか？', truncated: false, mine: false },
    { id: '1793400100.000100', fromName: null, fromAddress: null, to: [], cc: [], at: '2026-11-02T03:05:00Z', subject: null, text: '確認します', truncated: false, mine: true },
  ],
  replies: [{ id: reply.id, state: 'draft', channel: 'slack' }],
}

let report: (line: string) => void = () => {}
installElectronAPI({
  getRecordThread: async (_companyId, recordId) => (recordId === thread.recordId ? { success: true, thread } : { success: false, none: true }),
  getOutboundMail: async () => ({ success: true, draft: reply }),
  updateOutboundMail: async (_companyId, _messageId, edit) => {
    report(`edit ${JSON.stringify(edit)}`)
    return { success: true, draft: { ...reply, version: 2, body: edit.body ?? reply.body } }
  },
  sendOutboundMail: async (_companyId, _messageId, hash) => {
    report(`send ${hash}`)
    return { success: true, outcome: 'sent', draft: { ...reply, state: 'sent', sentAt: '2026-11-02T03:12:00Z', providerMessageId: '1793400200.000100' } }
  },
})

const summary = (id: string, type: string) => ({ id, type, typeLabel: type, kind: 'other' as const, title: 't', summary: '', stateLabel: null, updatedAt: '2026-11-02T03:00:00Z' })

function Preview() {
  const [lines, setLines] = useState<string[]>([])
  report = line => setLines(l => [...l, line])
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。本番の Slack には送りません。</p>
      <section aria-label="連絡のカード" className="mx-auto max-w-xl">{renderRecordSource('co-preview', summary(thread.recordId, 'interaction'))}</section>
      <section aria-label="見えない連絡のタスク" className="mx-auto mt-6 max-w-xl">{renderRecordSource('co-preview', summary('task-0123456789ab', 'task'))}<p>ここまで</p></section>
      <ul aria-label="メインが受け取ったもの">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
