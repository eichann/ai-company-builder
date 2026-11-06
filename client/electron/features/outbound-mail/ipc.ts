// The chat's mail card (milestone 4 G8, outbound-mail.md): the person's own
// actions on a draft, sent with the member's session — never the AI's record
// token — so the server records them as the person's. Sending exists only here.
//   outboundMail:get            the draft now
//   outboundMail:recipients     its verified recipients (sources, typed ones included)
//   outboundMail:update         a new version (the person's edit)
//   outboundMail:addRecipient   「あなたが入力」 an address
//   outboundMail:send           「確かめて送る」 with the hash of the version shown (+ 「返事を待つ」's day,
//                               + the files shown: outbound-mail.md "Attachments", + 「それでも送る」's
//                               reason after an earlier send on the same source: "One send per source")

//   outboundMail:resolve        送られていた／送られていなかった after an unknown send
//   outboundMail:discard        「捨てる」
//   outboundMail:openAttachment 「開いて確かめる」: the stored PDF downloaded with the session into a
//                               temporary folder and opened with the OS viewer (the bytes never reach
//                               the renderer; the session never leaves main)
//   outboundMail:removeAttachment 「外す」: a new version without that file

import { createHash, randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { looksLikePdf, sanitizeAttachmentName } from '../../../../shared/core/mail'
import {
  MESSAGE_ID_RE, OUTBOUND_MAIL_OFFLINE_TEXT, isAttachmentId, isAwaitReply, isContentHash, isResendReason, isShownAttachments, readAlreadySent,
  type MailAttachmentOpenResult, type MailAwaitReply, type MailDraftEdit, type OutboundMailResult,
} from '../../../shared/outbound-mail'
import type { MailRecipientsView, MailRecipientView, OutboundMailView } from '../../../../shared/types/outbound-mail'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { DesktopShell } from '../ports'

export interface OutboundMailDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  /** Per request (default 60 s: a send re-reads the calendar and HubSpot, then Gmail). */
  timeoutMs?: number
  /** 「開いて確かめる」 hands the saved PDF to the OS viewer. */
  shell?: Pick<DesktopShell, 'openPath'>
  /** Where opened files are saved (default: `<os temp>/acb-mail-files`); older ones are cleared. */
  filesDir?: () => string
  now?: () => number
}

/** Opened files older than this are removed the next time a file is opened. */
const OPENED_FILE_TTL_MS = 24 * 60 * 60 * 1000

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const REF = /^r[0-9a-f]{24}$/
/** 503s whose sentence is the server's own (a connector stopped), not an outage. */
const SAID_BY_SERVER = new Set(['GOOGLE_UNAVAILABLE', 'SLACK_UNAVAILABLE'])
const BAD: OutboundMailResult = { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }

type Data = { draft?: OutboundMailView; outcome?: 'sent' | 'unknown'; message?: string; recipient?: MailRecipientView } & Partial<MailRecipientsView>

