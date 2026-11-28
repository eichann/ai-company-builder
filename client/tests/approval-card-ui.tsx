/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the chat's approval card (承認のお願い, client/shared/approvals.ts): a reply
// holding a `data-approval` reference; the card reads the request through the fake preload API.
// `?viewer=approver` (default) may approve; `?viewer=requester` asked for it and may not.
// `?kind=create`: a new deal with similar existing ones (plugins.md "Similar records").
// What 「承認」 / 「同じ」 sent is shown in `#sent` for the spec.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { APPROVAL_PART_TYPE, type ApprovalCardRef } from '../shared/approvals'
import type { ApprovalView } from '../../shared/types/approvals'
import { installElectronAPI } from './ui/fixtures/electron-api'
import { JOB_PROPOSAL_PART_TYPE } from '../shared/job-proposals'
import { MANUAL_JOB_DEFINITION, MANUAL_JOB_FINGERPRINT } from './ui/fixtures/manual-job'

const params = new URLSearchParams(location.search)
// `?theme=dark` for dark mode (the status-colours spec reads the card's awaiting frame in both themes).
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const approver = params.get('viewer') !== 'requester'
const HASH = `sha256:${'9c1e'.repeat(16)}`

const updateView: ApprovalView = {
  id: 'approval-preview0001', state: 'pending', recordVersion: 1, pluginId: 'hubspot', operation: 'update_deal',
  operationLabel: '案件の欄を HubSpot に書き戻す', systemLabel: 'HubSpot', recordId: 'deal-preview01', recordTitle: '研修導入（検証A社）',
  changes: [{ field: 'amount', label: '金額', before: 1200000, after: 1500000, beforeShown: '1,200,000', afterShown: '1,500,000', changePercent: 25 }],
  create: null, similar: null,
  basis: { meetingId: 'meeting-preview01', meetingTitle: '11/5 商談', quote: 'チャット窓口も最初から入れたい' },
  precedents: { total: 1, items: [{ approvalId: 'approval-preview0000', at: '2026-09-02T10:00:00.000Z', state: 'approved', fields: [{ label: '金額', beforeShown: '800,000', afterShown: '1,000,000' }], reason: '対象部署が増えたため', nowShown: [{ label: '金額', shown: '1,000,000' }] }] },
  materials: [{ kind: 'record', recordId: 'deal-preview01', title: '研修導入（検証A社）', version: 9 }, { kind: 'meeting', recordId: 'meeting-preview01', title: '11/5 商談', version: null }],
  proposedReason: '先方が対象を広げたいと言ったため', requestedBy: 'u-sato', requestedByAi: true, approver: 'u-abe', approverRule: 'dept_manager', approverRuleLabel: '部署の管理役',
  hash: HASH, version: 1, createdAt: '2026-11-05T06:41:00.000Z', viewerMayApprove: approver, viewerIsRequester: !approver, outcome: null,
}
const createView: ApprovalView = {
  ...updateView, operation: 'create_deal', operationLabel: '取引を新しく作る', recordId: null, recordTitle: null, changes: [],
  create: { title: '生成AI研修（検証A社）', fields: [{ label: '次のアクション', shown: '提案書を送る' }] },
  similar: {
    typeLabel: '案件', outside: 'checked',
    items: [
      { recordId: 'deal-preview02', title: '研修導入（検証A社）', status: '提案', assignee: 'u-sato', updatedAt: '2026-10-30T01:00:00.000Z', matchedBy: 'counterpart' },
      { recordId: 'deal-preview03', title: '生成AI研修 2期（見本商事）', status: '初回面談', assignee: null, updatedAt: '2026-10-01T01:00:00.000Z', matchedBy: 'name' },
    ],
  },
  precedents: { total: 0, items: [] }, materials: [],
}
// `?manual=1`: the user manual's picture (manual/README.md): a fictional system name, nothing real.
const manualView: ApprovalView = { ...updateView, pluginId: 'customer-ledger', operationLabel: '案件の金額を顧客台帳に書き戻す', systemLabel: '顧客台帳' }
const view = params.get('kind') === 'create' ? createView : params.get('manual') === '1' ? manualView : updateView
// `?manual=1&viewer=requester` (or `&approver=sato`, the approver's side): the manual's chapter 23 — 山田さん asked, 佐藤さん
// decides (the same ids, other names). `?manual=1` alone keeps chapter 8's names.
const swapped = params.get('manual') === '1' && (!approver || params.get('approver') === 'sato')
const names = swapped ? { 'u-sato': '山田', 'u-abe': '佐藤' } : { 'u-sato': '佐藤', 'u-abe': '山田' }

