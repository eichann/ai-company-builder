// 「連絡」1枚 (inbox.md "One contact"), with the member's session (it stays here):
//   inbox:contact        the contact as the member reads it (GET …/inbox/items/:id/contact; a 返事のお願い's id works too)
//   inbox:finishContact  the card's ［返した］/［済んだ］: the 返事のお願い's end and the contact's 「済んだ」, both or neither
//   inbox:undoContact    its ［取り消す］: both entries taken back, both or neither
//   inbox:contactArchived  after it: whether the mail stays archived in Gmail (the contact's history: ACB's archive note
//                        written after the finish and not taken back)
// The server decides who may do what and answers only what the member reads; main checks the shapes and adds nothing.
// Nothing of a contact is logged (only the status and the code).
import { RECORD_ID_RE } from '../../../../shared/core/records'
import {
  archiveStays, CONTACT_OFFLINE_TEXT, readContactView, readFinishResult, readUndoResult,
  type ContactArchivedResult, type ContactFinishAnswer, type ContactFinishRequest, type ContactReadResult, type ContactRefusal, type ContactUndoAnswer, type ContactUndoRequest,
} from '../../../shared/contact-card'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface ContactDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
  /** A write of the company was sent (answered or not): shared reads on their way are not joined. */
  changed?: (companyId: string) => void
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const ENDS = new Set(['replied_elsewhere', 'close', 'drop'])
const NOTE_MAX = 2000
const BAD_INPUT: ContactRefusal = { success: false, offline: false, gone: false, code: 'BAD_REQUEST', part: null, error: '入力が正しくありません。' }

type Answer = { status: number; json: { data?: unknown; error?: unknown; code?: unknown; part?: unknown } | null } | null

const version = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const recordId = (v: unknown): v is string => typeof v === 'string' && RECORD_ID_RE.test(v)

/** Only the fields the server reads, checked: anything else never leaves this PC. */
function finishBody(v: unknown): ContactFinishRequest | null {
  const b = v as { interaction?: { expectedVersion?: unknown }; replyRequest?: { id?: unknown; expectedVersion?: unknown; action?: unknown; note?: unknown } } | null
  const r = b?.replyRequest
  if (!b || !version(b.interaction?.expectedVersion) || !r || !recordId(r.id) || !version(r.expectedVersion) || typeof r.action !== 'string' || !ENDS.has(r.action)) return null
  if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > NOTE_MAX)) return null
  return {
    interaction: { expectedVersion: b.interaction.expectedVersion },
    replyRequest: { id: r.id, expectedVersion: r.expectedVersion, action: r.action as ContactFinishRequest['replyRequest']['action'], ...(typeof r.note === 'string' ? { note: r.note } : {}) },
  }
}

function undoBody(v: unknown): ContactUndoRequest | null {
  const b = v as { interaction?: { version?: unknown; expectedVersion?: unknown }; replyRequest?: { id?: unknown; version?: unknown; expectedVersion?: unknown } } | null
  const r = b?.replyRequest
  if (!b || !r || !recordId(r.id) || !version(r.version) || !version(r.expectedVersion)) return null
  const i = b.interaction
  if (i !== undefined && (!version(i?.version) || !version(i?.expectedVersion))) return null
  return { ...(i ? { interaction: { version: i.version as number, expectedVersion: i.expectedVersion as number } } : {}), replyRequest: { id: r.id, version: r.version, expectedVersion: r.expectedVersion } }
}

export function createContactApi(deps: ContactDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: await res.json().catch(() => null) as NonNullable<Answer>['json'] }
    } catch {
      return null
    } finally {
      if (method === 'POST') deps.changed?.(companyId)
    }
  }

  function refusal(what: string, a: Answer): ContactRefusal {
    if (!a) {
      log.warn(`[inbox] contact ${what}: the server could not be reached`)
      return { success: false, offline: true, gone: false, code: null, part: null, error: CONTACT_OFFLINE_TEXT }
    }
    const code = typeof a.json?.code === 'string' ? a.json.code : null
    const part = a.json?.part === 'interaction' || a.json?.part === 'replyRequest' ? a.json.part : null
    log.warn(`[inbox] contact ${what} answered ${a.status}${code ? ` ${code}` : ''}`)
    const error = typeof a.json?.error === 'string' && a.status < 500 ? a.json.error : `サーバーでエラーが起きました（HTTP ${a.status}）。`
    return { success: false, offline: a.status >= 500, gone: a.status === 404, code, part, error }
  }

  return {
    async read(companyId: unknown, id: unknown): Promise<ContactReadResult> {
      if (typeof companyId !== 'string' || !COMPANY.test(companyId) || !recordId(id)) return { success: false, gone: true }
      const a = await call(companyId, 'GET', `/inbox/items/${encodeURIComponent(id)}/contact`)
      const contact = a?.status === 200 ? readContactView(a.json?.data) : null
      if (contact) return { success: true, contact }
      if (a?.status === 404) return { success: false, gone: true }
      const r = refusal('read', a)
      return { success: false, gone: false, offline: r.offline, error: a?.status === 200 ? '連絡を読めませんでした。' : r.error }
    },

    async finish(companyId: unknown, interactionId: unknown, input: unknown): Promise<ContactFinishAnswer> {
      const body = finishBody(input)
      if (typeof companyId !== 'string' || !COMPANY.test(companyId) || !recordId(interactionId) || !body) return BAD_INPUT
      const a = await call(companyId, 'POST', `/inbox/items/${encodeURIComponent(interactionId)}/finish`, body)
      const result = a?.status === 200 ? readFinishResult(a.json?.data) : null
      return result ? { success: true, result } : refusal('finish', a)
    },

    /** After ［取り消す］: does the mail stay archived in Gmail (the contact's ledger, read with the session)? */
    async archived(companyId: unknown, interactionId: unknown, afterVersion: unknown): Promise<ContactArchivedResult> {
      if (typeof companyId !== 'string' || !COMPANY.test(companyId) || !recordId(interactionId) || !version(afterVersion)) return { success: false }
      const a = await call(companyId, 'GET', `/records/item/${encodeURIComponent(interactionId)}/history`)
      if (a?.status !== 200) { refusal('history', a); return { success: false } }
      return { success: true, stays: archiveStays((a.json?.data as { entries?: unknown } | undefined)?.entries, afterVersion) }
    },

    async undo(companyId: unknown, interactionId: unknown, input: unknown): Promise<ContactUndoAnswer> {
      const body = undoBody(input)
      if (typeof companyId !== 'string' || !COMPANY.test(companyId) || !recordId(interactionId) || !body) return BAD_INPUT
      const a = await call(companyId, 'POST', `/inbox/items/${encodeURIComponent(interactionId)}/finish/undo`, body)
      const result = a?.status === 200 ? readUndoResult(a.json?.data) : null
      return result ? { success: true, result } : refusal('undo', a)
    },
  }
}

export function registerContactIpc(ipc: IpcRegistrar, deps: ContactDeps): void {
  const api = createContactApi(deps)
  ipc.handle('inbox:contact', (_event, companyId, id) => api.read(companyId, id))
  ipc.handle('inbox:finishContact', (_event, companyId, interactionId, input) => api.finish(companyId, interactionId, input))
  ipc.handle('inbox:undoContact', (_event, companyId, interactionId, input) => api.undo(companyId, interactionId, input))
  ipc.handle('inbox:contactArchived', (_event, companyId, interactionId, afterVersion) => api.archived(companyId, interactionId, afterVersion))
}
