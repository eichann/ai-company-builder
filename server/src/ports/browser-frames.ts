/**
 * Writes within frames (agent-browser.md "Writes within frames"): a run's frames and the writes permitted, from the
 * company handle (`CompanyData`) — every method limited to that company. The rules (which move is allowed when) are
 * services/browser-frames.ts alone; the table's CHECKs and triggers (db/schema/browser-frames.ts) are the second layer.
 */
export type FrameRunState = 'waiting' | 'open' | 'locked' | 'ended'
export type FrameWriteState = 'permitted' | 'done' | 'verified' | 'not_sent' | 'unknown'

export interface FrameRunRow {
  id: string
  userId: string
  host: string
  deviceId: string | null
  conversationId: string | null
  source: 'skill' | 'adhoc'
  skill: string | null
  declarationHash: string | null
  files: string | null
  planHash: string
  state: FrameRunState
  approval: 'card' | 'pre_approved' | null
  approvedAt: string | null
  endReason: string | null
  createdAt: string
  expiresAt: string
  endedAt: string | null
}

export interface FrameRow {
  idx: number
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  /** Canonical JSON of the fixed body fields. */
  fields: string
  max: number
  used: number
}

export interface FrameWriteRow {
  seq: number
  frameIdx: number
  state: FrameWriteState
  reason: string | null
  permittedAt: string
  permittedMonoMs: number | null
  permittedBoot: string | null
  settledAt: string | null
}

export interface BrowserFrameRepository {
  run(runId: string): FrameRunRow | null
  /** The run not ended on this domain, if any (at most one: a unique index). */
  liveRunOn(host: string): FrameRunRow | null
  /** The member's runs not ended, or ended with a write still `permitted` (leaving settles them). */
  unsettledRunsOf(userId: string): FrameRunRow[]
  insertRun(run: FrameRunRow, frames: Array<Omit<FrameRow, 'used'>>): void
  frames(runId: string): FrameRow[]
  writes(runId: string): FrameWriteRow[]
  /** Compare-and-set of the run's state (and what moves with it); false when the state was not `from`. */
  setRunState(runId: string, from: FrameRunState, to: FrameRunState, change: { approval?: 'card' | 'pre_approved'; approvedAt?: string; endReason?: string; endedAt?: string }): boolean
  /** One more unit of the frame, only while `used < max`; false when used up. */
  takeUnit(runId: string, idx: number): boolean
  insertWrite(runId: string, write: Omit<FrameWriteRow, 'settledAt' | 'reason'>): void
  /** Compare-and-set of a write's state; false when it was not `from`. */
  setWriteState(runId: string, seq: number, from: FrameWriteState, to: FrameWriteState, change: { settledAt: string; reason?: string | null }): boolean
}
