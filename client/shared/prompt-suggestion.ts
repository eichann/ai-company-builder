/**
 * Next-prompt suggestions: after a reply ACB predicts what the member will
 * type next (electron/prompt-suggester.ts, one short Sonnet call, or nothing).
 * The renderer shows it as ghost text in the chat input.
 */

export const MAX_SUGGESTION_LENGTH = 200
/** How long the chat server waits for the turn to finish once the renderer asked. */
export const SUGGESTION_WAIT_MS = 15_000

/** The first non-empty line, trimmed; empty, overlong or not text → null (nothing is shown). */
export function normalizeSuggestion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const line = value.split(/\r?\n/).map(part => part.trim()).find(Boolean)
  if (!line) return null
  return line.length > MAX_SUGGESTION_LENGTH ? null : line
}
