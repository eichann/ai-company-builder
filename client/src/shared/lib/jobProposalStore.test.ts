// The job proposal card's copy of a candidate is never a cache across showings (review of PR C, Codex P2): a failed read
// does not stick, a reopened card reads the server again (approved / returned / withheld since), 読み直す asks again, and a
// 「取り下げる」 in 「出した案」 updates a card on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JobCandidateResult } from '../../../shared/job-proposals'
import { jobCandidateChanged, jobProposalEntry, jobProposalKey, putJobProposal, reloadJobCandidate, subscribeJobProposal } from './jobProposalStore'

const OFFLINE: JobCandidateResult = { success: false, offline: true, code: null, error: 'オフライン' }
const proposal = (state: string) => ({ success: true, candidate: null, proposal: { state } }) as unknown as JobCandidateResult
const tick = () => new Promise(r => setTimeout(r, 0))
let n = 0
function harness(answers: JobCandidateResult[]) {
  const key = jobProposalKey('co', `jc.${String(++n).padStart(32, '0')}`)
  let asked = 0
  const loader = async () => answers[Math.min(asked++, answers.length - 1)]
  return { key, loader, asked: () => asked }
}

test('a failed first read does not stick: shown while on screen, read again when shown next', async () => {
  const h = harness([OFFLINE, proposal('submitted')])
  const off = subscribeJobProposal(h.key, h.loader, () => {})
  await tick()
  assert.equal(jobProposalEntry(h.key), OFFLINE)
  off()
  const off2 = subscribeJobProposal(h.key, h.loader, () => {})
  await tick()
  assert.equal(h.asked(), 2)
  assert.deepEqual(jobProposalEntry(h.key), proposal('submitted'))
  off2()
})

test('a reopened card reads the server again (approved since); a read answered after the card went is not kept', async () => {
  const h = harness([proposal('submitted'), proposal('approved')])
  const off = subscribeJobProposal(h.key, h.loader, () => {})
  await tick()
  off()
  assert.equal(jobProposalEntry(h.key), null)
  const off2 = subscribeJobProposal(h.key, h.loader, () => {})
  await tick()
  assert.deepEqual(jobProposalEntry(h.key), proposal('approved'))
  off2()
  putJobProposal(h.key, proposal('returned'))
  assert.equal(jobProposalEntry(h.key), null)
})

test('読み直す after a failure shows the answer; a moment offline keeps what was read', async () => {
  const h = harness([OFFLINE, proposal('submitted'), OFFLINE])
  const off = subscribeJobProposal(h.key, h.loader, () => {})
  await tick()
  reloadJobCandidate(h.key)
  await tick()
  assert.deepEqual(jobProposalEntry(h.key), proposal('submitted'))
  reloadJobCandidate(h.key)
  await tick()
  assert.deepEqual(jobProposalEntry(h.key), proposal('submitted'))
  off()
})

test('「取り下げる」 elsewhere: a card on screen reads it again (once more when a read was on its way); none on screen, nothing asked', async () => {
  const h = harness([proposal('submitted'), proposal('withdrawn')])
  const [company, candidate] = h.key.split('|')
  jobCandidateChanged(company, candidate)
  assert.equal(h.asked(), 0)
  const off = subscribeJobProposal(h.key, h.loader, () => {})
  jobCandidateChanged(company, candidate)
  await tick(); await tick()
  assert.equal(h.asked(), 2)
  assert.deepEqual(jobProposalEntry(h.key), proposal('withdrawn'))
  off()
})
