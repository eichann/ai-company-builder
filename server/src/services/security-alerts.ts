/**
 * 「気になる動き」 (`.claude/rules/security-alerts.md`): suspicious activity an owner / admin
 * should notice fast, found on top of records the server already keeps.
 *
 * - **The server clock's sweep** (every 5 minutes, per company through its handle): bulk
 *   downloads (the per-member hourly byte counter git-http feeds), many refused pushes to many
 *   places (push_rejections), a burst of contract-3 reads above the member's own normal
 *   (plugin_access_log) or many reads refused by the pace (plugin_call_paced), key use far above
 *   the member's normal (broker_usage), and security-relevant changes: someone made owner /
 *   admin (memberships), a company key added (broker_keys), 「全員が直せる」 turned on
 *   (skill_editing_settings), an internal-host exception added (broker_history).
 * - **Sign-in** (app.ts, the Better Auth route): wrong passwords counted per account in memory
 *   for 15 minutes; many in a row, or a success right after several, writes an alert for every
 *   company the account belongs to. An address that is no account is not counted.
 *
 * Thresholds are deliberately high (the owner dislikes noise) and every rule compares with the
 * member's own normal where there is one. Each alert is written once (`dedupe_key`), so a second
 * sweep or a restart adds nothing. Only counts and fixed words are stored; the Japanese text is
 * built when read — never a path, file, folder (private folders included) or secret.
 *
 * Delivery: the admin console (home and the 「気になる動き」 page, owner / admin only) and, when
 * the company turns it on (off by default), one Slack DM per owner / admin per sweep through the
 * notices' existing DM (`sendNoticeDm`).
 */
import { SECURITY_ALERT_KINDS, type SecurityAlertKind, type SecurityAlertSettings, type SecurityAlertView, type SecurityAlertsView } from '../../shared/types/security-alerts'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { SecurityAlertRepository, StoredSecurityAlert } from '../ports/security-alerts'
import { hasFullAccess, requireFullAccess, type Member } from './access'
import { companyNow } from './notifications'
import { ok, refuse, type Outcome } from './outcome'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const GIB = 1024 ** 3

/** The rules' thresholds (security-alerts.md). Conservative on purpose. */
export const SECURITY_ALERT_RULES = Object.freeze({
  signIn: { windowMs: 15 * MINUTE, failures: 10, failuresBeforeSuccess: 5, trackedAccounts: 10_000 },
  download: { windowMs: DAY, floorBytes: GIB, times: 10, baselineDays: 14, historyDays: 7 },
  push: { windowMs: HOUR, rejections: 10, places: 10, rowsPerMember: 200 },
  pluginReads: { windowMs: HOUR, floor: 300, times: 10, baselineDays: 7 },
  pluginPaced: { hours: 2, refused: 100 },
  keyUse: { floor: 2000, times: 5, baselineDays: 7 },
  /** Changes made within this long before a sweep are reported (a server down for a while still reports them). */
  changesLookbackMs: DAY,
  keepDays: 90,
  downloadKeepDays: 30,
  /** Alerts the delivery step looks at per company and sweep. */
  deliverPerSweep: 50,
})

export const SECURITY_ALERTS_FORBIDDEN = 'Only owners and admins can view the alerts'
const LIST_DAYS = 30
const LIST_LIMIT = 100
const HOME_DAYS = 7
const HOME_LIMIT = 5

export interface SecurityAlertDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  /** The relay's day (YYYY-MM-DD) of an instant: broker_usage's days. */
  brokerDay: (ms: number) => string
  timeZoneOf: (companyId: string) => string
  /** The account with this e-mail address (null: none). */
  userIdOfEmail: (email: string) => string | null
  /** The companies an account belongs to. */
  companiesOf: (userId: string) => string[]
  /** The notices' Slack DM (slack-connector.md "Notice DMs"); absent: no Slack. */
  sendDm?: (companyId: string, userId: string, text: string) => Promise<{ ok: boolean }>
  log?: Pick<Console, 'warn'>
}

type Facts = Record<string, number | string | boolean>

function parseFacts(json: string): Facts {
  try {
    const v: unknown = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Facts) : {}
  } catch {
    return {}
  }
}

const num = (f: Facts, k: string) => (typeof f[k] === 'number' ? (f[k] as number) : 0)

