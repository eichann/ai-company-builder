// The list's one line (tasks-ui.md): 「見積を直す 明日15時まで #営業」 → a title, a due with or
// without a time, and tags. Words for the day are read in company time; anything not
// understood stays in the title, so nothing the member typed is lost.
import { addDays, type CompanyNow } from './model'

export interface QuickAddDraft {
  title: string
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`. */
  due: string | null
  tags: string[]
}

const TAG_RE = /[#＃]([^\s#＃]+)/g
const WEEKDAY_WORDS = ['日', '月', '火', '水', '木', '金', '土']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function parseQuickAdd(line: string, now: CompanyNow): QuickAddDraft {
  const tags = [...new Set([...line.matchAll(TAG_RE)].map(m => m[1].normalize('NFC')))]
  let rest = line.replace(TAG_RE, ' ').normalize('NFKC')
  const found: { day: string | null } = { day: null }
  const take = (re: RegExp, f: (m: RegExpExecArray) => string | null) => {
    const m = re.exec(rest)
    if (!m) return
    const d = f(m)
    if (d) { found.day = d; rest = rest.replace(m[0], ' ') }
  }
  take(/今日(中)?/, () => now.date)
  if (!found.day) take(/明日|あした/, () => addDays(now.date, 1))
  if (!found.day) take(/明後日|あさって/, () => addDays(now.date, 2))
  if (!found.day) take(/来週(の)?(月|火|水|木|金|土|日)?(曜日?)?/, m => {
    const target = m[2] ? WEEKDAY_WORDS.indexOf(m[2]) : 1
    const toMonday = ((8 - now.weekday) % 7) || 7
    return addDays(now.date, toMonday + ((target + 6) % 7))
  })
  if (!found.day) take(/(月|火|水|木|金|土|日)曜日?/, m => {
    const ahead = (WEEKDAY_WORDS.indexOf(m[1]) - now.weekday + 7) % 7
    return addDays(now.date, ahead === 0 ? 7 : ahead)
  })
  if (!found.day) take(/(\d{1,2})[/月](\d{1,2})日?/, m => {
    const month = Number(m[1])
    const date = Number(m[2])
    if (month < 1 || month > 12 || date < 1 || date > 31) return null
    let year = Number(now.date.slice(0, 4))
    if (`${year}-${pad(month)}-${pad(date)}` < now.date) year += 1
    return `${year}-${pad(month)}-${pad(date)}`
  })
  let time: string | null = null
  const t = /(\d{1,2})(?::(\d{2})|時(半)?(?:(\d{1,2})分)?)/.exec(rest)
  if (t) {
    const h = Number(t[1])
    const min = t[2] !== undefined ? Number(t[2]) : t[3] ? 30 : t[4] !== undefined ? Number(t[4]) : 0
    if (h <= 23 && min <= 59) { time = `${pad(h)}:${pad(min)}`; rest = rest.replace(t[0], ' ') }
  }
  if (time && !found.day) found.day = now.date
  rest = rest.replace(/(^|\s)(までに|まで|中)(?=\s|$)/g, ' ')
  const title = rest.replace(/\s+/g, ' ').trim()
  const day = found.day
  return { title, due: day ? (time ? `${day}T${time}` : day) : null, tags }
}

/** A tag folded for comparison: width, letter case and katakana / hiragana do not count. */
function tagKey(tag: string): string {
  return tag.normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

/**
 * The tag already in use that `typed` most likely means (only spelled differently: 「えいぎょう」
 * vs 「営業」 is not caught, 「ｴｲｷﾞｮｳ」 vs 「エイギョウ」 is). null when it is in use as typed or
 * nothing is close.
 */
export function similarTag(typed: string, inUse: readonly string[]): string | null {
  if (inUse.includes(typed)) return null
  const key = tagKey(typed)
  return inUse.find(t => tagKey(t) === key) ?? null
}

/** Tags in use that start like what is being typed after the last 「#」 (empty: the most used). */
export function tagChoices(line: string, inUse: readonly string[]): string[] | null {
  const m = /[#＃]([^\s#＃]*)$/.exec(line)
  if (!m) return null
  const key = tagKey(m[1])
  return inUse.filter(t => t !== m[1] && tagKey(t).startsWith(key)).slice(0, 6)
}
