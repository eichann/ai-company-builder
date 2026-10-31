/**
 * The server → app push channel's registry (`GET /me/events`, SSE;
 * .claude/rules/agent-stop.md). In memory, one process.
 *
 * - Subscribers are filed by company, then member: an announcement for a
 *   company reaches only that company's subscribers, each with the version
 *   computed for that member (company_id × user_id).
 * - At most `maxPerMember` open connections per member and company (a second
 *   PC, a reconnect racing the old one), and `maxTotal` overall.
 * - What is sent is only `{ kind, version }` (shared/types/agent-stop.ts
 *   PushEvent): never content, never a folder name.
 */
import type { PushEvent } from '../../shared/types/agent-stop'

export interface PushSubscriber {
  send(event: PushEvent): void
}

export type PushOpen = { ok: true; close: () => void } | { ok: false; reason: 'per-member' | 'total' }

export interface PushChannelOptions {
  maxPerMember?: number
  maxTotal?: number
}

export const PUSH_MAX_PER_MEMBER = 3
export const PUSH_MAX_TOTAL = 5000

export function createPushChannel(options: PushChannelOptions = {}) {
  const maxPerMember = options.maxPerMember ?? PUSH_MAX_PER_MEMBER
  const maxTotal = options.maxTotal ?? PUSH_MAX_TOTAL
  const byCompany = new Map<string, Map<string, Set<PushSubscriber>>>()
  let total = 0

  return {
    open(companyId: string, userId: string, subscriber: PushSubscriber): PushOpen {
      const members = byCompany.get(companyId) ?? new Map<string, Set<PushSubscriber>>()
      const own = members.get(userId) ?? new Set<PushSubscriber>()
      if (own.size >= maxPerMember) return { ok: false, reason: 'per-member' }
      if (total >= maxTotal) return { ok: false, reason: 'total' }
      own.add(subscriber)
      members.set(userId, own)
      byCompany.set(companyId, members)
      total++
      let closed = false
      return {
        ok: true,
        close() {
          if (closed) return
          closed = true
          total--
          own.delete(subscriber)
          if (own.size === 0 && members.get(userId) === own) members.delete(userId)
          if (members.size === 0 && byCompany.get(companyId) === members) byCompany.delete(companyId)
        },
      }
    },

    /** Tell this company's subscribers their policy changed (each gets their own version). */
    announce(companyId: string, versionFor: (userId: string) => string): void {
      const members = byCompany.get(companyId)
      if (!members) return
      for (const [userId, subscribers] of members) {
        let version: string
        try { version = versionFor(userId) } catch { continue }
        for (const subscriber of [...subscribers]) {
          try { subscriber.send({ kind: 'policy', version }) } catch { /* that connection is going away */ }
        }
      }
    },

    /**
     * Tell these members of this company that something concerning them
     * changed (kind `records`; the version is only a fresh value). Others —
     * and every other company — hear nothing.
     */
    notify(companyId: string, userIds: string[], event: PushEvent): void {
      const members = byCompany.get(companyId)
      if (!members) return
      for (const userId of new Set(userIds)) {
        for (const subscriber of [...(members.get(userId) ?? [])]) {
          try { subscriber.send({ kind: event.kind, version: event.version }) } catch { /* that connection is going away */ }
        }
      }
    },

    /** Open connections (diagnostics, tests). */
    count: () => total,
  }
}

export type PushChannel = ReturnType<typeof createPushChannel>
