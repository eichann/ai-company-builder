/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the chat's approval card (承認のお願い, client/shared/approvals.ts): a reply
// holding a `data-approval` reference; the card reads the request through the fake preload API.
// `?viewer=approver` (default) may approve; `?viewer=requester` asked for it and may not.
// What 「承認」 sent is shown in `#sent` for the spec.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { APPROVAL_PART_TYPE, type ApprovalCardRef } from '../shared/approvals'
import type { ApprovalView } from '../../shared/types/approvals'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
const approver = params.get('viewer') !== 'requester'
const HASH = `sha256:${'9c1e'.repeat(16)}`

const view: ApprovalView = {
  id: 'approval-preview0001', state: 'pending', recordVersion: 1, pluginId: 'hubspot', operation: 'update_deal',
  operationLabel: '案件の欄を HubSpot に書き戻す', systemLabel: 'HubSpot', recordId: 'deal-preview01', recordTitle: '研修導入（プレビュー株式会社）',
  changes: [{ field: 'amount', label: '金額', before: 1200000, after: 1500000, beforeShown: '1,200,000', afterShown: '1,500,000', changePercent: 25 }],
  create: null, similar: null,
  basis: { minutesId: 'minutes-preview01', minutesTitle: '11/5 商談', quote: 'チャット窓口も最初から入れたい' },
  precedents: { total: 1, items: [{ approvalId: 'approval-preview0000', at: '2026-09-02T10:00:00.000Z', state: 'approved', fields: [{ label: '金額', beforeShown: '800,000', afterShown: '1,000,000' }], reason: '対象部署が増えたため', nowShown: [{ label: '金額', shown: '1,000,000' }] }] },
  materials: [{ kind: 'record', recordId: 'deal-preview01', title: '研修導入（プレビュー株式会社）', version: 9 }, { kind: 'minutes', recordId: 'minutes-preview01', title: '11/5 商談', version: null }],
  proposedReason: '先方が対象を広げたいと言ったため', requestedBy: 'u-sato', requestedByAi: true, approver: 'u-abe', approverRule: 'dept_manager', approverRuleLabel: '部署の責任者',
  hash: HASH, version: 1, createdAt: '2026-11-05T06:41:00.000Z', viewerMayApprove: approver, viewerIsRequester: !approver, outcome: null,
}
const names = { 'u-sato': '佐藤', 'u-abe': '阿部' }

function Preview() {
  const [sent, setSent] = useState<string>('')
  installElectronAPI({
    getApproval: async () => ({ success: true, approval: view, names }),
    approveApproval: async (_companyId, _id, hash, reason) => {
      setSent(JSON.stringify({ hash, reason }))
      return { success: true, approval: { ...view, state: 'approved', viewerMayApprove: false, outcome: { at: '2026-11-05T07:05:00.000Z', by: 'u-abe', note: reason, resultOperationId: 'op-1' } }, names }
    },
  })
  const ref: ApprovalCardRef = { id: 'card-1', companyId: 'co-preview', conversationId: 'conv-1', approvalId: view.id, origin: approver ? 'shown' : 'requested', at: '2026-11-05T06:41:00.000Z' }
  const parts = [{ type: 'text', text: '承認のお願いを出しました。' }, { type: APPROVAL_PART_TYPE, id: 'approval-card-1', data: ref }] as UIMessage['parts']
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。本番の相談には接続しません。</p>
      <section className="mx-auto max-w-xl"><AssistantMessageParts parts={parts} isStreaming={false} markdown /></section>
      <pre id="sent">{sent}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
