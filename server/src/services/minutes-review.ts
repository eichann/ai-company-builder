/**
 * 「議事録を確認する」 (minutes.md "The review task", owner decision 2026-11-02, plan F): when a
 * meeting is read — internal or external — its assignee gets one task to check the reading (the
 * summary, the decisions, the AI's proposals 案 to add or put away). One per meeting: its id is
 * derived from the meeting (`meetingOutputId`, key `MINUTES_REVIEW_KEY`) and an existing one is
 * never made again (a second reading, 「もう一度読む」). It links the meeting as its origin
 * (出どころ), lives in the meeting's folder (the same readers), and is the assignee's own
 * (requested_by = assignee): they complete it themselves — nothing completes it when the last
 * proposal was added or put away. The ledger's actor is the minutes intake (`MINUTES_ACTOR`,
 * cause system), never a person.
 */
import { MINUTES_ACTOR, MINUTES_REVIEW_KEY, MINUTES_REVIEW_KIND } from '../../shared/core/core-types'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import { logError } from '../lib/error-log'
import type { RecordChange, ServiceRecordWriter } from './record-engine'
import { meetingOutputId } from './meeting-outputs'

export interface MinutesReviewDeps {
  companyData: CompanyDataSource
  writer: Pick<ServiceRecordWriter, 'create'>
  tokenDigest: TokenDigest
}

/** The state of a meeting that has been read (core `meeting`). */
const READ = 'read'
const TITLE_MAX = 200

export function createMinutesReview(deps: MinutesReviewDeps) {
  /** Make the meeting's review task unless it exists. Returns its id, or null when none was made. */
  function ensure(companyId: string, meetingId: string): string | null {
    const records = deps.companyData.forCompany(companyId).records
    const meeting = records.byIds([meetingId]).find(r => r.type === 'meeting' && r.removedAt === null)
    if (!meeting) return null
    const id = meetingOutputId(deps.tokenDigest, 'task', meetingId, MINUTES_REVIEW_KEY)
    if (records.find(id)) return null
    let fields: Record<string, unknown> = {}
    try { fields = JSON.parse(records.states([meetingId])[0]?.fields ?? '{}') as Record<string, unknown> } catch { /* no assignee */ }
    const assignee = typeof fields.assignee === 'string' && fields.assignee !== '' ? fields.assignee : null
    if (!assignee) return null
    const r = deps.writer.create(companyId, {
      type: 'task', id, title: `議事録を確認する：${meeting.title}`.slice(0, TITLE_MAX), folder: meeting.folder,
      fields: { assignee, requested_by: assignee, task_kind: MINUTES_REVIEW_KIND },
      links: { meeting: [meetingId] }, actor: MINUTES_ACTOR,
    })
    if (!r.ok) {
      // `exists`: made meanwhile (two readings at once) — the one there is the answer.
      if (r.reason !== 'exists') logError('minutes', 'review task not made', undefined, { companyId, reason: r.reason })
      return null
    }
    return id
  }

  return {
    ensure,
    /** The engine's after-act: a meeting that has just become read gets its review task. Never throws. */
    afterAct(companyId: string, change: RecordChange): void {
      try {
        if (change.type !== 'meeting' || change.entry.toState !== READ || change.entry.fromState === READ) return
        ensure(companyId, change.entry.recordId)
      } catch (e) {
        logError('minutes', 'review task failed', e, { companyId })
      }
    },
  }
}

export type MinutesReview = ReturnType<typeof createMinutesReview>
