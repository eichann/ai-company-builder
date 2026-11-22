/**
 * The chat's job proposal card (client/shared/job-proposals.ts, jobs.md "Member proposals" "The app (PR C)"):
 * - its press sends exactly the candidate and fingerprint the server answered (never the AI's text);
 * - after submitting it shows the state, with 「取り下げる」 only while it waits; gone (or withheld) is said plainly;
 * - what it says before the press (owner memo §8-6) — and never that it runs every week;
 * - it is stored as a reference only and comes back where it was when the conversation is reopened.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposalDefinition } from '../../shared/core/job-proposals'
import { parseJobDefinition, type JobDefinition } from '../../shared/core/jobs'
import {
  JOB_CANDIDATE_NOTES, JOB_PROPOSAL_PART_TYPE, jobCandidateLines, jobProposalCardState, jobProposalStateLine, readJobProposalCardRef,
} from '../shared/job-proposals'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'
import type { JobProposalView } from '../../shared/types/job-proposals'

const C = 'jc.' + 'a'.repeat(32)
const FP = 'sha256:' + 'f'.repeat(64)
const definition = (parseJobDefinition(proposalDefinition(
  { skill: 'minutes-summary', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 }, check: { kind: 'new_files', path: '営業/議事録' }, reads: ['営業/資料'], deliverable: '営業/週報', readRecords: false, mailDrafts: true, minutes: 15, missed: { policy: 'latest_only', expiresAfterMinutes: 120 } },
  { actingUser: 'me', procedure: { source: 'company_skill', skill: 'minutes-summary', fingerprint: 'c'.repeat(40) }, skillName: 'minutes-summary', candidateId: C },
)) as { definition: JobDefinition }).definition
const candidate = { id: C, definition, fingerprint: FP, expiresAt: '2026-11-23T00:00:00Z', timeZone: null }
const proposal = (state: string, returnReason: string | null = null): JobProposalView => ({
  id: 'jp.' + 'b'.repeat(32), jobId: 'job.' + '1'.repeat(32), proposerId: 'me', candidateId: C, submittedVersion: 1, submittedFingerprint: FP,
  state: state as JobProposalView['state'], returnReason: returnReason as JobProposalView['returnReason'], decidedBy: null, decidedAt: null, createdAt: 'x',
})

test('the press sends exactly the candidate and the fingerprint the server answered', () => {
  const s = jobProposalCardState({ success: true, candidate, proposal: null })
  assert.ok(s.kind === 'candidate')
  assert.deepEqual(s.submit, { candidateId: C, fingerprint: FP })
})

test('after submitting: its state, 取り下げる only while it waits; gone or a failure said plainly, nothing to press', () => {
  const states = ['submitted', 'approved', 'returned', 'withdrawn'].map(st => jobProposalCardState({ success: true, candidate, proposal: proposal(st) }))
  assert.deepEqual(states.map(s => s.kind === 'proposal' && s.withdraw), [true, false, false, false])
  // Its proposal still shows once the candidate is gone (24 hours), without its content.
  const later = jobProposalCardState({ success: true, candidate: null, proposal: proposal('approved') })
  assert.ok(later.kind === 'proposal' && later.candidate === null)
  assert.equal(jobProposalCardState({ success: true, candidate: null, proposal: null }).kind, 'gone')
  // Discarded by the member (「やめる」): said as such, nothing to press.
  assert.equal(jobProposalCardState({ success: true, candidate: null, proposal: null, discarded: true }).kind, 'discarded')
  assert.equal(jobProposalCardState({ success: false, offline: true, code: null, error: 'x' }).kind, 'error')
  assert.equal(jobProposalCardState(null).kind, 'loading')
  assert.match(jobProposalStateLine(proposal('returned', 'TOO_BROAD')), /差し戻されました（理由：読む場所や置く場所、できることが広すぎる）/)
  assert.match(jobProposalStateLine(proposal('approved')), /「受け取る」/)
  assert.match(jobProposalStateLine(proposal('submitted')), /確認待ち/)
})

test('before the press it says when (company time), what makes it run, the limits, places, missed runs and what may stop it', () => {
  const text = [...jobCandidateLines(definition), ...JOB_CANDIDATE_NOTES].join('\n')
  for (const words of ['会社の時刻', '毎週月曜 09:00', '「営業/議事録」に新しいファイルがあるときだけ', '読む場所', '「営業/週報」', '上限：1回 15分・1日 1回', '外に送るもの：下書きまで', '動けなかった回', '期限', '「AI に任せる」', '受け取る']) {
    assert.ok(text.includes(words), words)
  }
  assert.doesNotMatch(text, /必ず(毎週|動きます)|毎週かならず/)
})

test('the zone by name: 日本時間 for Asia/Tokyo, a zone without words by its id, and the company\'s clock from an older server', () => {
  assert.equal(jobCandidateLines(definition, 'Asia/Tokyo')[0], 'いつ確かめるか：毎週月曜 09:00（日本時間）')
  assert.equal(jobCandidateLines(definition, 'Asia/Jakarta')[0], 'いつ確かめるか：毎週月曜 09:00（時間帯 Asia/Jakarta）')
  assert.equal(jobCandidateLines(definition, null)[0], 'いつ確かめるか（会社の時刻で）：毎週月曜 09:00')
})

test('stored as a reference only, it comes back where it was when the conversation is reopened', () => {
  const ref = { id: 'card-1', companyId: 'co', conversationId: 'conv-1', candidateId: C, at: '2026-11-22T00:00:00Z' }
  const stored = uiMessageToSessionMessage({ id: 'a1', role: 'assistant', parts: [
    { type: 'text', text: '案を作りました。' },
    { type: JOB_PROPOSAL_PART_TYPE, id: 'job-proposal-card-1', data: { ...ref, definition: { injected: true } } },
    { type: 'data-approval', id: 'approval-x', data: { id: 'x', companyId: 'co', conversationId: null, approvalId: 'approval-0123456789', origin: 'shown', at: 'y' } },
  ] } as never, new Date('2026-11-22T00:00:00Z'))
  assert.deepEqual(stored.jobProposals, [ref])
  const back = sessionMessageToUIMessage(stored)
  const cards = back.parts.filter(p => p.type.startsWith('data-'))
  // In the order the tools produced them (the card first here, the approval after it).
  assert.deepEqual(cards.map(p => p.type), [JOB_PROPOSAL_PART_TYPE, 'data-approval'])
  assert.deepEqual((cards[0] as { data: unknown }).data, ref)
  // A stored reference naming anything but a candidate id is dropped.
  assert.equal(readJobProposalCardRef({ ...ref, candidateId: '../jobs' }), undefined)
  assert.equal(sessionMessageToUIMessage({ ...stored, jobProposals: [{ ...ref, candidateId: 'jp.' + 'b'.repeat(32) }] }).parts.some(p => p.type === JOB_PROPOSAL_PART_TYPE), false)
})
