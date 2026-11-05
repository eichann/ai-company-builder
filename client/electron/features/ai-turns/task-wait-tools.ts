// A task's wait that is over (`.claude/rules/ai-turns.md` "A task's wait that is over"): the one
// read the PC's `task-wait-over` step needs — the task, what it waits for and what it is linked to
// (the 連絡 whose thread may hold the awaited reply, the drafts already made). Only a task the server
// clock put in 準備中 (`enteredByWaitOver`, from its ledger) is answered in full; any other record
// gets its state alone (least privilege: no general records_get in that run). Read only; made per
// turn by `records/tool-providers.ts`, and an unattended run gets it only when its step names it.
import { z } from 'zod'
import { enteredByWaitOver } from '../../../../shared/core/core-types'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import { OUTSIDE_VALUE_NOTE, outsideValue } from '../../../../shared/core/outside-text'
import type { RecordDetail, RecordSummary } from '../../../../shared/types/records'
import { RecordsApiError, type RecordTurnAccess } from '../../records/api'
import type { ExtraRecordTools, RecordToolDescriptor } from '../../records/tools'

const TASK_ID = /^task-[0-9a-z]{6,32}$/
const json = (v: unknown) => JSON.stringify(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
/** Text that may have come from outside (a subject, what the task waits on): `{ outside }`, the one standard (outside-text.ts). */
const text = (v: unknown) => { const s = str(v); return s === null ? null : outsideValue(s) }

/** The task as the wait-over step reads it; `purpose: 'follow_up'` only when the clock put it in 準備中. */
export function taskWaitView(detail: RecordDetail, ledger: readonly LedgerEntry[]) {
  const r = detail.record
  const base = { id: r.id, state: r.state, version: r.version }
  if (r.type !== 'task' || r.state !== 'preparing' || !enteredByWaitOver(ledger)) return { ...base, purpose: 'none' as const }
  const linked = (name: string) => detail.links
    .filter(l => l.direction === 'out' && l.name === name && l.record)
    .map(l => { const x = l.record as RecordSummary; return { id: x.id, type: x.type, title: outsideValue(x.title), state: x.state } })
  return {
    ...base, purpose: 'follow_up' as const, outsideNote: OUTSIDE_VALUE_NOTE, title: outsideValue(r.title),
    waitingOn: text(r.fields.waiting_on), waitUntil: str(r.fields.wait_until), due: str(r.fields.due), taskPurpose: text(r.fields.purpose),
    interaction: linked('interaction')[0] ?? null, counterpart: linked('counterpart')[0] ?? null, bundle: linked('bundle')[0] ?? null,
    prepared: linked('prepared'),
  }
}

export async function createTaskWaitTools(access: RecordTurnAccess, signal?: AbortSignal): Promise<ExtraRecordTools | null> {
  const spec: RecordToolDescriptor = {
    name: 'task_wait_read', readOnly: true,
    display: { label: '待っているタスクを確かめました', running: '待っているタスクを確かめています', many: '待っているタスクを {n} 件確かめました' },
    schema: z.object({ recordId: z.string().regex(TASK_ID).describe('見込みの日時が過ぎたタスク（task）の id') }).strict(),
    description: '返事・届く見込みの日時が過ぎて AI の番（準備中）になったタスクを読む：待っているもの（waitingOn）・見込み（waitUntil）・期限・もとの連絡（interaction）・相手・AI が用意したもの。purpose が follow_up のときだけ中身がある（ほかは none）。\n' +
      'Read a task whose expected reply / delivery time passed (the clock put it in preparing): what it waits on, the linked message, counterpart and prepared drafts. Details only when purpose is follow_up.',
  }
  return {
    specs: [spec],
    instructions: '見込みの日時が過ぎたタスクは task_wait_read で読む。',
    async execute(name, input) {
      if (name !== spec.name) return json({ error: 'この道具はありません。' })
      const parsed = spec.schema.safeParse(input ?? {})
      if (!parsed.success) return json({ error: '入力が正しくありません。' })
      const id = encodeURIComponent(String(parsed.data.recordId))
      try {
        const detail = await access.call('GET', `/item/${id}`, undefined, signal) as RecordDetail
        const history = await access.call('GET', `/item/${id}/history`, undefined, signal) as { entries: LedgerEntry[] }
        return json(taskWaitView(detail, history.entries))
      } catch (error) {
        return error instanceof RecordsApiError
          ? json({ error: error.message, code: error.code })
          : json({ error: '読めませんでした。' })
      }
    },
  }
}