function size(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)}GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`
}

const ROLE_WORDS: Record<string, string> = { owner: 'オーナー', admin: '管理者' }
const ASK = '本人に何をしていたか聞いてください。'
const CHECK_CHANGE = '決めたとおりの変更か確かめてください。'

/** The words of an alert (plain Japanese; built when read, from counts only). */
export function alertWords(kind: SecurityAlertKind, facts: Facts, name: string): { title: string; detail: string; action: string } {
  switch (kind) {
    case 'sign_in_failures':
      return {
        title: `${name}さんのアカウントで、パスワードの間違いが続きました`,
        detail: `15分の間に${num(facts, 'failures')}回、間違ったパスワードでサインインしようとしました。本人でなければ、誰かがパスワードを当てようとしている可能性があります。`,
        action: '本人に心当たりがあるか聞いてください。心当たりがなければ、パスワードを変えてもらってください。',
      }
    case 'sign_in_after_failures':
      return {
        title: `${name}さんのアカウントに、パスワードの間違いが続いたあとでサインインがありました`,
        detail: `15分の間に${num(facts, 'failures')}回間違えたあと、サインインに成功しています。`,
        action: '本人がサインインしたか確かめてください。本人でなければ、すぐにメンバーの画面でこの人を会社から外し、パスワードを変えてもらってから招き直してください。',
      }
    case 'bulk_download': {
      const usual = num(facts, 'usualBytes')
      return {
        title: `${name}さんが、ふだんよりずっと多くの会社のファイルを受け取りました`,
        detail: `この24時間に${size(num(facts, 'bytes'))}（${usual > 0 ? `ふだんは1日${size(usual)}ほど` : 'ふだんはほとんどありません'}）。${facts.night === true ? '多くは深夜（0〜5時）でした。' : ''}`,
        action: '新しいパソコンに入れ直したなど、心当たりがあるか本人に聞いてください。心当たりがなければ、メンバーの画面でこの人を会社から外すことを考えてください。',
      }
    }
    case 'push_probing':
      return {
        title: `${name}さんの変更が、この1時間に何度も止められました`,
        detail: `書き込めない場所への変更が${num(facts, 'count')}回止められました（${num(facts, 'places')}か所）。書き込めない場所を次々に試している可能性があります。`,
        action: `${ASK}止められた場所は「詳しい設定 › 会社の情報 › 組み込みのルールと止められた同期」で見られます。`,
      }
    case 'plugin_reads':
      return {
        title: `${name}さんの AI が、つなぎ先からふだんよりずっと多く読みました`,
        detail: `この1時間に${num(facts, 'count')}回（ふだんは1時間に${num(facts, 'usualPerHour')}回ほど）。`,
        action: `${ASK}止めるときは、どのページの上にもある［AI を止める］からこの人の AI を止められます。`,
      }
    case 'plugin_paced':
      return {
        title: `${name}さんの AI が、つなぎ先を読みすぎて何度も止められています`,
        detail: `この2時間に${num(facts, 'count')}回、読む回数の上限で止められました。AI が同じことを繰り返している可能性があります。`,
        action: `${ASK}止めるときは、どのページの上にもある［AI を止める］からこの人の AI を止められます。`,
      }
    case 'key_use':
      return {
        title: `${name}さんの API キーの使用が、ふだんよりずっと多くなっています`,
        detail: `今日${num(facts, 'requests')}回（${num(facts, 'usualPerDay') > 0 ? `ふだんは1日${num(facts, 'usualPerDay')}回ほど` : 'ふだんはほとんど使っていません'}）。`,
        action: `${ASK}止めるときは、［AI を止める］からすべての鍵を止められます。`,
      }
    case 'role_raised': {
      const role = ROLE_WORDS[String(facts.role)] ?? '管理者'
      return {
        title: `${name}さんが${role}になりました`,
        detail: `${role}は会社のすべてのフォルダを読み書きでき、設定も変えられます。`,
        action: `${CHECK_CHANGE}覚えのない変更なら、メンバーの画面で役割を戻してください。`,
      }
    }
    case 'company_key_added':
      return {
        title: `会社の API キーが追加されました（${String(facts.service ?? '')}）`,
        detail: `${name}さんが追加しました。会社の AI がこの鍵でつなぎ先を使えるようになります。`,
        action: `${CHECK_CHANGE}覚えがなければ「詳しい設定 › AI の安全 › API キー」で止めてください。`,
      }
    case 'skill_editing_opened':
      return {
        title: '「Skill を直せる人」が「全員が直せる」になりました',
        detail: `${name}さんが変えました。書き込める人なら誰でも、AI の手順（Skill）を変えられます。`,
        action: `${CHECK_CHANGE}覚えがなければ「フォルダ」の画面で元に戻してください。`,
      }
    case 'internal_hosts_added':
      return {
        title: '社内の宛先へつなぐ例外が追加されました',
        detail: `${name}さんが${num(facts, 'added')}件追加しました。AI が社内のサーバーに届くようになります。`,
        action: `${CHECK_CHANGE}覚えがなければ「詳しい設定 › AI の安全 › API キー」で外してください。`,
      }
  }
}

const isKind = (k: string): k is SecurityAlertKind => (SECURITY_ALERT_KINDS as readonly string[]).includes(k)

export function createSecurityAlertService(deps: SecurityAlertDeps) {
  const { companyData, memberships, accounts, clock, ids } = deps
  const rules = SECURITY_ALERT_RULES
  const log = deps.log ?? console
  const repo = (companyId: string): SecurityAlertRepository => companyData.forCompany(companyId).securityAlerts
  /** Wrong passwords per account (instants), the last 15 minutes. Memory only: a restart forgets them. */
  const failures = new Map<string, number[]>()

  const iso = (ms: number) => new Date(ms).toISOString()
  const hourOf = (ms: number) => iso(ms).slice(0, 13)

  function write(companyId: string, kind: SecurityAlertKind, userId: string | null, facts: Facts, dedupeKey: string, at?: string): boolean {
    return repo(companyId).insert({ id: ids.newId(), kind, userId, facts: JSON.stringify(facts), dedupeKey: `${kind}:${dedupeKey}`, createdAt: at ?? clock.now() })
  }

  /** Company day (YYYY-MM-DD) of now: per-member-per-day alerts are written once a day. */
  const today = (companyId: string, nowMs: number) => companyNow(nowMs, deps.timeZoneOf(companyId)).slice(0, 10)

  function bulkDownloads(companyId: string, nowMs: number): number {
    const r = rules.download
    const repoOf = repo(companyId)
    const from = hourOf(nowMs - r.windowMs)
    let written = 0
    for (const d of repoOf.downloadsSince(from)) {
      if (d.bytes < r.floorBytes) continue
      // A member's first download (a new member, the app set up) is not compared with nothing.
      const first = repoOf.firstDownloadHour(d.userId)
      if (!first || first > hourOf(nowMs - r.historyDays * DAY)) continue
      const before = repoOf.downloadHours(d.userId, hourOf(nowMs - r.windowMs - r.baselineDays * DAY), from)
      const usual = before.reduce((s, h) => s + h.bytes, 0) / r.baselineDays
      if (d.bytes < r.times * usual) continue
      const zone = deps.timeZoneOf(companyId)
      const recent = repoOf.downloadHours(d.userId, from, hourOf(nowMs + HOUR))
      const nightBytes = recent.filter(h => Number(companyNow(Date.parse(`${h.hour}:00:00Z`), zone).slice(11, 13)) < 5).reduce((s, h) => s + h.bytes, 0)
      if (write(companyId, 'bulk_download', d.userId, { bytes: d.bytes, usualBytes: Math.round(usual), night: nightBytes * 2 >= d.bytes }, `${d.userId}:${today(companyId, nowMs)}`)) written++
    }
    return written
  }

  function pushProbing(companyId: string, nowMs: number): number {
    const r = rules.push
    let written = 0
    for (const p of repo(companyId).pushRejectionsSince(iso(nowMs - r.windowMs), r.rowsPerMember)) {
      if (p.count < r.rejections) continue
      // Many places, not the same refused change retried: a stuck sync retries the same paths.
      const places = new Set(p.paths).size
      if (places < r.places) continue
      if (write(companyId, 'push_probing', p.userId, { count: p.count, places }, `${p.userId}:${today(companyId, nowMs)}`)) written++
    }
    return written
  }

  function pluginReads(companyId: string, nowMs: number): number {
    const r = rules.pluginReads
    const repoOf = repo(companyId)
    const from = iso(nowMs - r.windowMs)
    let written = 0
    for (const p of repoOf.pluginReads(from, iso(nowMs + MINUTE))) {
      if (p.count < r.floor) continue
      const usualPerHour = repoOf.pluginReadsOf(p.userId, iso(nowMs - r.windowMs - r.baselineDays * DAY), from) / (r.baselineDays * 24)
      if (p.count < r.times * usualPerHour) continue
      if (write(companyId, 'plugin_reads', p.userId, { count: p.count, usualPerHour: Math.round(usualPerHour) }, `${p.userId}:${today(companyId, nowMs)}`)) written++
    }
    for (const p of repoOf.pluginPacedSince(hourOf(nowMs - (rules.pluginPaced.hours - 1) * HOUR))) {
      if (p.count < rules.pluginPaced.refused) continue
      if (write(companyId, 'plugin_paced', p.userId, { count: p.count }, `${p.userId}:${today(companyId, nowMs)}`)) written++
    }
    return written
  }

  function keyUse(companyId: string, nowMs: number): number {
    const r = rules.keyUse
    const day = deps.brokerDay(nowMs)
    const rows = repo(companyId).keyRequests(deps.brokerDay(nowMs - r.baselineDays * DAY), day)
    const usual = new Map<string, number>()
    for (const row of rows) if (row.day !== day) usual.set(row.userId, (usual.get(row.userId) ?? 0) + row.requests)
    let written = 0
    for (const row of rows) {
      if (row.day !== day || row.requests < r.floor) continue
      const usualPerDay = (usual.get(row.userId) ?? 0) / r.baselineDays
      if (row.requests < r.times * usualPerDay) continue
      if (write(companyId, 'key_use', row.userId, { requests: row.requests, usualPerDay: Math.round(usualPerDay) }, `${row.userId}:${day}`)) written++
    }
    return written
  }

  function changes(companyId: string, nowMs: number): number {
    const repoOf = repo(companyId)
    const since = iso(nowMs - rules.changesLookbackMs)
    let written = 0
    for (const c of repoOf.raisedRoles(since)) {
      if (write(companyId, 'role_raised', c.userId, { role: c.role }, `${c.userId}:${c.role}:${c.at}`, c.at)) written++
    }
    for (const k of repoOf.companyKeysSince(since)) {
      if (write(companyId, 'company_key_added', k.by, { service: k.service.slice(0, 40) }, k.id, k.at)) written++
    }
    const opened = repoOf.skillEditingOpenedSince(since)
    if (opened && write(companyId, 'skill_editing_opened', opened.by, {}, opened.at, opened.at)) written++
    for (const h of repoOf.internalHostsAddedSince(since)) {
      if (write(companyId, 'internal_hosts_added', h.by, { added: h.added }, h.id, h.at)) written++
    }
    return written
  }

  function namesOf(rows: StoredSecurityAlert[]): Map<string, string> {
    const users = accounts.byIds([...new Set(rows.map(r => r.userId).filter((u): u is string => !!u))])
    return new Map([...users].map(([id, a]) => [id, a.name || a.email]))
  }

  function views(rows: StoredSecurityAlert[]): SecurityAlertView[] {
    const names = namesOf(rows)
    return rows.filter(r => isKind(r.kind)).map(r => {
      const name = r.userId ? names.get(r.userId) ?? null : null
      const words = alertWords(r.kind as SecurityAlertKind, parseFacts(r.facts), name ?? '（会社にいない人）')
      return { id: r.id, kind: r.kind as SecurityAlertKind, ...words, userId: r.userId, name, createdAt: r.createdAt }
    })
  }

  function settingsOf(companyId: string): SecurityAlertSettings {
    const s = repo(companyId).settings()
    return { slackDm: s?.slackDm ?? false, updatedAt: s?.updatedAt ?? null }
  }

  /** New alerts to owners / admins by Slack DM when the company turned it on; marked looked-at either way. */
  async function deliver(companyId: string): Promise<void> {
    const repoOf = repo(companyId)
    const fresh = repoOf.undelivered(rules.deliverPerSweep)
    if (fresh.length === 0) return
    repoOf.markDelivered(fresh.map(a => a.id), clock.now())
    if (!deps.sendDm || !settingsOf(companyId).slackDm) return
    const first = views(fresh)[0]
    if (!first) return
    const text = fresh.length === 1
      ? `ACB：気になる動きがあります。${first.title}\n管理画面のホームで確かめてください。`
      : `ACB：気になる動きが${fresh.length}件あります（${first.title} ほか）。\n管理画面のホームで確かめてください。`
    for (const m of memberships.listByCompany(companyId)) {
      if (!hasFullAccess(m.role)) continue
      try {
        await deps.sendDm(companyId, m.user_id, text)
      } catch {
        log.warn('[security-alerts] a Slack DM could not be sent')
      }
    }
  }

  return {
    /**
     * The server clock's pass over one company: every rule, then delivery and pruning. Returns
     * the number of alerts written. Safe to run again (dedupe keys).
     */
    async sweep(companyId: string): Promise<number> {
      const nowMs = clock.nowMs()
      const written = bulkDownloads(companyId, nowMs) + pushProbing(companyId, nowMs) + pluginReads(companyId, nowMs) + keyUse(companyId, nowMs) + changes(companyId, nowMs)
      await deliver(companyId)
      repo(companyId).prune(iso(nowMs - rules.keepDays * DAY), hourOf(nowMs - rules.downloadKeepDays * DAY))
      return written
    },

    /** git-http: bytes the server sent a member from one of the company's repositories (fetch / clone). Never throws. */
    downloaded(companyId: string, userId: string, bytes: number): void {
      if (!(bytes > 0)) return
      try {
        repo(companyId).addDownload(userId, hourOf(clock.nowMs()), Math.round(bytes))
      } catch {
        log.warn('[security-alerts] a download could not be counted')
      }
    },

    /**
     * A password sign-in finished (app.ts). Wrong passwords are counted per account for 15
     * minutes; the 10th writes `sign_in_failures`, a success after 5 or more writes
     * `sign_in_after_failures` — for each company of the account. Never throws.
     */
    signInAttempt(email: string, succeeded: boolean): void {
      try {
        const userId = deps.userIdOfEmail(email)
        if (!userId) return
        const nowMs = clock.nowMs()
        const r = rules.signIn
        const recent = (failures.get(userId) ?? []).filter(t => t > nowMs - r.windowMs)
        failures.delete(userId)
        if (succeeded) {
          if (recent.length >= r.failuresBeforeSuccess) {
            for (const companyId of deps.companiesOf(userId)) write(companyId, 'sign_in_after_failures', userId, { failures: recent.length }, `${userId}:${hourOf(nowMs)}`)
          }
          return
        }
        recent.push(nowMs)
        failures.set(userId, recent)
        if (failures.size > r.trackedAccounts) failures.delete(failures.keys().next().value as string)
        if (recent.length >= r.failures) {
          for (const companyId of deps.companiesOf(userId)) write(companyId, 'sign_in_failures', userId, { failures: recent.length }, `${userId}:${hourOf(nowMs)}`)
        }
      } catch {
        log.warn('[security-alerts] a sign-in could not be checked')
      }
    },

    /** GET …/security-alerts (owner / admin): the last 30 days and the setting. */
    list(member: Member): Outcome<SecurityAlertsView> {
      const allowed = requireFullAccess(member, SECURITY_ALERTS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const rows = repo(member.companyId).recent(iso(clock.nowMs() - LIST_DAYS * DAY), LIST_LIMIT)
      return ok({ items: views(rows), settings: settingsOf(member.companyId) })
    },

    /** The admin home's 「気になる動き」: the last 7 days (owner / admin; anyone else nothing). */
    forHome(member: Member): SecurityAlertView[] {
      if (!hasFullAccess(member.role)) return []
      return views(repo(member.companyId).recent(iso(clock.nowMs() - HOME_DAYS * DAY), HOME_LIMIT))
    },

    /** PUT …/security-alerts/settings (owner / admin): `{ slackDm: boolean }`. */
    saveSettings(member: Member, body: unknown): Outcome<SecurityAlertSettings> {
      const allowed = requireFullAccess(member, SECURITY_ALERTS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const slackDm = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).slackDm : undefined
      if (typeof slackDm !== 'boolean') return refuse('bad-request', 'slackDm must be a boolean')
      repo(member.companyId).saveSettings(slackDm, clock.now(), member.userId)
      return ok(settingsOf(member.companyId))
    },
  }
}

export type SecurityAlertService = ReturnType<typeof createSecurityAlertService>
