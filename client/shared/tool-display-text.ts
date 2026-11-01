// Generic: the text helpers a tool row's detail is built with (tool-display.ts). Pure.

export const DETAIL_MAX = 40

const SECRET_RE = /\b(?:sk|pk|rk|ghp|gho|xox[abpr]|AKIA|AIza|ya29)[-_.A-Za-z0-9]{8,}|[A-Za-z0-9+/_-]{32,}={0,2}|\b(?:bearer|token|password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi

/** One line, without anything that looks like a key or a token, at most `max` characters. */
export function shortText(value: unknown, max = DETAIL_MAX): string {
  if (typeof value !== 'string') return ''
  const line = value.replace(/\s+/g, ' ').trim().replace(SECRET_RE, '••••')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A path relative to the company folder; a path outside it shows only its file name. */
export function companyPath(value: unknown, root?: string): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const path = value.trim().replace(/\\/g, '/')
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) return path.replace(/^\.\//, '')
  return path.split('/').filter(Boolean).pop() ?? ''
}

/** How many items a list argument has (0 when it is not a list). */
export function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}