// `?offline=1`: the first 「承認」 (and 「これで管理者に出す」 with `?card=job`) gets no answer — the connection drops, and every
// read fails until the page calls `window.__acbOnline()` (`&recover=auto`: by itself a second later). `&landed=1`: the press
// had reached the server (the read then shows it done); else it had not, and the next press goes through. `#presses` counts
// the presses that reached the fake server.
const OFFLINE = params.get('offline') === '1'
const LANDED = params.get('landed') === '1'
const OFFLINE_ANSWER = { success: false as const, offline: true, code: null, error: 'サーバーに接続できませんでした。' }
const net = { online: true, dropped: false, landed: false, presses: 0 }
const showPresses = () => { document.getElementById('presses')!.textContent = String(net.presses) }
;(window as unknown as { __acbOnline: () => void }).__acbOnline = () => { net.online = true }
/** One press over the fake network: the first one under `?offline=1` drops the connection (reaching the server or not). */
const press = (): 'answered' | 'dropped' => {
  if (OFFLINE && !net.dropped) {
    net.dropped = true
    net.online = false
    if (params.get('recover') === 'auto') setTimeout(() => { net.online = true }, 1000)
    if (LANDED) { net.landed = true; net.presses += 1; showPresses() }
    return 'dropped'
  }
  net.landed = true
  net.presses += 1
  showPresses()
  return 'answered'
}
const approvedView = (reason: string): ApprovalView => ({ ...view, state: 'approved', viewerMayApprove: false, outcome: { at: '2026-11-05T07:05:00.000Z', by: 'u-abe', onBehalfOf: null, note: reason, resultOperationId: 'op-1' } })
const JOB_CANDIDATE_ID = 'jc.' + 'a'.repeat(32)
const jobCandidate = { id: JOB_CANDIDATE_ID, definition: MANUAL_JOB_DEFINITION, fingerprint: MANUAL_JOB_FINGERPRINT, expiresAt: '2026-11-21T01:30:00.000Z', timeZone: 'Asia/Tokyo' }
const jobProposal = { id: 'jp.' + 'b'.repeat(32), jobId: 'job.' + '1'.repeat(32), proposerId: 'u-sato', candidateId: JOB_CANDIDATE_ID, submittedVersion: 1, submittedFingerprint: MANUAL_JOB_FINGERPRINT, state: 'submitted' as const, returnReason: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-20T01:30:00.000Z' }

function Preview() {
  const [sent, setSent] = useState<string>('')
  installElectronAPI({
    getApproval: async () => (net.online ? { success: true, approval: net.landed ? approvedView('先方が対象を広げたいと言ったため') : view, names } : OFFLINE_ANSWER),
    approveApproval: async (_companyId, _id, hash, reason) => {
      setSent(JSON.stringify({ hash, reason }))
      if (press() === 'dropped') return OFFLINE_ANSWER
      return { success: true, approval: approvedView(reason), names }
    },
    getJobCandidate: async () => (net.online ? { success: true, candidate: jobCandidate, proposal: net.landed ? jobProposal : null } : OFFLINE_ANSWER),
    submitJobProposal: async () => (press() === 'dropped' ? OFFLINE_ANSWER : { success: true, proposal: jobProposal }),
    sameAsApproval: async (_companyId, _id, recordId, linkMeeting) => {
      setSent(JSON.stringify({ recordId, linkMeeting }))
      return { success: true, approval: { ...view, state: 'withdrawn', similar: null, viewerMayApprove: false, outcome: { at: '2026-11-05T07:05:00.000Z', by: 'u-abe', onBehalfOf: null, note: 'すでにある記録と同じため、作りませんでした', resultOperationId: null } }, names, meeting: 'linked' }
    },
  })
  const ref: ApprovalCardRef = { id: 'card-1', companyId: 'co-preview', conversationId: 'conv-1', approvalId: view.id, origin: approver ? 'shown' : 'requested', at: '2026-11-05T06:41:00.000Z' }
  // `?card=job`: a 「定期の仕事の案」 card instead (the same unknown-answer handling).
  const jobRef = { id: 'jp-card-1', companyId: 'co-preview', conversationId: 'conv-1', candidateId: JOB_CANDIDATE_ID, at: '2026-11-20T01:30:00.000Z' }
  const parts = (params.get('card') === 'job'
    ? [{ type: 'text', text: '定期の仕事の案を作りました。' }, { type: JOB_PROPOSAL_PART_TYPE, id: 'job-proposal-card-1', data: jobRef }]
    : [{ type: 'text', text: '承認のお願いを出しました。' }, { type: APPROVAL_PART_TYPE, id: 'approval-card-1', data: ref }]) as UIMessage['parts']
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。本番の相談には接続しません。</p>
      <section className="mx-auto max-w-xl"><AssistantMessageParts parts={parts} isStreaming={false} markdown /></section>
      <pre id="sent">{sent}</pre>
      <pre id="presses">0</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
