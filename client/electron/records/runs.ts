/**
 * Which consultation runs which execution run (stage 2 S10b, records.md
 * "Execution runs"), main process. The AI-turn claims (features/ai-turns)
 * put a run here when the server gave it to this app instance and take it
 * out when it ends; the records API (records/api.ts) binds every record token
 * of that consultation to the run, so the server refuses its calls as soon as
 * another PC has claimed the run again.
 */

export interface BoundRun {
  id: string
  generation: number
}

export interface RunRegistry {
  runOf(companyId: string, conversationId: string): BoundRun | null
  set(companyId: string, conversationId: string, run: BoundRun): void
  clear(companyId: string, conversationId: string): void
}

export function createRunRegistry(): RunRegistry {
  const runs = new Map<string, BoundRun>()
  const key = (companyId: string, conversationId: string) => `${companyId}\n${conversationId}`
  return {
    runOf: (companyId, conversationId) => runs.get(key(companyId, conversationId)) ?? null,
    set: (companyId, conversationId, run) => { runs.set(key(companyId, conversationId), run) },
    clear: (companyId, conversationId) => { runs.delete(key(companyId, conversationId)) },
  }
}
