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

test('a reopened card reads the server again (approved since); an answer after the card went is not kept', async () => {
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

test('a read on its way never puts back what the member\'s act replaced (withdraw / submit / discard), and the server is read once more', async () => {
  const cases: Array<[JobCandidateResult, JobCandidateResult]> = [
    [proposal('submitted'), proposal('withdrawn')],
    [{ success: true, candidate: { id: 'x' }, proposal: null } as unknown as JobCandidateResult, proposal('submitted')],
    [proposal('submitted'), { success: true, candidate: null, proposal: null, discarded: true }],
  ]
  for (const [before, after] of cases) {
    const key = jobProposalKey('co', `jc.race${++n}`)
    const releases: Array<(r: JobCandidateResult) => void> = []
    // Every read waits until the test answers it: the first answers the state before the act.
    const off = subscribeJobProposal(key, () => new Promise<JobCandidateResult>(r => { releases.push(r) }), () => {})
    putJobProposal(key, after)
    releases[0](before)
    await tick(); await tick()
    assert.deepEqual(jobProposalEntry(key), after, 'the older read is dropped')
    assert.equal(releases.length, 2, 'read once more after the act')
    releases[1](after)
    await tick()
    assert.deepEqual(jobProposalEntry(key), after)
    off()
  }
  // A read asked while one is on its way follows it (never two at once), and its answer is the one shown.
  const key = jobProposalKey('co', `jc.race${++n}`)
  const releases: Array<(r: JobCandidateResult) => void> = []
  const off = subscribeJobProposal(key, () => new Promise<JobCandidateResult>(r => { releases.push(r) }), () => {})
  reloadJobCandidate(key)
  releases[0](proposal('submitted'))
  await tick(); await tick()
  releases[1](proposal('approved'))
  await tick()
  assert.deepEqual(jobProposalEntry(key), proposal('approved'))
  off()
})
