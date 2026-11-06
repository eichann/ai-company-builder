// What a business plugin's step made for a record (plugin-steps.md "What the step made",
// tasks-ui.md 「AI が用意したもの」): the step hands it over as one やること linked to the record
// (`bundle`) — its `prep_summary` holds the points to check (確かめる点), its `prepared` links the
// mail draft (with the PDF attached), its file links the files (in the member's `.personal/`,
// which the server shows to their maker alone). The record's card shows the newest open one at
// the top. Pure: main reads the server's answers with the session and shapes them here.
import type { RecordDetail, RecordSummary } from '../../shared/types/records'
import { linkedPathOf, summaryView, type LinkedPath, type RecordViewSummary } from './record-views'

export interface StepDeliverablesView {
  /** The やること that carries them (opens in its own card). */
  taskId: string
  title: string
  /** 確かめる点: what the AI could not settle and asks the member to check. */
  questions: string | null
  /** The mail drafts / approval requests it made, newest first. */
  prepared: RecordViewSummary[]
  files: LinkedPath[]
}

/** States of a やること in which it is no longer waiting for anyone. */
const CLOSED = new Set(['done', 'cancelled', 'dismissed'])

const text = (v: unknown): string | null => typeof v === 'string' && v.trim() !== '' ? v : null

/**
 * The newest open やること linked to the record that carries an AI's preparation (`prep_summary`):
 * the server lists the most recently changed first.
 */
export function deliverableTaskOf(records: readonly RecordSummary[]): string | null {
  const found = records.find(r => r.type === 'task' && !CLOSED.has(r.state ?? '') && text(r.fields?.prep_summary) !== null)
  return found?.id ?? null
}

export function stepDeliverablesOf(detail: RecordDetail): StepDeliverablesView {
  const r = detail.record
  const prepared: RecordViewSummary[] = []
  const files: LinkedPath[] = []
  for (const l of detail.links) {
    if (l.direction !== 'out') continue
    if (l.path !== undefined) { files.push(linkedPathOf({ ...l, path: l.path }, null)); continue }
    if (l.name === 'prepared' && l.record) prepared.push(summaryView(l.record, undefined))
  }
  prepared.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { taskId: r.id, title: r.title || '（名前なし）', questions: text(r.fields?.prep_summary), prepared, files }
}
