import type { ClientBuild, Role } from './api'

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'オーナー',
  admin: '管理者',
  member: 'メンバー',
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as Role] ?? role
}

export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" in UTC without a zone;
 * JavaScript would read that as local time. Treat zone-less values as UTC.
 */
export function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) return null
  let s = value.trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "たった今" / "5分前" / "3時間前" / "2日前" / "2026/9/1" */
export function formatRelative(value: string | null | undefined, now: Date = new Date()): string {
  const d = parseServerDate(value)
  if (!d) return '—'
  const sec = Math.round((now.getTime() - d.getTime()) / 1000)
  if (sec < 60) return 'たった今'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}時間前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day}日前`
  return formatDate(value)
}

export function formatDate(value: string | null | undefined): string {
  const d = parseServerDate(value)
  if (!d) return '—'
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

export function formatDateTime(value: string | null | undefined): string {
  const d = parseServerDate(value)
  if (!d) return '—'
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Most recent of the given timestamps (e.g. last fetch vs. last push). */
export function latest(...values: Array<string | null | undefined>): string | null {
  let best: { raw: string; t: number } | null = null
  for (const v of values) {
    const d = parseServerDate(v)
    if (d && (!best || d.getTime() > best.t)) best = { raw: v as string, t: d.getTime() }
  }
  return best?.raw ?? null
}

/**
 * A desktop-app build in words a non-engineer can compare:
 * "0.0.1（2026/10/21 版）", "開発版 0.0.1（…）".
 */
export function formatBuild(build: ClientBuild | null | undefined, raw?: string | null): string {
  if (!build) return raw ? raw : '—'
  const date = build.commitDate ? commitDateLabel(build.commitDate) : null
  const core = build.semver.replace(/-dev$/, '')
  const base = date ? `${core}（${date} 版）` : core
  return build.dev ? `開発版 ${base}` : base
}

/** Parses a raw "<semver>+<sha>.<YYYYMMDDHHmmss>" when no parsed build is at hand. */
export function parseBuild(raw: string | null | undefined): ClientBuild | null {
  if (!raw) return null
  const m = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+([0-9A-Za-z-]+)(?:\.(\d{14}))?)?$/.exec(raw.trim())
  if (!m) return null
  const date = m[3] && !/^0+$/.test(m[3]) ? m[3] : null
  return {
    semver: m[1],
    sha: m[2] && m[2] !== 'nogit' ? m[2] : null,
    commitDate: date,
    dev: /-(.*\.)?dev(\.|$)/.test(m[1]),
  }
}

/**
 * Orders builds like the server (compareClientVersions in
 * server/src/lib/client-version.ts): semver core, then a release ranks above
 * a pre-release of the same core, then the commit date breaks ties.
 */
export function compareBuilds(a: ClientBuild, b: ClientBuild): number {
  const core = (s: string) => s.split('-')[0].split('.').map(Number)
  const [ac, bc] = [core(a.semver), core(b.semver)]
  for (let i = 0; i < 3; i++) {
    if (ac[i] !== bc[i]) return Math.sign(ac[i] - bc[i])
  }
  const [ap, bp] = [a.semver.includes('-'), b.semver.includes('-')]
  if (ap !== bp) return ap ? -1 : 1
  const [ad, bd] = [a.commitDate ?? '', b.commitDate ?? '']
  return ad < bd ? -1 : ad > bd ? 1 : 0
}

function commitDateLabel(d: string): string {
  return `${d.slice(0, 4)}/${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}`
}