export function createOutboundMailApi(deps: OutboundMailDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  /**
   * 「開いて確かめる」: the bytes the server will send, fetched with the session, checked (a PDF whose
   * sha256 is the one asked for), saved under a fresh folder of the temp directory and opened with the
   * OS viewer. Nothing of the file reaches the renderer.
   */
  async function openAttachment(companyId: string, messageId: string, sha256: string): Promise<MailAttachmentOpenResult> {
    const refused = { success: false as const, offline: false, error: 'ファイルを開けませんでした。' }
    if (!COMPANY.test(companyId) || !MESSAGE_ID_RE.test(messageId) || !isAttachmentId(sha256) || !deps.shell) return refused
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return { success: false, offline: true, error: OUTBOUND_MAIL_OFFLINE_TEXT }
    let res: Response
    try {
      res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/outbound/${messageId}/attachments/${sha256}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000), headers: { Cookie: cookies.join('; ') },
      })
    } catch {
      log.warn('[outbound-mail] attachment: the server could not be reached')
      return { success: false, offline: true, error: OUTBOUND_MAIL_OFFLINE_TEXT }
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null
      log.warn(`[outbound-mail] attachment: answered ${res.status}${typeof json?.code === 'string' ? ` ${json.code}` : ''}`)
      return { success: false, offline: res.status >= 500, error: typeof json?.error === 'string' && res.status < 500 ? json.error : refused.error }
    }
    const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
    if (!looksLikePdf(bytes) || createHash('sha256').update(bytes).digest('hex') !== sha256) return refused
    const name = sanitizeAttachmentName(nameFromDisposition(res.headers.get('content-disposition'))) ?? 'file.pdf'
    try {
      const root = deps.filesDir?.() ?? path.join(os.tmpdir(), 'acb-mail-files')
      clearOld(root)
      const dir = path.join(root, randomBytes(8).toString('hex'))
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, name)
      fs.writeFileSync(file, bytes, { mode: 0o600 })
      const problem = await deps.shell.openPath(file)
      if (problem) { log.warn('[outbound-mail] attachment: the viewer did not open'); return refused }
      return { success: true }
    } catch {
      log.warn('[outbound-mail] attachment: could not be saved')
      return refused
    }
  }

  /** Folders of files opened more than a day ago (best effort). */
  function clearOld(root: string) {
    const now = deps.now?.() ?? Date.now()
    let entries: string[] = []
    try { entries = fs.readdirSync(root) } catch { return }
    for (const e of entries) {
      try {
        const p = path.join(root, e)
        if (now - fs.statSync(p).mtimeMs > OPENED_FILE_TTL_MS) fs.rmSync(p, { recursive: true, force: true })
      } catch { /* in use: next time */ }
    }
  }

  async function request(companyId: string, messageId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', suffix: string, body?: unknown, needsDraft = true): Promise<OutboundMailResult> {
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
    const json = (await res.json().catch(() => null)) as { data?: Data; error?: unknown; code?: unknown; needsGoogleConsent?: unknown; draft?: OutboundMailView; alreadySent?: unknown } | null
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
      success: false, offline: res.status >= 500 && !SAID_BY_SERVER.has(code ?? ''), code,
      error: typeof json?.error === 'string' && (res.status < 500 || SAID_BY_SERVER.has(code ?? '')) ? json.error : `サーバーでエラーが起きました（HTTP ${res.status}）。`,
      ...(json?.needsGoogleConsent === 'mail' ? { needsGoogleConsent: 'mail' as const } : {}),
      ...(json?.draft ? { draft: json.draft } : {}),
      ...(code === 'ALREADY_SENT_FOR_SOURCE' ? { alreadySent: readAlreadySent(json?.alreadySent) ?? undefined } : {}),
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
    send(companyId: string, messageId: string, hash: string, awaitReply?: MailAwaitReply | null, attachmentsShown?: string[] | null, resendReason?: string | null) {
      if (!isContentHash(hash)) return Promise.resolve(BAD)
      // 「返事を待つ」: a day only (the server checks it is today … 180 days ahead); anything else never leaves.
      if (awaitReply !== undefined && awaitReply !== null && !isAwaitReply(awaitReply)) return Promise.resolve(BAD)
      // The files the card showed: their sha256 only (the server sends a version with files only when it gets them).
      if (attachmentsShown !== undefined && attachmentsShown !== null && !isShownAttachments(attachmentsShown)) return Promise.resolve(BAD)
      // 「それでも送る」: one line of the person's own words (the server checks it again).
      if (resendReason !== undefined && resendReason !== null && !isResendReason(resendReason)) return Promise.resolve(BAD)
      return request(companyId, messageId, 'POST', '/send', {
        hash, ...(awaitReply ? { awaitReply: { until: awaitReply.until } } : {}), ...(attachmentsShown && attachmentsShown.length > 0 ? { attachmentsShown: [...attachmentsShown] } : {}),
        ...(resendReason ? { resendReason } : {}),
      })
    },
    removeAttachment(companyId: string, messageId: string, sha256: string, expectedVersion: number) {
      if (!isAttachmentId(sha256) || !Number.isInteger(expectedVersion) || expectedVersion < 1) return Promise.resolve(BAD)
      return request(companyId, messageId, 'DELETE', `/attachments/${sha256}?expectedVersion=${expectedVersion}`)
    },
    openAttachment,
    resolve(companyId: string, messageId: string, sent: boolean) {
      if (typeof sent !== 'boolean') return Promise.resolve(BAD)
      return request(companyId, messageId, 'POST', '/resolve', { sent })
    },
    discard: (companyId: string, messageId: string) => request(companyId, messageId, 'POST', '/discard', {}),
  }
}

/** The file name of `Content-Disposition: attachment; filename*=UTF-8''…` (then made plain again by the caller). */
function nameFromDisposition(header: string | null): string | null {
  const m = header ? /filename\*=UTF-8''([^;\s]+)/i.exec(header) : null
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return null }
}

export function registerOutboundMailIpc(ipc: IpcRegistrar, deps: OutboundMailDeps) {
  const api = createOutboundMailApi(deps)
  ipc.handle('outboundMail:get', (_event, companyId, messageId) => api.get(companyId, messageId))
  ipc.handle('outboundMail:recipients', (_event, companyId, messageId) => api.recipients(companyId, messageId))
  ipc.handle('outboundMail:update', (_event, companyId, messageId, edit, conversationId) => api.update(companyId, messageId, edit, conversationId))
  ipc.handle('outboundMail:addRecipient', (_event, companyId, messageId, email, name) => api.addRecipient(companyId, messageId, email, name))
  ipc.handle('outboundMail:send', (_event, companyId, messageId, hash, awaitReply, attachmentsShown, resendReason) => api.send(companyId, messageId, hash, awaitReply, attachmentsShown, resendReason))

  ipc.handle('outboundMail:openAttachment', (_event, companyId, messageId, sha256) => api.openAttachment(companyId, messageId, sha256))
  ipc.handle('outboundMail:removeAttachment', (_event, companyId, messageId, sha256, expectedVersion) => api.removeAttachment(companyId, messageId, sha256, expectedVersion))
  ipc.handle('outboundMail:resolve', (_event, companyId, messageId, sent) => api.resolve(companyId, messageId, sent))
  ipc.handle('outboundMail:discard', (_event, companyId, messageId) => api.discard(companyId, messageId))
}
