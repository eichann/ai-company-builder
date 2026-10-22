/**
 * Extra instructions sent while the AI works ("steering"). The member types in
 * the chat input during a running turn; the app pushes the text into the
 * running agent session (Claude Code: streaming input; Codex: `turn/steer`),
 * which reads it at its next step boundary. Pure module shared by the main
 * process (chat server, agents) and the renderer (transcript, history).
 */

/** Transcript part injected into the running reply when the agent accepted the text. */
export const STEER_PART_TYPE = 'data-steer'
export const STEER_LABEL = '作業中に追加した指示'
/** Longer instructions are sent as a normal message after the turn instead. */
export const MAX_STEER_LENGTH = 20_000

export interface SteerRecord { id: string; text: string }

/**
 * How a steering send ended:
 * - `delivered`: the agent took it into the running turn.
 * - `not-delivered`: accepted at first, but the turn ended (or was stopped)
 *   before the agent read it — the renderer sends it as a normal message.
 * - `unavailable`: no running turn can take it (api-key mode, the turn has not
 *   started or already ended, an agent without steering) — sent after the turn.
 */
export type SteerStatus = 'delivered' | 'not-delivered' | 'unavailable'
export interface SteerResponse { status: SteerStatus; id?: string }

/** Text the app may push into a running turn (otherwise it waits for the turn to end). */
export function canSteerText(text: string): boolean {
  const value = text.trim()
  // Slash commands run as commands, not as text read mid-turn.
  return value.length > 0 && value.length <= MAX_STEER_LENGTH && !value.startsWith('/')
}

export function readSteerRecord(value: unknown): SteerRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, text } = value as Record<string, unknown>
  if (typeof id !== 'string' || !id || typeof text !== 'string' || !text) return undefined
  return { id, text }
}

/** The instruction as text, for another agent or a fresh session (agentInputMessages). */
export function steerAsText(record: SteerRecord): string {
  return `\n[${STEER_LABEL}]\n${record.text}\n`
}
