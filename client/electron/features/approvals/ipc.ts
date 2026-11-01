// The chat's approval card (milestone 4 G6, .claude/rules/approvals.md): the person's own
// acts on an approval request, sent with the member's **session** — never the AI's record
// token (the server has no AI route that approves). The card fetches the request every time
// it is shown, with the names of the members it mentions from the company's member list.
//   approvals:get        the request (fixed content, hash, precedents, materials, state)
//   approvals:approve    「承認」 with the reason and the hash the card shows
//   approvals:sendBack   「差し戻す」 with the reason
//   approvals:withdraw   「取り下げる」 (the requester)

import { APPROVALS_OFFLINE_TEXT, namedMembers, type ApprovalResult } from '../../../shared/approvals'
import type { ApprovalView } from '../../../../shared/types/approvals'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface ApprovalsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  /** Per request (default 30 s: approving writes to the outside system). */
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const APPROVAL = /^approval-[0-9a-z]{6,32}$/
const HASH = /^sha256:[0-9a-f]{64}$/

export function createApprovalsApi(deps: ApprovalsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(companyId: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null } | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
    } catch {
      return null
    }
  }

  /** Display names of the members a view names (the company's member list; never shown as ids). */
  async function namesFor(companyId: string, view: ApprovalView | undefined): Promise<Record<string, string>> {
    if (!view) return {}
    const wanted = new Set(namedMembers(view))
    const r = await call(companyId, '/members', 'GET')
    const list = r && r.status === 200 && Array.isArray(r.json?.data) ? r.json.data as Array<{ userId?: unknown; name?: unknown; email?: unknown }> : []
    const names: Record<string, string> = {}
    for (const m of list) {
      if (typeof m.userId !== 'string' || !wanted.has(m.userId)) continue
      const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : typeof m.email === 'string' ? m.email.split('@')[0] : ''
      if (name) names[m.userId] = name
    }
    return names
  }

  async function request(companyId: string, approvalId: string, suffix: '' | '/approve' | '/send-back' | '/withdraw', body?: unknown): Promise<ApprovalResult> {
    if (!COMPANY.test(companyId) || !APPROVAL.test(approvalId)) return { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
    const r = await call(companyId, `/approvals/${approvalId}${suffix}`, suffix === '' ? 'GET' : 'POST', body)
    if (!r) {
      // An approve whose answer was lost is not known to have failed: the card reads the request again.
      log.warn(`[approvals] ${suffix || 'get'}: the server could not be reached`)
      return { success: false, offline: true, code: null, error: APPROVALS_OFFLINE_TEXT }
    }
    const data = r.json?.data as { approval?: ApprovalView } | undefined
    if (r.status >= 200 && r.status < 300 && data?.approval) {
      return { success: true, approval: data.approval, names: await namesFor(companyId, data.approval) }
    }
    const code = typeof r.json?.code === 'string' ? r.json.code : null
    log.warn(`[approvals] ${suffix || 'get'}: answered ${r.status}${code ? ` ${code}` : ''}`)
    const approval = r.json?.approval && typeof r.json.approval === 'object' ? r.json.approval as ApprovalView : undefined
    return {
      success: false, offline: r.status >= 500, code,
      error: typeof r.json?.error === 'string' && r.status < 500 ? r.json.error : `サーバーでエラーが起きました（HTTP ${r.status}）。`,
      ...(approval ? { approval, names: await namesFor(companyId, approval) } : {}),
    }
  }

  return {
    get: (companyId: string, approvalId: string) => request(companyId, approvalId, ''),
    approve: (companyId: string, approvalId: string, hash: string, reason: string) => {
      if (typeof hash !== 'string' || !HASH.test(hash) || typeof reason !== 'string') {
        return Promise.resolve<ApprovalResult>({ success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' })
      }
      return request(companyId, approvalId, '/approve', { hash, reason })
    },
    sendBack: (companyId: string, approvalId: string, reason: string) =>
      typeof reason === 'string'
        ? request(companyId, approvalId, '/send-back', { reason })
        : Promise.resolve<ApprovalResult>({ success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }),
    withdraw: (companyId: string, approvalId: string) => request(companyId, approvalId, '/withdraw'),
  }
}

export function registerApprovalsIpc(ipc: IpcRegistrar, deps: ApprovalsDeps) {
  const api = createApprovalsApi(deps)
  ipc.handle('approvals:get', (_event, companyId, approvalId) => api.get(companyId, approvalId))
  ipc.handle('approvals:approve', (_event, companyId, approvalId, hash, reason) => api.approve(companyId, approvalId, hash, reason))
  ipc.handle('approvals:sendBack', (_event, companyId, approvalId, reason) => api.sendBack(companyId, approvalId, reason))
  ipc.handle('approvals:withdraw', (_event, companyId, approvalId) => api.withdraw(companyId, approvalId))
}
