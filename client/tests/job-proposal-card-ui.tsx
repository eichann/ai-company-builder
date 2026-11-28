/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview of the 「定期の仕事の案」 card changed in place (UX 段3 #13; jobs.md "Member proposals" "The card changed in place"):
// the real AssistantMessageParts with a `data-job-proposal` reference, the preload API faked as the server would answer.
// Fictional data only. What the page offers the spec:
//   ?hold=1                     a change's answer waits until `window.__acbRelease()` (the 「確かめています」 state)
//   ?lost=1                     a change is made on the server, its answer lost
//   ?reads=none                 the candidate reads only its check's place (「営業部/訪問メモ」), no other read place
//   window.__acbChangeElsewhere()  the server's candidate is changed by someone else's card (the card still shows the old one)
//   `#revised`                  every change sent (its fingerprint and the input), `#submitted` every 出す's fingerprint
//   `#tab`                      ［大きく開く（タブ）］ opens the same card here, as AppShell's tab does
// A change naming 「総務部/人事評価」 is refused as the server refuses a place the member cannot use (409 JOB_CANDIDATE_PLACE).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { renderJobProposalTab, type JobProposalTabTarget } from '../src/features/chat/jobProposalTab'
import { useCommandHandler } from '../src/shared/commands/commands'
import { useAppStore } from '../src/stores/appStore'
import { JOB_PROPOSAL_PART_TYPE, jobReviseRefusalText, jobProposalRefusalText } from '../shared/job-proposals'
import { proposalDefinition, proposalInputOf, type JobCandidateInput } from '../../shared/core/job-proposals'
import { parseJobDefinition, type JobDefinition } from '../../shared/core/jobs'
import type { JobProposalView } from '../../shared/types/job-proposals'
import { installElectronAPI } from './ui/fixtures/electron-api'
import { MANUAL_JOB_DEFINITION } from './ui/fixtures/manual-job'

const params = new URLSearchParams(location.search)
const COMPANY = 'co-preview'
const CANDIDATE = 'jc.' + 'a'.repeat(32)
const REFUSED_PLACE = '総務部/人事評価'
useAppStore.setState({ currentCompany: { id: COMPANY, name: 'デモ株式会社', rootPath: '/preview/company', departments: [], createdAt: new Date('2026-11-20T00:00:00Z'), folderKind: 'git' } })

const fingerprintOf = (n: number) => `sha256:${n.toString(16).padStart(2, '0').repeat(32)}`
const build = (input: JobCandidateInput): JobDefinition => (parseJobDefinition(proposalDefinition(input, {
  actingUser: 'u-yamada', procedure: { source: 'company_skill', skill: input.skill, fingerprint: 'c'.repeat(40) }, skillName: input.skill, candidateId: CANDIDATE,
})) as { definition: JobDefinition }).definition

// The server's candidate: what every read answers.
let serial = 1
let server = {
  // `?reads=none`: the candidate reads no place besides the one its check looks at.
  definition: params.get('reads') === 'none' ? build({ ...proposalInputOf(MANUAL_JOB_DEFINITION)!, reads: [] }) : MANUAL_JOB_DEFINITION,
  fingerprint: fingerprintOf(serial),
}
const view = () => ({ id: CANDIDATE, definition: server.definition, fingerprint: server.fingerprint, expiresAt: '2026-11-21T01:30:00.000Z', timeZone: 'Asia/Tokyo' })
let release: () => void = () => {}
let submitted: JobProposalView | null = null
const w = window as unknown as { __acbRelease: () => void; __acbChangeElsewhere: () => void }
w.__acbRelease = () => release()
w.__acbChangeElsewhere = () => {
  const input = proposalInputOf(server.definition)!
  server = { definition: build({ ...input, minutes: 30 }), fingerprint: fingerprintOf(++serial) }
}
const log = (id: string, line: string) => { const el = document.getElementById(id); if (el) el.textContent += `${line}\n` }

installElectronAPI({
  getJobCandidate: async () => ({ success: true, candidate: view(), proposal: submitted }),
  reviseJobCandidate: async (_company, _id, fingerprint, input) => {
    log('revised', JSON.stringify({ fingerprint, input }))
    if (params.get('hold') === '1') await new Promise<void>(resolve => { release = resolve })
    if (fingerprint !== server.fingerprint) return { success: false, offline: false, code: 'JOB_VERSION_FINGERPRINT', error: jobReviseRefusalText('JOB_VERSION_FINGERPRINT') }
    const places = [...input.reads, ...(input.check.kind === 'new_files' ? [input.check.path] : []), ...(input.deliverable ? [input.deliverable] : [])]
    if (places.includes(REFUSED_PLACE)) return { success: false, offline: false, code: 'JOB_CANDIDATE_PLACE', error: jobReviseRefusalText('JOB_CANDIDATE_PLACE') }
    server = { definition: build(input), fingerprint: fingerprintOf(++serial) }
    // `?lost=1`: the change is made on the server but its answer never arrives (offline / a 5xx).
    if (params.get('lost') === '1') return { success: false, offline: true, code: null, error: 'サーバーに接続できません。' }
    return { success: true, candidate: view() }
  },
  submitJobProposal: async (_company, _id, fingerprint) => {
    log('submitted', fingerprint)
    if (fingerprint !== server.fingerprint) return { success: false, offline: false, code: 'JOB_VERSION_FINGERPRINT', error: jobProposalRefusalText('JOB_VERSION_FINGERPRINT') }
    submitted = { id: 'jp.' + 'b'.repeat(32), jobId: 'job.' + '1'.repeat(32), proposerId: 'u-yamada', candidateId: CANDIDATE, submittedVersion: 1, submittedFingerprint: fingerprint, state: 'submitted', returnReason: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-20T01:40:00.000Z' }
    return { success: true, proposal: submitted }
  },
  getDepartments: async () => ({ success: true, data: [] }),
  readDirectoryTree: async () => [
    { name: '営業部', isDirectory: true, path: '/preview/company/営業部', children: [
      { name: '訪問メモ', isDirectory: true, path: '' }, { name: '提案書', isDirectory: true, path: '' }, { name: '週報', isDirectory: true, path: '' },
      { name: '資料', isDirectory: true, path: '' }, { name: '.personal', isDirectory: true, path: '' },
    ] },
    { name: '総務部', isDirectory: true, path: '/preview/company/総務部', children: [{ name: '人事評価', isDirectory: true, path: '' }] },
  ],
  readDirectory: async () => [{ name: 'weekly-report', isDirectory: true, path: '' }, { name: 'minutes-summary', isDirectory: true, path: '' }],
})

const ref = { id: 'jp-card-1', companyId: COMPANY, conversationId: 'conv-1', candidateId: CANDIDATE, at: '2026-11-20T01:30:00.000Z' }
const parts = [{ type: 'text', text: '定期の仕事の案を作りました。内容を確かめて、よければ管理者に出してください。' }, { type: JOB_PROPOSAL_PART_TYPE, id: 'job-proposal-card-1', data: ref }] as UIMessage['parts']

function Preview() {
  const [tab, setTab] = useState<JobProposalTabTarget | null>(null)
  // As AppShell: ［大きく開く（タブ）］ opens the same candidate in a tab beside the chat.
  useCommandHandler('jobProposal.open', target => setTab(target))
  return (
    <main className="flex min-h-screen gap-6 bg-bg p-6 text-text">
      <section className="w-96 shrink-0" aria-label="相談"><AssistantMessageParts parts={parts} isStreaming={false} markdown /></section>
      <section id="tab" className="min-w-0 flex-1" aria-label="タブ">{tab && renderJobProposalTab(tab, COMPANY)}</section>
      <pre id="revised" className="hidden" />
      <pre id="submitted" className="hidden" />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
