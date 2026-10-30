// The settings' .env pages without React: what a saved entry shows, and which
// changes a save sends. Saved values never reach the renderer (env:status), so
// the screen only collects new values and removals.
import { ENV_NAME, parseEnvFile, type EnvVarStatus } from '../../../shared/env-file'

/** 「設定済み（末尾 ab12）」, 「設定済み」 or 「未設定」. */
export function envStatusLabel(status: EnvVarStatus | undefined): string {
  if (!status?.set) return '未設定'
  return status.last4 ? `設定済み（末尾 ${status.last4}）` : '設定済み'
}

/**
 * The changes a save sends: typed values (trimmed, blank ones ignored) set or
 * replace, removed names are cleared. A name both typed and removed is removed.
 */
export function envChangesToSave(drafts: Record<string, string>, removed: Iterable<string>): Record<string, string | null> {
  const changes: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(drafts)) {
    if (value.trim()) changes[key] = value.trim()
  }
  for (const key of removed) changes[key] = null
  return changes
}

/** Pasted KEY=value lines as values to set; lines without a value are skipped (removal is a button). */
export function envDraftsFromText(text: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parseEnvFile(text)).filter(([, value]) => value.trim() !== ''))
}

/** A typed name as an .env name (upper case, other characters → _), or an error for the member. */
export function normalizeEnvName(input: string): { name: string } | { error: string } {
  const name = input.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  if (!ENV_NAME.test(name)) return { error: 'キー名は半角英数字と _ で、数字以外から始めてください' }
  return { name }
}
