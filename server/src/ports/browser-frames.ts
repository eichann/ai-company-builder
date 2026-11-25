/**
 * Writes within frames (agent-browser.md "Writes within frames"): a run's frames and the writes permitted, from the
 * company handle (`CompanyData`) — every method limited to that company. The rules (which move is allowed when) are
 * services/browser-frames.ts alone; the table's CHECKs and triggers (db/schema/browser-frames.ts) are the second layer.
 */
export type FrameRunState = 'waiting' | 'open' | 'locked' | 'ended'
export type FrameWriteState = 'permitted' | 'done' | 'verified' | 'not_sent' | 'unknown' | 'refused'

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
  /** A Skill run: the approval row (`browser_skill_approvals.seq`) it started on; any other row since ends it. */
  approvalSeq: number | null
  planHash: string
  /** sha256 of the card's one-time approval value (null when the run opened without a card). */
  approvalTokenHash: string | null
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

/** The person's answer about a write in doubt (「済んでいた」 / 「されていなかった」), who and when; kept as given. */
export interface FrameWriteConfirmRow {
  seq: number
  answer: 'done' | 'not_done'
  confirmedBy: string
  confirmedAt: string
}

export interface BrowserFrameRepository {
  run(runId: string): FrameRunRow | null
  /** The run not ended on this domain, if any (at most one: a unique index). */
  liveRunOn(host: string): FrameRunRow | null
  /** The member's runs not ended, or ended with a write still `permitted` (leaving settles them). */
  unsettledRunsOf(userId: string): FrameRunRow[]
  /** Runs on this domain (ended ones included) with a write still `permitted`. */
  runsInFlightOn(host: string): FrameRunRow[]
  insertRun(run: FrameRunRow, frames: Array<Omit<FrameRow, 'used'>>): void
  frames(runId: string): FrameRow[]
  writes(runId: string): FrameWriteRow[]
  /** Compare-and-set of the run's state (and what moves with it); false when the state was not `from`. */
  setRunState(runId: string, from: FrameRunState, to: FrameRunState, change: { approval?: 'card' | 'pre_approved'; approvedAt?: string; endReason?: string; endedAt?: string }): boolean
  /** One more unit of the frame, only while `used < max`; false when used up. */
  takeUnit(runId: string, idx: number): boolean
  insertWrite(runId: string, write: Omit<FrameWriteRow, 'settledAt' | 'reason'>): void
  /** The person's answers about this run's writes in doubt. */
  confirms(runId: string): FrameWriteConfirmRow[]
  /** The person's answer, once per write (false when one is there already: the primary key). */
  insertConfirm(runId: string, row: FrameWriteConfirmRow): boolean
  /** Compare-and-set of a write's state; false when it was not `from`. */
  setWriteState(runId: string, seq: number, from: FrameWriteState, to: FrameWriteState, change: { settledAt: string; reason?: string | null }): boolean
}
