/**
 * Business days (営業日) of a company, without a network call: weekends and
 * Japanese public holidays are off, and the company adds its own holidays
 * (dates). Dates are calendar dates in Japan, `YYYY-MM-DD`.
 *
 * Japanese public holidays are calculated from the rules of the current law
 * (国民の祝日に関する法律, as in force since 2022) rather than read from a
 * table, so they need no yearly update while the law stays as it is:
 *
 * - fixed dates (元日, 建国記念の日, 天皇誕生日, 昭和の日, 憲法記念日,
 *   みどりの日, こどもの日, 山の日, 文化の日, 勤労感謝の日);
 * - Mondays (成人の日 2nd Monday of January, 海の日 3rd of July, 敬老の日 3rd of
 *   September, スポーツの日 2nd of October);
 * - the equinoxes (春分の日, 秋分の日) by the usual astronomical approximation,
 *   valid 1980–2099 (the Cabinet Office announces each year's in February of
 *   the year before; they match through 2030, tests pin 2026–2030);
 * - 国民の休日: a day between two holidays that is not one itself;
 * - 振替休日: a holiday on a Sunday moves the day off to the next day that is
 *   not a holiday.
 *
 * Extending it: when the law changes a date for a year (as for the 2020 / 2021
 * Olympics), add that year's differences to `LAW_EXCEPTIONS` below (a date →
 * its name, or → null to remove one) and a test row with the published list.
 * When the rules change for good, change `holidaysOfYear` and keep the old
 * years' answers in the tests. `HOLIDAY_RULES_FROM`..`HOLIDAY_RULES_TO` is the
 * range the rules are written for; outside it they are still applied (an
 * estimate), never thrown on.
 *
 * Pure: imports nothing (server/tests/unit/core-purity.test.ts).
 */

export const HOLIDAY_RULES_FROM = 2022
export const HOLIDAY_RULES_TO = 2099

/** Year-specific changes made by law: date → name (added) or null (removed). Empty today. */
const LAW_EXCEPTIONS: Readonly<Record<string, string | null>> = {}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` of a real calendar date (no 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DATE_RE.exec(value)
  if (!m) return false
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** Day of the week of a calendar date, 0 = Sunday. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The calendar date `days` after `date` (negative: before). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** The n-th Monday (1-based) of a month. */
function nthMonday(year: number, month: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const firstMonday = 1 + ((8 - first) % 7)
  return ymd(year, month, firstMonday + 7 * (n - 1))
}

function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

const cache = new Map<number, ReadonlyMap<string, string>>()

/** Japan's public holidays of a year: date → name, in date order. */
export function japaneseHolidays(year: number): ReadonlyMap<string, string> {
  const hit = cache.get(year)
  if (hit) return hit
  const result = holidaysOfYear(year)
  cache.set(year, result)
  return result
}

function holidaysOfYear(year: number): ReadonlyMap<string, string> {
  const base = new Map<string, string>([
    [ymd(year, 1, 1), '元日'],
    [nthMonday(year, 1, 2), '成人の日'],
    [ymd(year, 2, 11), '建国記念の日'],
    [ymd(year, 2, 23), '天皇誕生日'],
    [ymd(year, 3, vernalEquinoxDay(year)), '春分の日'],
    [ymd(year, 4, 29), '昭和の日'],
    [ymd(year, 5, 3), '憲法記念日'],
    [ymd(year, 5, 4), 'みどりの日'],
    [ymd(year, 5, 5), 'こどもの日'],
    [nthMonday(year, 7, 3), '海の日'],
    [ymd(year, 8, 11), '山の日'],
    [nthMonday(year, 9, 3), '敬老の日'],
    [ymd(year, 9, autumnalEquinoxDay(year)), '秋分の日'],
    [nthMonday(year, 10, 2), 'スポーツの日'],
    [ymd(year, 11, 3), '文化の日'],
    [ymd(year, 11, 23), '勤労感謝の日'],
  ])
  for (const [date, name] of Object.entries(LAW_EXCEPTIONS)) {
    if (!date.startsWith(`${year}-`)) continue
    if (name === null) base.delete(date)
    else base.set(date, name)
  }
  const all = new Map(base)
  // 国民の休日: between two 国民の祝日 (only those, not 振替休日), not one itself.
  for (const date of base.keys()) {
    const between = addDays(date, 1)
    if (!base.has(between) && base.has(addDays(date, 2)) && dayOfWeek(between) !== 0) all.set(between, '国民の休日')
  }
  // 振替休日: a 国民の祝日 on a Sunday → the next day that is not a holiday.
  for (const date of base.keys()) {
    if (dayOfWeek(date) !== 0) continue
    let next = addDays(date, 1)
    while (all.has(next)) next = addDays(next, 1)
    all.set(next, '休日（振替休日）')
  }
  return new Map([...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** The name of the Japanese public holiday on `date`, or null. */
export function japaneseHolidayName(date: string): string | null {
  return japaneseHolidays(Number(date.slice(0, 4))).get(date) ?? null
}

/** Saturday, Sunday, a Japanese public holiday or one of the company's holidays → not a business day. */
export function isBusinessDay(date: string, companyHolidays: Iterable<string> = []): boolean {
  const dow = dayOfWeek(date)
  if (dow === 0 || dow === 6) return false
  if (japaneseHolidayName(date) !== null) return false
  for (const h of companyHolidays) if (h === date) return false
  return true
}

/** The first business day strictly after `date`. */
export function nextBusinessDay(date: string, companyHolidays: Iterable<string> = []): string {
  const own = new Set(companyHolidays)
  let next = addDays(date, 1)
  // A year has at most ~130 days off; 400 steps cannot be reached by valid input.
  for (let i = 0; i < 400 && !isBusinessDay(next, own); i++) next = addDays(next, 1)
  return next
}

/** The last business day strictly before `date`. */
export function previousBusinessDay(date: string, companyHolidays: Iterable<string> = []): string {
  const own = new Set(companyHolidays)
  let prev = addDays(date, -1)
  for (let i = 0; i < 400 && !isBusinessDay(prev, own); i++) prev = addDays(prev, -1)
  return prev
}

/** The business day `n` business days after `date` (n ≥ 1; 0 or less → `date`). */
export function addBusinessDays(date: string, n: number, companyHolidays: Iterable<string> = []): string {
  const own = new Set(companyHolidays)
  let at = date
  for (let i = 0; i < n; i++) at = nextBusinessDay(at, own)
  return at
}

/**
 * How many business days lie after `from` up to and including `to` (both `YYYY-MM-DD`): a wait
 * begun on a Tuesday and looked at on Saturday has lasted 3 (Wed, Thu, Fri). 0 when `to` is not
 * after `from`; counted up to 400 days.
 */
export function businessDaysBetween(from: string, to: string, companyHolidays: Iterable<string> = []): number {
  const own = new Set(companyHolidays)
  let n = 0
  let at = addDays(from, 1)
  for (let i = 0; i < 400 && at <= to; i++, at = addDays(at, 1)) if (isBusinessDay(at, own)) n++
  return n
}
