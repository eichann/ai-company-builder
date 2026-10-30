// The company folder's .env (API keys for skills): its format, and what the
// renderer may learn about it. Every value is treated as a secret — the
// settings screen offers no non-secret .env entries — so the renderer sees per
// name only whether it is set and, for a long enough value, its last four
// characters (same shape as config:getApiKeyStatus). Pure: used by main
// (features/env/ipc.ts) and the renderer (parsing pasted KEY=value lines).

/** One .env entry as the renderer sees it: never its value. */
export interface EnvVarStatus {
  set: boolean
  /** The value's last four characters, to recognise it; only for values of MIN_LENGTH_FOR_LAST4 or more. */
  last4?: string
}

/** Shorter values would be (nearly) given away by their last four characters. */
export const MIN_LENGTH_FOR_LAST4 = 12

/** A name a shell and dotenv libraries accept. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type Entry = { key: string; value: string }

function parseLine(line: string): Entry | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const eqIndex = trimmed.indexOf('=')
  if (eqIndex <= 0) return null
  const key = trimmed.slice(0, eqIndex).trim()
  let value = trimmed.slice(eqIndex + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
    value = value.slice(1, -1)
  }
  return { key, value }
}

/** KEY=value lines (comments and blank lines skipped, surrounding quotes removed); a later line wins. */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const entry = parseLine(line)
    if (entry) result[entry.key] = entry.value
  }
  return result
}

export function envVarStatus(value: string): EnvVarStatus {
  if (value === '') return { set: false }
  return value.length >= MIN_LENGTH_FOR_LAST4 ? { set: true, last4: value.slice(-4) } : { set: true }
}

export function envStatus(content: string): Record<string, EnvVarStatus> {
  const vars = parseEnvFile(content)
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, envVarStatus(value)]))
}

function formatLine(key: string, value: string): string {
  if (!/[\s#="']/.test(value)) return `${key}=${value}`
  return value.includes('"') && !value.includes("'") ? `${key}='${value}'` : `${key}="${value}"`
}

/** Why a change cannot be written, in Japanese for the member; null when it can. */
export function envChangeRefusal(changes: Record<string, string | null>): string | null {
  for (const [key, value] of Object.entries(changes)) {
    if (!ENV_NAME.test(key)) return `「${key}」は名前に使えません。半角英数字と _ で、数字以外から始めてください。`
    if (value !== null && typeof value !== 'string') return `「${key}」の値を読み取れませんでした。`
    if (value !== null && /[\r\n]/.test(value)) return `「${key}」の値に改行は使えません。`
  }
  return null
}

/**
 * The .env text with `changes` applied: a string sets or replaces that name
 * (empty = remove), null removes it. Other lines, comments included, stay as they are.
 */
export function applyEnvChanges(content: string, changes: Record<string, string | null>): string {
  const pending = new Map(Object.entries(changes))
  const written = new Set<string>()
  const out: string[] = []
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n')
  for (const line of lines) {
    const entry = parseLine(line)
    if (!entry || !pending.has(entry.key)) { out.push(line); continue }
    const value = pending.get(entry.key)
    if (value && !written.has(entry.key)) {
      out.push(formatLine(entry.key, value))
      written.add(entry.key)
    }
  }
  for (const [key, value] of pending) {
    if (value && !written.has(key)) out.push(formatLine(key, value))
  }
  return out.length > 0 ? out.join('\n') + '\n' : ''
}
