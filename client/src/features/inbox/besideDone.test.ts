// The card beside the inbox's list across a company change (notifications.md "Working through the inbox", Codex review of
// UX stage 2): a press on company A's card answered after company B is on screen never says A's 件名 on B's list, nor
// moves it — whatever kind the card is. Each test names what it guards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endCompanyEra } from '../../shared/lib/companyEra'
import { endedWords, forgetAllWork, noticeOf, publishOrder, setWorkNotice } from '../../shared/lib/workThrough'
import { finishBeside, INBOX_WORK_KEY, openBeside, type Beside, type BesideDoneDeps } from './besideDone'
import type { BesideCard } from './workModel'

/** What appStore's `leaveCompanyOnScreen` does on another company or a sign-out. */
const leaveCompany = () => { endCompanyEra(); forgetAllWork() }

/** The slot's list moves, recorded: `ended` acts as the real one does for the row shown (says the line, answers `last`). */
function listOf(shown: string | null, beside: () => Beside | null) {
  const calls: string[] = []
  const deps: BesideDoneDeps = {
    ended: (rowKey, title) => {
      calls.push(`ended ${rowKey}`)
      if (rowKey !== shown) return null
      setWorkNotice(INBOX_WORK_KEY, { text: endedWords(title, true), undo: null })
      return 'last'
    },
    show: id => { calls.push(`show ${id}`) },
    current: beside,
    close: () => { calls.push('close') },
    readPlansAgain: () => { calls.push('plans') },
  }
  return { deps, calls }
}

const KINDS: BesideCard[] = [
  { kind: 'approval', id: 'approval-a1' },
  { kind: 'mail', id: 'msg-a1' },
  { kind: 'browser', id: 'plan-a1' },
  { kind: 'contact', id: 'interaction-a1' },
]

test('a card of company A finished after the switch to B (its answer late) says nothing on B\'s list and moves nothing — every kind', () => {
  for (const card of KINDS) {
    forgetAllWork()
    publishOrder(INBOX_WORK_KEY, ['record:a1', 'record:a2'])
    const opened = openBeside(card, { rowKey: 'record:a1', title: 'A社の秘密の件名', readKey: 'open1', at: 0 })
    // The member pressed the card in A; before its answer came, B was opened and its list drawn.
    leaveCompany()
    publishOrder(INBOX_WORK_KEY, ['record:b1', 'record:b2'])
    // The old screen's callback (its card was still beside: A's slot kept it) is called with A's answer.
    const { deps, calls } = listOf('record:a1', () => opened)
    finishBeside(opened, undefined, deps)
    assert.deepEqual(calls, [], card.kind)
    assert.equal(noticeOf(INBOX_WORK_KEY), null, card.kind)
  }
})

test('in the era the card was opened in, its press still moves to the next row (the gate is not a wall)', () => {
  forgetAllWork()
  publishOrder(INBOX_WORK_KEY, ['record:b1', 'record:b2'])
  const opened = openBeside({ kind: 'approval', id: 'approval-b1' }, { rowKey: 'record:b1', title: 'B社の件', readKey: 'open2', at: 0 })
  const { deps, calls } = listOf('record:b1', () => opened)
  finishBeside(opened, undefined, deps)
  assert.deepEqual(calls, ['plans', 'ended record:b1', 'close'])
})

test('the row already gone from a list read again (same era): the row now in its place comes next, with the line', () => {
  forgetAllWork()
  publishOrder(INBOX_WORK_KEY, ['record:b2', 'record:b3'])
  const opened = openBeside({ kind: 'mail', id: 'msg-b1' }, { rowKey: 'record:b1', title: 'B社の件', readKey: 'open3', at: 0 })
  const { deps, calls } = listOf('record:b1-not-shown', () => opened)
  finishBeside(opened, undefined, deps)
  assert.deepEqual(calls, ['plans', 'ended record:b1', 'show record:b2'])
  assert.match(noticeOf(INBOX_WORK_KEY)?.text ?? '', /「B社の件」を片づけました/)
})
