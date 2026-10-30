/**
 * Storage of the emergency stop (monitoring M2): the stops an owner/admin
 * made (released ones are the history) and which members' apps follow it.
 * Wire shapes: shared/types/agent-stop.ts; rules: services/agent-stops.ts.
 */

export interface StoredAgentStop {
  id: string
  /** null = everyone. */
  userId: string | null
  /** null = the whole AI. */
  tool: string | null
  reason: string
  stoppedAt: string
  stoppedBy: string
  releasedAt: string | null
  releasedBy: string | null
}

export interface AgentStopClientRow {
  userId: string
  clientVersion: string | null
  lastSeenAt: string
}

export interface AgentStopRepository {
  /** Stops in force, newest first. */
  active(companyId: string): StoredAgentStop[]
  /** Stops in force that apply to this member (theirs and everyone's). */
  activeFor(companyId: string, userId: string): StoredAgentStop[]
  /** Every stop, newest event first (stop or release), at most `limit`. */
  history(companyId: string, limit: number): StoredAgentStop[]
  find(companyId: string, stopId: string): StoredAgentStop | null
  insert(companyId: string, stop: StoredAgentStop): void
  /** Mark one stop released (no-op when it already is). */
  release(companyId: string, stopId: string, at: string, by: string): void
  /** The member's app follows the stop (upsert). */
  seen(companyId: string, userId: string, clientVersion: string | null, at: string): void
  clients(companyId: string): Map<string, AgentStopClientRow>
}
