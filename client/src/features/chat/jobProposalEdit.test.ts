/**
 * The card changed in place (jobs.md "Member proposals" "The card changed in place"): what the card offers and what a change
 * says. The server checks every value again; these guard what the member is shown and what is sent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposalDefinition, proposalInputOf, proposalReadPaths, type JobCandidateInput } from '../../../../shared/core/job-proposals'
import { parseJobDefinition, type JobDefinition } from '../../../../shared/core/jobs'
import { atChoices, changeText, foldersOf, inputKey, normalizedInput, placeChoices, sameInput, skillChoices, triggerWithEvery } from './jobProposalEdit'

const INPUT: JobCandidateInput = {
  skill: 'weekly-report', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
  check: { kind: 'new_files', path: '営業部/訪問メモ' }, reads: ['営業部/提案書'], deliverable: '営業部/週報',
  readRecords: false, mailDrafts: false, minutes: 15, missed: { policy: 'latest_only', expiresAfterMinutes: 120 },
}

test('a change names what changed, from the input shown to the one sent', () => {
  assert.equal(changeText(INPUT, { ...INPUT, trigger: { ...INPUT.trigger, weekday: 'tue' } as JobCandidateInput['trigger'] }), '曜日：月曜 → 火曜')
  assert.equal(changeText(INPUT, { ...INPUT, trigger: { ...INPUT.trigger, at: '10:30' } }), '時刻：09:00 → 10:30')
  assert.equal(changeText(INPUT, { ...INPUT, reads: [...INPUT.reads, '営業部/資料'] }), '読む場所：「営業部/資料」を足しました')
  assert.equal(changeText(INPUT, { ...INPUT, reads: [] }), '読む場所：「営業部/提案書」を外しました')
  assert.equal(changeText(INPUT, { ...INPUT, deliverable: null }), '置く場所：「営業部/週報」 → 置かない')
  assert.equal(changeText(INPUT, { ...INPUT, minutes: 30 }), '1回の時間：15分 → 30分')
})

test('the input the card sends back is the one the server built the definition from (proposalInputOf round trip)', () => {
  const parsed = parseJobDefinition(proposalDefinition(INPUT, { actingUser: 'u', procedure: { source: 'company_skill', skill: 'weekly-report', fingerprint: 'c'.repeat(40) }, skillName: 'weekly-report', candidateId: 'jc.' + 'a'.repeat(32) }))
  assert.ok(parsed.ok)
  const back = proposalInputOf((parsed as { definition: JobDefinition }).definition)
  assert.ok(back && sameInput(back, INPUT), 'unchanged input sends nothing (the card compares before sending)')
  // Key order does not matter: the server's answer and the card's own object compare equal.
  const { missed, ...rest } = INPUT
  const reordered: JobCandidateInput = { missed: { expiresAfterMinutes: missed.expiresAfterMinutes, policy: missed.policy }, ...rest }
  assert.equal(inputKey(reordered), inputKey(INPUT))
  assert.notEqual(inputKey({ ...INPUT, mailDrafts: true }), inputKey(INPUT))
})

test('what is sent is what will come back: a read place chosen as the check\'s place, or the check\'s place added as a read one', () => {
  const pinned = { actingUser: 'u', procedure: { source: 'company_skill' as const, skill: 'weekly-report', fingerprint: 'c'.repeat(40) }, skillName: 'weekly-report', candidateId: 'jc.' + 'a'.repeat(32) }
  const back = (i: JobCandidateInput) => proposalInputOf((parseJobDefinition(proposalDefinition(i, pinned)) as { definition: JobDefinition }).definition)!
  for (const chosen of [
    { ...INPUT, check: { kind: 'new_files' as const, path: '営業部/提案書' } },
    { ...INPUT, reads: [...INPUT.reads, '営業部/訪問メモ'] },
    { ...INPUT, reads: ['営業部/訪問メモ', '営業部/提案書'] },
    INPUT,
  ]) {
    const sent = normalizedInput(chosen)
    assert.ok(sameInput(back(sent), sent), JSON.stringify(chosen.reads))
    assert.ok(sameInput(back(chosen), sent), 'the server answers the normalized input')
  }
})

test('読む場所 on the card is exactly what the job may read: the grant\'s read paths, the check\'s place included', () => {
  const pinned = { actingUser: 'u', procedure: { source: 'company_skill' as const, skill: 'weekly-report', fingerprint: 'c'.repeat(40) }, skillName: 'weekly-report', candidateId: 'jc.' + 'a'.repeat(32) }
  for (const chosen of [
    INPUT,
    { ...INPUT, reads: [] },
    { ...INPUT, reads: ['営業部/訪問メモ', '営業部/提案書'] },
    { ...INPUT, check: { kind: 'new_meetings' as const }, reads: [] },
  ]) {
    const definition = (parseJobDefinition(proposalDefinition(chosen, pinned)) as { definition: JobDefinition }).definition
    // The card shows the input the server's definition reads back as (`proposalInputOf`).
    const shown = proposalReadPaths(proposalInputOf(definition)!)
    assert.deepEqual([...shown].sort(), [...definition.grant.reads.paths].sort(), JSON.stringify(chosen))
  }
})

test('another 「毎日／毎週／毎月」 keeps the time and gives a shape the parser takes', () => {
  for (const every of ['day', 'week', 'month']) {
    const t = triggerWithEvery(INPUT.trigger, every)
    assert.equal(t.every, every)
    assert.equal(t.at, '09:00')
    const def = proposalDefinition({ ...INPUT, trigger: t }, { actingUser: 'u', procedure: { source: 'company_skill', skill: 's', fingerprint: 'c'.repeat(40) }, skillName: 's', candidateId: 'jc.' + 'a'.repeat(32) })
    assert.ok(parseJobDefinition(def).ok, every)
  }
  assert.ok(atChoices('09:05').some(c => c.value === '09:05'), 'a time off the list stays choosable')
})

test('places offered: no hidden or reserved folder, each once; the candidate\'s own kept', () => {
  const tree = [
    { name: '営業部', isDirectory: true, path: '/r/営業部', children: [
      { name: '週報', isDirectory: true, path: '/r/営業部/週報' },
      { name: '.personal', isDirectory: true, path: '/r/営業部/.personal', children: [{ name: 'x', isDirectory: true, path: '' }] },
      { name: 'memo.md', isDirectory: false, path: '/r/営業部/memo.md' },
    ] },
    { name: '.claude', isDirectory: true, path: '/r/.claude', children: [{ name: 'skills', isDirectory: true, path: '' }] },
    { name: '.git', isDirectory: true, path: '/r/.git' },
  ]
  const folders = foldersOf(tree)
  assert.deepEqual(folders, ['営業部', '営業部/週報'])
  assert.deepEqual(placeChoices([...folders, '営業部', '.acb/x', '総務部/.backups'], ['営業部/提案書']), ['営業部', '営業部/週報', '営業部/提案書'])
})

test('Skills offered: folder names of the Skill rule only, the current one kept', () => {
  assert.deepEqual(skillChoices([{ name: 'weekly-report', isDirectory: true }, { name: 'Bad Name', isDirectory: true }, { name: 'notes.md', isDirectory: false }, { name: 'minutes', isDirectory: true }], 'shelf-item'), ['minutes', 'shelf-item', 'weekly-report'])
})
