/**
 * 「連絡」1枚 (inbox.md "One contact", owner decision 2026-11-28, UX stage 2 「5番」): a 来た連絡 (`interaction`)
 * and its 返事のお願い (`reply_request`) stay two records with their own actions, `who` and ledgers; the app shows
 * them as one card. This service adds only what that card needs:
 *
 *   - `view`: the contact with its 返事のお願い (担当・期限・追いかけの日・下書き) and the やること made from it —
 *     only records the member reads, each through the record reader, so nothing widens who sees what;
 *   - `finish`: the 返事のお願い's end (もう返した / 終わりにする / 返事をしない) and the contact's 「済んだ」 (when it is
 *     確認待ち) **through the engine's own actions**, written together or not at all (`recordEngine.actTogether`);
 *   - `undo`: what one finish wrote, taken back together or not at all (`recordEngine.undoTogether`).
 *
 * No new rule of who may do what: every part is the engine's action or undo with its `from`, `who`, version check and
 * ledger entry; a part the member may not do refuses the whole request.
 */
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { RecordRow } from '../ports/records'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type {
  ContactFinishResult, ContactPartResult, ContactReplyEnd, ContactReplyView, ContactUndoResult, ContactView,
} from '../../shared/types/inbox'
import type { Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'
import { recordReader, type RecordReader } from './record-access'
import type { ActorInput, RecordEngine } from './record-engine'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from './records'

export interface ContactThreadDeps {
  companyData: CompanyDataSource
  engine: Pick<RecordEngine, 'actTogether' | 'undoTogether' | 'whoMay'>
}

/** The 返事のお願い's actions a finish may end it with. */
export const CONTACT_REPLY_ENDS: readonly ContactReplyEnd[] = ['replied_elsewhere', 'close', 'drop']
/** The contact's own part of a finish: 「済んだ」, only from 確認待ち (interaction v6). */
const SETTLE = 'settle'
const SETTLE_FROM = 'unsure'
const REPLY_FINAL = ['closed', 'dropped']
/** At most this many linked records of one type are read for one contact; beyond it the view says `truncated`. */
export const CONTACT_READ_LIMIT = 200

export const NOT_THIS_CONTACT = { error: 'この返事のお願いは、この連絡のものではありません。画面を読み直してください', code: 'NOT_THIS_CONTACT' } as const
export const NOT_A_FINISH = { error: 'この変更は連絡の［返した］・［済んだ］ではないため、ここからは取り消せません', code: 'NOT_A_FINISH' } as const
const VERSION_CONFLICT = { error: 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', code: 'VERSION_CONFLICT' } as const

type Part = 'interaction' | 'replyRequest'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const str = (v: LedgerValue | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null)
const badBody = () => refuse('bad-request', 'リクエストの形が正しくありません', { code: 'BAD_REQUEST' })

/** A refusal about one part (the engine's `step` → the part's name). */
function aboutPart(r: Refusal, parts: readonly Part[]): Refusal {
  const { step, ...body } = r.body
  return typeof step === 'number' && parts[step] ? { ...r, body: { ...body, part: parts[step] } } : r
}

export function createContactThreads(deps: ContactThreadDeps) {
  const notFound = () => refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })

  function open(member: Member): { handle: CompanyData; reader: RecordReader } | null {
    const handle = deps.companyData.forCompany(member.companyId)
    if (!handle.records.settings().enabled) return null
    return { handle, reader: recordReader(member, handle.scopes.listWithRules()) }
  }

  /** A live record of `type` the member reads, else null (missing, unreadable, another type, another company: one answer). */
  function readable(handle: CompanyData, reader: RecordReader, id: unknown, type: string): RecordRow | null {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null
    const row = handle.records.byIds([id])[0]
    return row && row.removedAt === null && row.type === type && reader.record(row) ? row : null
  }

  function stateOf(handle: CompanyData, id: string): { state: string | null; version: number; fields: Record<string, LedgerValue> } {
    const s = handle.records.states([id])[0]
    let fields: Record<string, LedgerValue> = {}
    try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
    return { state: s?.state ?? null, version: s?.version ?? 0, fields }
  }

  const interactionOf = (handle: CompanyData, replyRequestId: string): string | null =>
    handle.records.linksFrom([replyRequestId]).find(l => l.name === 'interaction' && l.targetId)?.targetId ?? null

  /**
   * The records of `type` linking the contact by `link`, live and read by the member. `cut` is set when more were linked
   * than `CONTACT_READ_LIMIT` (counted before the reader: the flag tells nothing of who reads them), so the view never
   * looks complete when it is not (review of this PR).
   */
  function linkedTo(handle: CompanyData, reader: RecordReader, interactionId: string, type: string, link: string, cut: { truncated: boolean }): RecordRow[] {
    const found = handle.records.candidates({ types: [type], link: { name: link, id: interactionId } }, CONTACT_READ_LIMIT + 1)
    if (found.length > CONTACT_READ_LIMIT) cut.truncated = true
    return handle.records.byIds(found.slice(0, CONTACT_READ_LIMIT).map(r => r.id)).filter(r => r.removedAt === null && reader.record(r))
  }

  function partResult(handle: CompanyData, recordId: string, outcome: ContactPartResult['outcome'], version: number | null): ContactPartResult {
    const now = stateOf(handle, recordId)
    return { recordId, outcome, state: now.state, recordVersion: now.version, version }
  }

  /**
   * The version the card read is not the record's now: was it this very change by this member, written by an earlier
   * press (the request seen twice)? Then that entry — the "done" record — else null (someone else changed it: stale).
   */
  function alreadyWritten(handle: CompanyData, recordId: string, expectedVersion: number, action: string, member: Member): number | null {
    const ledger = handle.records.ledger(recordId)
    const next = ledger.find(e => e.version === expectedVersion + 1)
    if (!next || next.action !== action || next.actorId !== member.userId || next.actorKind !== 'human') return null
    // …and still in force: nothing after it moved the state (a reopen, an undo, the thread going on — review of this PR:
    // a retry would else answer `already` for a change taken back). Notes after it (the mailbox's 「Gmail でもアーカイブ
    // しました」, a draft's discard) change no state and keep it.
    return ledger.some(e => e.version > next.version && e.fromState !== e.toState) ? null : next.version
  }

  return {
    /** The card's whole contact: the interaction (or a 返事のお願い of it), its 返事のお願い and its やること, as the member reads them. */
    view(member: Member, recordId: string): Outcome<ContactView> {
      const o = open(member)
      if (!o) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { handle, reader } = o
      const asked = readable(handle, reader, recordId, 'interaction')
        ?? (() => {
          const rr = readable(handle, reader, recordId, 'reply_request')
          return rr ? readable(handle, reader, interactionOf(handle, rr.id), 'interaction') : null
        })()
      if (!asked) return notFound()
      const cur = stateOf(handle, asked.id)
      const cut = { truncated: false }
      const maySettle = deps.engine.whoMay(member, asked.id, [SETTLE])?.may[SETTLE] === true
      // The card's own reply drafts to this contact, and each request's prepared ones: still 下書き, read by the member.
      const draftsOf = (ids: string[]) => handle.records.byIds([...new Set(ids)])
        .filter(r => r.type === 'outbound_message' && r.removedAt === null && reader.record(r))
        .map(r => ({ id: r.id, ...stateOf(handle, r.id) }))
        .filter(d => d.state === 'draft')
        .map(d => ({ id: d.id, version: d.version }))
      const threadDrafts = linkedTo(handle, reader, asked.id, 'outbound_message', 'interaction', cut).map(r => r.id)
      const replyRequests: ContactReplyView[] = linkedTo(handle, reader, asked.id, 'reply_request', 'interaction', cut).map(r => {
        const s = stateOf(handle, r.id)
        const prepared = handle.records.linksFrom([r.id]).filter(l => l.name === 'prepared' && l.targetId).map(l => l.targetId as string)
        const may = deps.engine.whoMay(member, r.id, CONTACT_REPLY_ENDS)?.may
        return {
          id: r.id, title: r.title, state: s.state, version: s.version, assignee: str(s.fields.assignee),
          due: str(s.fields.due), guidelineDue: str(s.fields.guideline_due), waitUntil: str(s.fields.wait_until),
          drafts: draftsOf([...prepared, ...threadDrafts]),
          may: { replied_elsewhere: may?.replied_elsewhere === true, close: may?.close === true, drop: may?.drop === true },
        }
      })
      replyRequests.sort((a, b) => Number(REPLY_FINAL.includes(a.state ?? '')) - Number(REPLY_FINAL.includes(b.state ?? '')))
      const tasks = linkedTo(handle, reader, asked.id, 'task', 'interaction', cut).map(t => {
        const s = stateOf(handle, t.id)
        return { id: t.id, title: t.title, state: s.state, version: s.version, assignee: str(s.fields.assignee) }
      })
      return ok({
        interaction: { id: asked.id, title: asked.title, state: cur.state, version: cur.version, assignee: str(cur.fields.assignee), maySettle },
        replyRequests, tasks,
        ...(cut.truncated ? { truncated: true as const } : {}),
      })
    },

    /**
     * ［返した］ / ［済んだ（もう待たない）］ / ［済んだ］: the 返事のお願い's end and, when the contact is 確認待ち, its
     * 「済んだ」 — both written or neither. A part whose version moved because of this member's same change (a second
     * press) is `already`; moved otherwise → 409 VERSION_CONFLICT with `part`, nothing written.
     */
    async finish(member: Member, actor: ActorInput, interactionId: string, body: unknown): Promise<Outcome<ContactFinishResult>> {
      const o = open(member)
      if (!o) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { handle, reader } = o
      const contact = readable(handle, reader, interactionId, 'interaction')
      if (!contact) return notFound()
      if (!isObject(body) || !isObject(body.interaction) || !isObject(body.replyRequest)) return badBody()
      const ib = body.interaction
      const rb = body.replyRequest
      if (!isVersion(ib.expectedVersion) || !isVersion(rb.expectedVersion) || typeof rb.id !== 'string') return badBody()
      if (!CONTACT_REPLY_ENDS.includes(rb.action as ContactReplyEnd)) return badBody()
      if (rb.note !== undefined && typeof rb.note !== 'string') return badBody()
      const action = rb.action as ContactReplyEnd
      const request = readable(handle, reader, rb.id, 'reply_request')
      if (!request) return notFound()
      if (interactionOf(handle, request.id) !== contact.id) return refuse('conflict', NOT_THIS_CONTACT.error, { code: NOT_THIS_CONTACT.code })

      // The 返事のお願い first: its close is committed before the contact's 「済んだ」 runs its follow-ups (the mailbox
      // archive asks whether work is still open: inbox.md "Mail archived in the mailbox").
      const steps: Array<{ part: Part; recordId: string; action: string; body: unknown }> = []
      const results: Partial<Record<Part, ContactPartResult>> = {}
      const rr = stateOf(handle, request.id)
      if (rr.version === rb.expectedVersion) {
        steps.push({ part: 'replyRequest', recordId: request.id, action, body: { expectedVersion: rb.expectedVersion, ...(rb.note !== undefined ? { note: rb.note } : {}) } })
      } else {
        const done = alreadyWritten(handle, request.id, rb.expectedVersion, action, member)
        if (done === null) return refuse('conflict', VERSION_CONFLICT.error, { code: VERSION_CONFLICT.code, version: rr.version, part: 'replyRequest' })
        results.replyRequest = partResult(handle, request.id, 'already', done)
      }
      const it = stateOf(handle, contact.id)
      if (it.version === ib.expectedVersion) {
        // Only 確認待ち is the member's to close (`settle`); a contact the AI judged (対応済み) or in the AI's turn stays.
        if (it.state === SETTLE_FROM) steps.push({ part: 'interaction', recordId: contact.id, action: SETTLE, body: { expectedVersion: ib.expectedVersion } })
        else results.interaction = partResult(handle, contact.id, 'unchanged', null)
      } else {
        const done = alreadyWritten(handle, contact.id, ib.expectedVersion, SETTLE, member)
        if (done === null) return refuse('conflict', VERSION_CONFLICT.error, { code: VERSION_CONFLICT.code, version: it.version, part: 'interaction' })
        results.interaction = partResult(handle, contact.id, 'already', done)
      }

      if (steps.length > 0) {
        const r = await deps.engine.actTogether(member, actor, steps.map(s => ({ recordId: s.recordId, action: s.action, body: s.body })))
        if (!r.ok) return aboutPart(r, steps.map(s => s.part))
        steps.forEach((s, i) => { results[s.part] = partResult(handle, s.recordId, 'done', r.value[i].entry?.version ?? null) })
      }
      return ok({ interaction: results.interaction as ContactPartResult, replyRequest: results.replyRequest as ContactPartResult })
    },

    /**
     * ［取り消す］ of a finish: each part's entry taken back by the engine's own undo (its actor, an owner / admin — the
     * generic rule), both or neither. A part already taken back (an undo entry reverses it) is `already`.
     */
    undo(member: Member, actor: ActorInput, interactionId: string, body: unknown): Outcome<ContactUndoResult> {
      const o = open(member)
      if (!o) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { handle, reader } = o
      const contact = readable(handle, reader, interactionId, 'interaction')
      if (!contact) return notFound()
      if (!isObject(body) || !isObject(body.replyRequest) || (body.interaction !== undefined && !isObject(body.interaction))) return badBody()
      const rb = body.replyRequest
      const ib = body.interaction as Record<string, unknown> | undefined
      if (typeof rb.id !== 'string' || !isVersion(rb.version) || !isVersion(rb.expectedVersion)) return badBody()
      if (ib && (!isVersion(ib.version) || !isVersion(ib.expectedVersion))) return badBody()
      const request = readable(handle, reader, rb.id, 'reply_request')
      if (!request) return notFound()
      if (interactionOf(handle, request.id) !== contact.id) return refuse('conflict', NOT_THIS_CONTACT.error, { code: NOT_THIS_CONTACT.code })

      const parts: Array<{ part: Part; recordId: string; version: number; expectedVersion: number; actions: readonly string[] }> = [
        ...(ib ? [{ part: 'interaction' as const, recordId: contact.id, version: ib.version as number, expectedVersion: ib.expectedVersion as number, actions: [SETTLE] }] : []),
        { part: 'replyRequest', recordId: request.id, version: rb.version, expectedVersion: rb.expectedVersion, actions: CONTACT_REPLY_ENDS },
      ]
      const steps: typeof parts = []
      const results: Partial<Record<Part, ContactPartResult>> = {}
      for (const p of parts) {
        const ledger = handle.records.ledger(p.recordId)
        const entry = ledger.find(e => e.version === p.version)
        // Only what a finish writes: any other change is undone where it was made (the record's own ［取り消す］).
        if (entry && !p.actions.includes(entry.action)) return refuse('conflict', NOT_A_FINISH.error, { code: NOT_A_FINISH.code, part: p.part })
        const undone = ledger.find(e => e.action === 'undo' && e.reversesVersion === p.version)
        if (entry && undone) results[p.part] = partResult(handle, p.recordId, 'already', undone.version)
        else steps.push(p)
      }
      if (steps.length > 0) {
        const r = deps.engine.undoTogether(member, actor, steps.map(s => ({ recordId: s.recordId, body: { version: s.version, expectedVersion: s.expectedVersion } })))
        if (!r.ok) return aboutPart(r, steps.map(s => s.part))
        steps.forEach((s, i) => { results[s.part] = partResult(handle, s.recordId, 'done', r.value[i].entry.version) })
      }
      return ok({ interaction: results.interaction ?? null, replyRequest: results.replyRequest as ContactPartResult })
    },
  }
}

export type ContactThreads = ReturnType<typeof createContactThreads>
