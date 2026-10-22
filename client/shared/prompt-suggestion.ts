/**
 * Next-prompt suggestions (Claude Code `promptSuggestions`): after a reply the
 * CLI predicts what the member will type next (2–12 words, or nothing). The
 * renderer shows it as ghost text in the chat input.
 */

export const MAX_SUGGESTION_LENGTH = 200
/** How long the renderer waits for a suggestion after a reply finished. */
export const SUGGESTION_WAIT_MS = 15_000

/** The first non-empty line, trimmed; empty, overlong or not text → null (nothing is shown). */
export function normalizeSuggestion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const line = value.split(/\r?\n/).map(part => part.trim()).find(Boolean)
  if (!line) return null
  return line.length > MAX_SUGGESTION_LENGTH ? null : line
}
