/**
 * 出どころ (shared/core/source-slots.ts): the one order every per-source rule uses — a follow-up
 * round first (a nudge never meets the mail it follows up), then the meeting, the 連絡's thread,
 * the まとまり — and the stored key that the send rows and approvals compare.
 */
import { describe, expect, it } from 'vitest'
import { parseSourceKey, resolveSource, sourceKey, sourceRecordId } from '../../../shared/core/source-slots'
import { alreadySentText, resendReasonOf } from '../../../shared/core/mail'

describe('the source of a piece of work', () => {
  it('follow-up, then meeting, then thread, then まとまり; nothing → no source', () => {
    const all = { followUp: 'task-1@4', meeting: 'meeting-1', interaction: 'interaction-1', bundle: 'deal-1' }
    expect(resolveSource(all)).toEqual({ kind: 'follow-up', id: 'task-1@4' })
    expect(resolveSource({ ...all, followUp: null })).toEqual({ kind: 'meeting', id: 'meeting-1' })
    expect(resolveSource({ ...all, followUp: null, meeting: null })).toEqual({ kind: 'thread', id: 'interaction-1' })
    expect(resolveSource({ bundle: 'deal-1' })).toEqual({ kind: 'bundle', id: 'deal-1' })
    expect(resolveSource({})).toBeNull()
  })

  it('the key round-trips; a follow-up names its record without the round; anything else is no source', () => {
    for (const s of [{ kind: 'meeting', id: 'meeting-1' }, { kind: 'follow-up', id: 'task-1@4' }] as const) expect(parseSourceKey(sourceKey(s))).toEqual(s)
    expect(sourceRecordId({ kind: 'follow-up', id: 'reply_request-9@12' })).toBe('reply_request-9')
    for (const bad of ['', 'meeting:', ':x', 'deal:deal-1', null]) expect(parseSourceKey(bad)).toBeNull()
  })

  it('the sentence names who and when in Japan time; a reason is one line of 1–200 characters', () => {
    expect(alreadySentText('meeting', '佐藤', '2026-11-06T06:30:00.000Z')).toBe('この会議のお礼メールは佐藤さんが 11/06 15:30 に送りました')
    expect(alreadySentText('thread', null, '2026-11-06T06:30:00.000Z')).toBe('この連絡への返事はあなたが 11/06 15:30 に送りました')
    expect(resendReasonOf('  別の担当者にも  ')).toBe('別の担当者にも')
    for (const bad of ['', ' ', 'a\nb', 'x'.repeat(201), 3]) expect(resendReasonOf(bad)).toBeNull()
  })
})
