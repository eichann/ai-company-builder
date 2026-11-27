/**
 * 「返事の下書きを、わたしの書き方に合わせる」 on the server (owner decision 2026-11-28; shared/core/writing-style.ts).
 * The server keeps nothing: it hands a member their own newest sent messages, read now through the connector that
 * serves a role with the optional capability `sent_samples` (ports/sent-samples.ts), so their PC can make the
 * summary; and it tells which summary fits a thread (connector id × 身内 / よそ). It never names a tool: a
 * connector registers its reader under its id, the role resolver says which one serves the company now.
 *
 *   sources(member)            the connectors that could hand samples, and whether the member's permission reads now
 *   samples(member, connector) that connector's samples (only one serving a role now, only while readable)
 *   keyForThread(member, …)    the summary key for a reply into a thread of a role (null: none fits)
 */
import { hasRoleCapability, type ConnectorRole } from '../../shared/core/connector-roles'
import { isWritingConnectorId, WRITING_SAMPLES_MAX, type WritingAudience } from '../../shared/core/writing-style'
import type { WritingSamplesView, WritingSourcesView } from '../../shared/types/writing-style'
import type { SentSamplesReader, ThreadParty } from '../ports/sent-samples'
import type { ConnectorRoles } from './connector-roles'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

/** The roles whose connector may carry the capability, in the order the sources are listed. */
const ROLES_WITH_SAMPLES: readonly ConnectorRole[] = ['mail', 'chat']
const READ_OPERATION: Record<string, string> = { mail: 'read', chat: 'receive' }

export const WRITING_SOURCE_NOT_FOUND = { error: 'この書き方の読み先は使えません。', code: 'WRITING_SOURCE_NOT_FOUND' }
export const WRITING_SOURCE_NOT_READABLE = { error: '送ったメッセージを読む許可がないか、オフになっています。', code: 'WRITING_SOURCE_NOT_READABLE' }
export const WRITING_SOURCE_UNAVAILABLE = { error: 'いまは送ったメッセージを読めません。少し待ってからもう一度試してください。', code: 'WRITING_SOURCE_UNAVAILABLE' }

export interface WritingSamplesDeps {
  roles: Pick<ConnectorRoles, 'resolve'>
  /** The connector's name as people know it (its declaration's label), else the id. */
  labelOf(connectorId: string): string
}

export function createWritingSamples(deps: WritingSamplesDeps) {
  const readers = new Map<string, SentSamplesReader>()

  /** The connector serving `role` now in the company, when it declares `sent_samples` and registered a reader. */
  async function servingFor(companyId: string, role: ConnectorRole): Promise<{ connectorId: string; reader: SentSamplesReader } | null> {
    const resolved = await deps.roles.resolve(companyId, role, READ_OPERATION[role])
    if (!resolved.ok || !hasRoleCapability(resolved, 'sent_samples')) return null
    const reader = readers.get(resolved.connectorId)
    return reader ? { connectorId: resolved.connectorId, reader } : null
  }

  return {
    /** A connector registers its reader once at start-up (composition). */
    register(connectorId: string, reader: SentSamplesReader): void {
      if (!isWritingConnectorId(connectorId)) throw new Error(`Bad connector id for sent samples: ${connectorId}`)
      if (readers.has(connectorId)) throw new Error(`Sent samples registered twice: ${connectorId}`)
      readers.set(connectorId, reader)
    },

    async sources(member: Member): Promise<Outcome<WritingSourcesView>> {
      const seen = new Set<string>()
      const sources: WritingSourcesView['sources'] = []
      for (const role of ROLES_WITH_SAMPLES) {
        const s = await servingFor(member.companyId, role)
        if (!s || seen.has(s.connectorId)) continue
        seen.add(s.connectorId)
        let readable = false
        try { readable = await s.reader.readable(member.companyId, member.userId) } catch { readable = false }
        sources.push({ connectorId: s.connectorId, label: deps.labelOf(s.connectorId), readable })
      }
      return ok({ sources })
    },

    async samples(member: Member, connectorId: unknown): Promise<Outcome<WritingSamplesView>> {
      if (!isWritingConnectorId(connectorId)) return refuse('not-found', WRITING_SOURCE_NOT_FOUND.error, { code: WRITING_SOURCE_NOT_FOUND.code })
      // Only a connector serving one of the roles in this company now: never another one registered on the server.
      let serving: SentSamplesReader | null = null
      for (const role of ROLES_WITH_SAMPLES) {
        const s = await servingFor(member.companyId, role)
        if (s && s.connectorId === connectorId) { serving = s.reader; break }
      }
      if (!serving) return refuse('not-found', WRITING_SOURCE_NOT_FOUND.error, { code: WRITING_SOURCE_NOT_FOUND.code })
      let readable = false
      try { readable = await serving.readable(member.companyId, member.userId) } catch { readable = false }
      if (!readable) return refuse('conflict', WRITING_SOURCE_NOT_READABLE.error, { code: WRITING_SOURCE_NOT_READABLE.code })
      const r = await serving.recentSent(member.companyId, member.userId, WRITING_SAMPLES_MAX).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
      if (!r.ok) {
        return r.reason === 'not-allowed'
          ? refuse('conflict', WRITING_SOURCE_NOT_READABLE.error, { code: WRITING_SOURCE_NOT_READABLE.code })
          : refuse('unavailable', WRITING_SOURCE_UNAVAILABLE.error, { code: WRITING_SOURCE_UNAVAILABLE.code })
      }
      return ok({ connectorId, samples: r.samples.slice(0, WRITING_SAMPLES_MAX) })
    },

    /**
     * Which summary fits a reply into a thread the member just read through `role`: the connector serving the
     * role now (with the capability) and its judgement of the other side. Null when none (no capability, no
     * reader, it cannot tell): the AI then drafts as before.
     */
    async keyForThread(member: Member, role: ConnectorRole, thread: readonly ThreadParty[]): Promise<{ connectorId: string; audience: WritingAudience } | null> {
      const s = await servingFor(member.companyId, role).catch(() => null)
      if (!s) return null
      let audience: WritingAudience | null = null
      try { audience = s.reader.audienceOf(member.companyId, member.userId, thread) } catch { audience = null }
      return audience ? { connectorId: s.connectorId, audience } : null
    },
  }
}

export type WritingSamples = ReturnType<typeof createWritingSamples>
