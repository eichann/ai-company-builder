// The chat's mail card (milestone 4 G8, outbound-mail.md): the person's own
// actions on a draft, sent with the member's session — never the AI's record
// token — so the server records them as the person's. Sending exists only here.
//   outboundMail:get            the draft now
//   outboundMail:recipients     its verified recipients (sources, typed ones included)
//   outboundMail:update         a new version (the person's edit)
//   outboundMail:addRecipient   「あなたが入力」 an address
//   outboundMail:send           「確かめて送る」 with the hash of the version shown
//   outboundMail:resolve        送られていた／送られていなかった after an unknown send
//   outboundMail:discard        「捨てる」

import { MESSAGE_ID_RE, OUTBOUND_MAIL_OFFLINE_TEXT, isContentHash, type MailDraftEdit, type OutboundMailResult } from '../../../shared/outbound-mail'
import type { MailRecipientsView, MailRecipientView, OutboundMailView } from '../../../../shared/types/outbound-mail'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface OutboundMailDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  /** Per request (default 60 s: a send re-reads the calendar and HubSpot, then Gmail). */
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const REF = /^r[0-9a-f]{24}$/
const BAD: OutboundMailResult = { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }

type Data = { draft?: OutboundMailView; outcome?: 'sent' | 'unknown'; message?: string; recipient?: MailRecipientView } & Partial<MailRecipientsView>

export function createOutboundMailApi(deps: OutboundMailDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function request(companyId: string, messageId: string, method: 'GET' | 'POST' | 'PUT', suffix: string, body?: unknown, needsDraft = true): Promise<OutboundMailResult> {
    if (!COMPANY.test(companyId) || !MESSAGE_ID_RE.test(messageId)) return BAD
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return { success: false, offline: true, code: null, error: OUTBOUND_MAIL_OFFLINE_TEXT }
    let res: Response
    try {
      res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/outbound/${messageId}${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      // A send whose answer is lost is not known to have failed: the card says so and asks the server again.
      log.warn(`[outbound-mail] ${suffix || 'draft'}: the server could not be reached`)
      return { success: false, offline: true, code: null, error: OUTBOUND_MAIL_OFFLINE_TEXT }
    }
    const json = (await res.json().catch(() => null)) as { data?: Data; error?: unknown; code?: unknown; needsGoogleConsent?: unknown; draft?: OutboundMailView } | null
    const data = json?.data
    if (res.ok && data && (data.draft || !needsDraft)) {
      return {
        success: true, draft: data.draft as OutboundMailView,
        ...(data.outcome ? { outcome: data.outcome } : {}), ...(data.message ? { message: data.message } : {}),
        ...(data.recipient ? { recipient: data.recipient } : {}),
        ...(Array.isArray(data.recipients) ? { recipients: { recipients: data.recipients, unreadable: data.unreadable ?? [] } } : {}),
      }
    }
    const code = typeof json?.code === 'string' ? json.code : null
    log.warn(`[outbound-mail] ${suffix || 'draft'}: answered ${res.status}${code ? ` ${code}` : ''}`)
    return {
      success: false, offline: res.status >= 500 && code !== 'GOOGLE_UNAVAILABLE', code,
      error: typeof json?.error === 'string' && (res.status < 500 || code === 'GOOGLE_UNAVAILABLE') ? json.error : `サーバーでエラーが起きました（HTTP ${res.status}）。`,
      ...(json?.needsGoogleConsent === 'mail' ? { needsGoogleConsent: 'mail' as const } : {}),
      ...(json?.draft ? { draft: json.draft } : {}),
    }
  }

  const refs = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 20 && v.every(r => typeof r === 'string' && REF.test(r)))

  return {
    get: (companyId: string, messageId: string) => request(companyId, messageId, 'GET', ''),
    recipients: (companyId: string, messageId: string) => request(companyId, messageId, 'GET', '/recipients', undefined, false),
    update(companyId: string, messageId: string, edit: MailDraftEdit, conversationId?: string) {
      if (!edit || typeof edit !== 'object' || !Number.isInteger(edit.expectedVersion) || !refs(edit.toRefs) || !refs(edit.ccRefs)) return Promise.resolve(BAD)
      if ((edit.subject !== undefined && typeof edit.subject !== 'string') || (edit.body !== undefined && typeof edit.body !== 'string')) return Promise.resolve(BAD)
      const body = {
        expectedVersion: edit.expectedVersion, ...(edit.toRefs ? { toRefs: edit.toRefs } : {}), ...(edit.ccRefs ? { ccRefs: edit.ccRefs } : {}),
        ...(edit.subject !== undefined ? { subject: edit.subject } : {}), ...(edit.body !== undefined ? { body: edit.body } : {}),
        ...(typeof conversationId === 'string' && conversationId.length > 0 && conversationId.length <= 200 ? { conversationId } : {}),
      }
      return request(companyId, messageId, 'PUT', '', body)
    },
    addRecipient(companyId: string, messageId: string, email: string, name?: string) {
      if (typeof email !== 'string' || email.length > 254 || (name !== undefined && (typeof name !== 'string' || name.length > 100))) return Promise.resolve(BAD)
      return request(companyId, messageId, 'POST', '/recipients', { email, ...(name ? { name } : {}) })
    },
    send(companyId: string, messageId: string, hash: string) {
      if (!isContentHash(hash)) return Promise.resolve(BAD)
      return request(companyId, messageId, 'POST', '/send', { hash })
    },
    resolve(companyId: string, messageId: string, sent: boolean) {
      if (typeof sent !== 'boolean') return Promise.resolve(BAD)
      return request(companyId, messageId, 'POST', '/resolve', { sent })
    },
    discard: (companyId: string, messageId: string) => request(companyId, messageId, 'POST', '/discard', {}),
  }
}

export function registerOutboundMailIpc(ipc: IpcRegistrar, deps: OutboundMailDeps) {
  const api = createOutboundMailApi(deps)
  ipc.handle('outboundMail:get', (_event, companyId, messageId) => api.get(companyId, messageId))
  ipc.handle('outboundMail:recipients', (_event, companyId, messageId) => api.recipients(companyId, messageId))
  ipc.handle('outboundMail:update', (_event, companyId, messageId, edit, conversationId) => api.update(companyId, messageId, edit, conversationId))
  ipc.handle('outboundMail:addRecipient', (_event, companyId, messageId, email, name) => api.addRecipient(companyId, messageId, email, name))
  ipc.handle('outboundMail:send', (_event, companyId, messageId, hash) => api.send(companyId, messageId, hash))
  ipc.handle('outboundMail:resolve', (_event, companyId, messageId, sent) => api.resolve(companyId, messageId, sent))
  ipc.handle('outboundMail:discard', (_event, companyId, messageId) => api.discard(companyId, messageId))
}
