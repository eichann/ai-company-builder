/**
 * The member's AI's credentials on the AI routes (`.claude/rules/records.md`
 * "Who is acting"): a record token, never a session, and — inside an
 * execution run — the idempotency key of every outside operation (S10b).
 * Shared by routes/records-ai.ts and the Google connector's AI routes
 * (routes/google-drive.ts), so each mounts under /api/records-ai alike.
 */
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { services } from '../composition'
import { NOT_IN_STEP } from '../services/not-in-step'
import type { RecordTokenHolder } from '../services/record-ai-tokens'
import { noteRequestUser } from '../lib/request-log'
import { refusal } from './respond'

const { recordAiTokens, aiRuns, pluginRunGate } = services

/** The token's holder, or the refusal (401 without one; 403 `READ_ONLY_TOKEN` for an act route with a read token). */
export function holderOf(c: Context, needs: 'read' | 'act'): RecordTokenHolder | Response {
  const auth = recordAiTokens.authenticate(c.req.header('Authorization'))
  if (!auth.ok) return refusal(c, auth)
  noteRequestUser(c.req.raw, auth.value.member.userId)
  if (needs === 'act' && auth.value.scope !== 'act') {
    return c.json({ error: 'この AI は記録を読むことだけができます', code: 'READ_ONLY_TOKEN' }, 403)
  }
  return auth.value
}

/**
 * Before an AI route uses a connector role (`mail.read`, `calendar.read`…):
 * a token bound to a run of a business plugin's step may use only the roles
 * that step declares (plan C4, plugins.md "The gate of a step's run"); the
 * refusal is the gate's one answer (403 `NOT_IN_STEP`), naming nothing.
 */
export async function connectorRoleRefusal(c: Context, h: RecordTokenHolder, role: string): Promise<Response | null> {
  if (await pluginRunGate.allowsConnectorRole(h.member, h.run?.id ?? null, role, h.conversationId)) return null
  return c.json({ error: NOT_IN_STEP.error, code: NOT_IN_STEP.code }, 403)
}

// The conversation and the execution run come from the token, never the body (a body's proposedBy / conversationId is ignored here).
export const aiActor = (h: RecordTokenHolder) => ({ kind: 'ai' as const, source: h.agent, conversationId: h.conversationId, runId: h.run?.id ?? null })

/**
 * An outside operation (or a create) made within an execution run (S10b,
 * records.md "Execution runs"): it needs an `Idempotency-Key` header, and the
 * same key never repeats the effect (services/ai-runs.ts `keyed`). A
 * consultation's token (no run) is unchanged.
 */
export async function keyedWrite(c: Context, h: RecordTokenHolder, kind: string, body: unknown, write: () => Promise<Response>): Promise<Response> {
  if (!h.run) return write()
  const answer = await aiRuns.keyed(
    { companyId: h.member.companyId, userId: h.member.userId, runId: h.run.id, generation: h.run.generation },
    c.req.header('Idempotency-Key'), { method: c.req.method, path: c.req.path, body }, kind,
    async () => {
      const res = await write()
      return { status: res.status, body: await res.json().catch(() => null) }
    },
  )
  return c.json(answer.body as object, answer.status as ContentfulStatusCode)
}
