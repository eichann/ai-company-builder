/**
 * The AI's credential for the company map (`.claude/rules/records.md` "Who
 * is acting"). Whether an action was taken by a person or by their AI is
 * decided by the server from HOW the call was authenticated, never from what
 * the app says:
 *
 * - the member's session (their app's screens) → actor kind `human`;
 * - a record token (the AI's record tools) → actor kind `ai`.
 *
 * The member's app (main process) asks for a token per chat turn with the
 * member's session and hands only the token to its AI tools; the AI process
 * never receives the session. A token is scoped to one company and member,
 * `read` (look up) or `act` (also run actions: Claude only, 0.3-3), lives at
 * most RECORD_TOKEN_TTL_MINUTES and is revoked when the turn ends. Only its
 * sha256 is stored.
 *
 * Token: `acb_rec_<company id>.<64 hex>`. The company id in it only says
 * which company's handle to look in: a token is valid only if its digest is
 * found there (another company's id finds nothing), and the holder must
 * still be a member. While the company's AI is stopped (emergency stop,
 * agent-stop.md) every token is refused.
 */
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const RECORD_TOKEN_PREFIX = 'acb_rec_'
export const RECORD_TOKEN_TTL_MINUTES = 120
export const RECORD_TOKENS_PER_MEMBER = 50
const TOKEN_RE = /^acb_rec_([A-Za-z0-9_-]{1,100})\.([0-9a-f]{64})$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export interface RecordTokenIssued {
  token: string
  tokenId: string
  scope: 'read' | 'act'
  expiresAt: string
}

/** Who a valid token acts for. */
export interface RecordTokenHolder {
  member: Member
  scope: 'read' | 'act'
  /** The AI's agent id as the app said when asking (recorded as the actor's source). */
  agent: string
  tokenId: string
}

export interface RecordAiTokenDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  tokenDigest: TokenDigest
  memberOf: (companyId: string, userId: string) => Member | null
  /** The company's whole AI is stopped (agent-stop.md). */
  companyStopped: (companyId: string) => boolean
}

const UNAUTHORIZED = { error: 'Unauthorized', code: 'RECORD_TOKEN_INVALID' }

export function createRecordAiTokenService(deps: RecordAiTokenDeps) {
  const { companyData, clock, ids, tokenDigest } = deps
  return {
    /** POST …/me/record-tokens { conversationId, agent, scope } — with the member's session. */
    issue(member: Member, body: unknown): Outcome<RecordTokenIssued> {
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return refuse('bad-request', 'Body must be a JSON object')
      const { conversationId, agent, scope } = b
      if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200 || CONTROL.test(conversationId)) {
        return refuse('bad-request', 'conversationId is required (1–200 characters)')
      }
      if (typeof agent !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(agent)) return refuse('bad-request', 'agent is a short name')
      if (scope !== 'read' && scope !== 'act') return refuse('bad-request', 'scope is read or act')
      const records = companyData.forCompany(member.companyId).records
      if (!records.settings().enabled) return refuse('not-found', 'この会社では記録の機能が有効になっていません', { code: 'RECORDS_DISABLED' })
      const now = clock.nowMs()
      records.pruneAiTokens(new Date(now - 86_400_000).toISOString())
      if (records.liveAiTokens(member.userId, new Date(now).toISOString()) >= RECORD_TOKENS_PER_MEMBER) {
        return refuse('rate-limited', 'Too many live record tokens', { code: 'TOO_MANY_TOKENS', retryAfterSeconds: 60 })
      }
      const secret = ids.newToken()
      const token = `${RECORD_TOKEN_PREFIX}${member.companyId}.${secret}`
      const tokenId = ids.newId()
      const expiresAt = new Date(now + RECORD_TOKEN_TTL_MINUTES * 60_000).toISOString()
      records.insertAiToken({
        id: tokenId, userId: member.userId, tokenHash: tokenDigest.digest(token), scope, agent, conversationId,
        createdAt: new Date(now).toISOString(), expiresAt, revokedAt: null,
      })
      return ok({ token, tokenId, scope, expiresAt })
    },

    /** DELETE …/me/record-tokens/:tokenId — the member's own token only. */
    revoke(member: Member, tokenId: string): Outcome<{ revoked: true }> {
      const done = companyData.forCompany(member.companyId).records.revokeAiToken(member.userId, tokenId, clock.now())
      return done ? ok({ revoked: true }) : refuse('not-found', 'Token not found')
    },

    /** The holder of `Authorization: Bearer <token>`, or the 401 / 403 answer. */
    authenticate(header: string | undefined): Outcome<RecordTokenHolder> {
      const m = /^Bearer (.+)$/.exec(header ?? '')
      const parsed = m ? TOKEN_RE.exec(m[1]) : null
      if (!m || !parsed) return refuse('unauthorized', UNAUTHORIZED.error, { code: UNAUTHORIZED.code })
      const companyId = parsed[1]
      const row = companyData.forCompany(companyId).records.aiTokenByHash(tokenDigest.digest(m[1]))
      if (!row || row.revokedAt !== null || Date.parse(row.expiresAt) <= clock.nowMs()) return refuse('unauthorized', UNAUTHORIZED.error, { code: UNAUTHORIZED.code })
      const member = deps.memberOf(companyId, row.userId)
      if (!member) return refuse('unauthorized', UNAUTHORIZED.error, { code: UNAUTHORIZED.code })
      if (deps.companyStopped(companyId)) {
        return refuse('forbidden', '管理者が AI の利用を一時停止しています。再開されるまで使えません。', { code: 'ACB_STOPPED' })
      }
      return ok({ member, scope: row.scope, agent: row.agent, tokenId: row.id })
    },
  }
}

export type RecordAiTokenService = ReturnType<typeof createRecordAiTokenService>
