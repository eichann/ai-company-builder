/**
 * The one generic card (「ひとつの汎用のカード」, generalization PR 3; `agent-browser.md` "The first map and the inspection
 * line"). Internal design memo §3-7, §16-1, §16-3, §16-4. Pure: the card's data shape and its builder. Nothing in the
 * renderer, main or the server uses it yet (the renderer's card and its IPC are a later PR).
 *
 * The card is built **only** from the map's words (things', fields' and the account's headings, the must-hold notes), the
 * line's words (title, read headings) and what main read (`evaluateBrowserReadLine`'s outcome and the reads' states).
 * Never the AI's word, never a key or page text beyond the read fields' values. Rules (each guarded by
 * `browser-card.test.ts`):
 * - **Unreadable is never ✓**: a check row is ✓ only when the outcome says `ok` **and** every read it names counted; a
 *   value not read is 「読み取れませんでした」, never 0, empty or a guess; the headline is "all held" only when the outcome
 *   has no problem.
 * - **Must-hold notes always show**: every note of a thing the line reads, whatever the line shows and however the read
 *   went — a line cannot drop them (§15 C5).
 * - **A changed site** (a read not whole) says the member's one sentence (`BROWSER_SHAPE_WORDS`), nothing about keys.
 * Rows carry either one value (a read: 点検) or a before / after pair (a write, later PRs) — the same shape for both.
 *
 * The core knows no site, thing or field. The shape is **provisional** until a second site fits it (§18).
 */
import { BROWSER_SHAPE_WORDS, isBrowserDate, type BrowserMap, type BrowserMapField, type BrowserMapThing, type BrowserThingResult } from './browser-map'
import type { BrowserCheck, BrowserCheckResult, BrowserReadFacts, BrowserReadLineOutcome } from './browser-read-line'
import type { BrowserOpenedLine } from './browser-opened'

/** A value on the card: read (its text), or not read — never a stand-in. */
export type BrowserCardValue = { status: 'read'; text: string } | { status: 'unreadable' }

/**
 * Who checked a row of a write's after-read card (redesign step ⑤b, design memo §6-1 step 5): the core comparing what was
 * read with what was sent (機械で確かめた), the operator AI reading the page (AI が確かめた), or nobody (確かめていない).
 */
export type BrowserCardCheckedBy = 'machine' | 'ai' | 'none'
export const BROWSER_CARD_CHECKED_BY_WORDS: Readonly<Record<BrowserCardCheckedBy, string>> = {
  machine: '機械で確かめた', ai: '係の AI が確かめた（機械ではない）', none: '確かめていない',
}

/**
 * A row: one value (a read), or what it was and what it is now (a write) — with, for a write's after-read card, what it is
 * compared to (比べ元), who checked it and, when someone did, whether it held (`ok`) or differs (`ng`).
 */
export type BrowserCardRow =
  | { label: string; value: BrowserCardValue }
  | { label: string; before: BrowserCardValue; after: BrowserCardValue; compared?: BrowserCardValue; by?: BrowserCardCheckedBy; mark?: 'ok' | 'ng' }

export interface BrowserCardSection { heading: string; rows: readonly BrowserCardRow[] }

/** A check's mark: ✓, ✗, could not be read, judged after the write. */
export type BrowserCardMark = 'ok' | 'ng' | 'unreadable' | 'later'
export const BROWSER_CARD_MARK_WORDS: Readonly<Record<BrowserCardMark, string>> = {
  ok: '✓', ng: '✗', unreadable: '読み取れませんでした', later: '書いたあとに確かめます',
}

export interface BrowserCardCheck {
  label: string
  mark: BrowserCardMark
  /** The headings of the fields that made it ✗ (the ones that differ, or — for "must change" — the ones still the same). */
  fields: readonly string[]
}

/** The card's headline state: everything read and every check ✓; a check ✗; or something not read / not held. */
export type BrowserCardState = 'all_ok' | 'ng' | 'not_read'

export interface BrowserCard {
  title: string
  state: BrowserCardState
  headline: string
  /** The outside account the reads were made under (the map's heading), or not read. Absent when no read thing is bound to one. */
  account?: { label: string; value: BrowserCardValue }
  sections: readonly BrowserCardSection[]
  checks: readonly BrowserCardCheck[]
  /** The map's must-hold notes of every thing read (§15 C5): always shown. */
  notes: readonly string[]
}

export const BROWSER_CARD_WORDS = {
  allOk: '点検した項目は、すべて確かめられました。',
  ng: '確かめで違いが見つかりました（✗ の行を見てください）。',
  notRead: '読み取れなかったものがあります。読み取れなかった行は、サイトで確かめてください。',
  accountUnknown: 'ログインしているアカウントを確かめられませんでした。',
  accountMismatch: '読んでいる間に、ログインしているアカウントが変わったか、予定と違うアカウントです。',
  values: '頼まれた内容を確かめられませんでした。',
  line: 'この点検は、いまは使えません。',
  none: 'なし',
  yes: 'はい',
  no: 'いいえ',
  accountCheck: 'すべて同じアカウントで読みました',
  wrongObject: '頼んだものと違うものを読んだので、確かめられませんでした。',
} as const

/** A field's value as the card writes it (plain; a list joined with 「、」; empty → 「なし」). */
export function browserCardText(field: BrowserMapField, v: unknown): BrowserCardValue {
  if (v === null) return { status: 'read', text: BROWSER_CARD_WORDS.none }
  switch (field.kind) {
    case 'id_list': case 'id_set':
      return Array.isArray(v) ? { status: 'read', text: v.length ? v.join('、') : BROWSER_CARD_WORDS.none } : { status: 'unreadable' }
    case 'flag': return typeof v === 'boolean' ? { status: 'read', text: v ? BROWSER_CARD_WORDS.yes : BROWSER_CARD_WORDS.no } : { status: 'unreadable' }
    case 'number': return typeof v === 'number' ? { status: 'read', text: String(v) } : { status: 'unreadable' }
    default: return typeof v === 'string' ? { status: 'read', text: v } : { status: 'unreadable' }
  }
}

const quoted = (s: string): string => `「${s}」`

/**
 * Build the card of a read-only line (an inspection, §7-3) from the outcome of `evaluateBrowserReadLine(line.read, map,
 * facts)` and the same facts. Values come from a read's state only when that read counted (`outcome.reads[name] === 'ok'`).
 */
export function buildBrowserReadCard(line: BrowserOpenedLine, map: BrowserMap, facts: BrowserReadFacts, outcome: BrowserReadLineOutcome): BrowserCard {
  const thingOf = (read: string): BrowserMapThing | undefined => {
    const r = line.read.reads.find(x => x.name === read)
    return r ? map.things[r.thing] : undefined
  }
  const counted = (read: string): boolean => outcome.reads[read] === 'ok'
  const stateOf = (read: string): Readonly<Record<string, unknown>> | null => {
    if (!counted(read)) return null
    const got: BrowserThingResult | undefined = Object.prototype.hasOwnProperty.call(facts.reads, read) ? facts.reads[read] : undefined
    return got && got.status === 'read' ? got.state : null
  }
  const label = (read: string): string => line.readLabels[read] ?? read
  const fieldLabel = (t: BrowserMapThing | undefined, f: string): string => t?.fields[f]?.label ?? f

  const sections: BrowserCardSection[] = line.show.map(s => {
    const thing = thingOf(s.read)
    const state = stateOf(s.read)
    return {
      heading: label(s.read),
      rows: s.fields.map(f => ({
        label: fieldLabel(thing, f),
        value: state && thing && Object.prototype.hasOwnProperty.call(thing.fields, f) ? browserCardText(thing.fields[f], state[f]) : { status: 'unreadable' } as const,
      })),
    }
  })

  const checks: BrowserCardCheck[] = line.read.checks.map((c, i) => {
    const result: BrowserCheckResult | undefined = outcome.checks[i]
    const named = 'reference' in c ? [c.read, c.reference] : [c.read]
    // ✓ only when the outcome says so and every read the check names counted (a second guard of "unreadable is never ✓").
    const mark: BrowserCardMark = !result || result.word !== c.word ? 'unreadable'
      : result.status === 'ok' ? (named.every(counted) ? 'ok' : 'unreadable')
        : result.status
    const t = thingOf(c.read)
    const fields = mark === 'ng' ? [...(result?.differs ?? result?.same ?? [])].map(f => fieldLabel(t, f)) : []
    return { label: checkLabel(c, line, map, facts, outcome), mark, fields }
  })

  const readThings = [...new Set(line.read.reads.map(r => r.thing))]
  const bound = readThings.some(t => map.things[t]?.must_hold?.account)
  const accountProblem = Object.values(outcome.reads).find(s => s === 'account-unknown' || s === 'account-mismatch')
  if (bound) {
    checks.unshift({
      label: BROWSER_CARD_WORDS.accountCheck,
      mark: outcome.account !== null && !accountProblem ? 'ok' : accountProblem === 'account-mismatch' ? 'ng' : 'unreadable',
      fields: [],
    })
  }
  const notes = [...new Set(readThings.map(t => map.things[t]?.must_hold?.note).filter((n): n is string => typeof n === 'string'))]

  const shapeChanged = Object.values(facts.reads).some(r => r.status === 'not_read' && r.notices.length > 0)
  const state: BrowserCardState = outcome.problem === null && checks.every(c => c.mark === 'ok') ? 'all_ok'
    : outcome.problem === 'check-ng' ? 'ng' : 'not_read'
  const headline = state === 'all_ok' ? BROWSER_CARD_WORDS.allOk
    : outcome.problem === 'line' ? BROWSER_CARD_WORDS.line
      : outcome.problem === 'values' ? BROWSER_CARD_WORDS.values
        : outcome.problem === 'account-unknown' ? BROWSER_CARD_WORDS.accountUnknown
          : outcome.problem === 'account-mismatch' ? BROWSER_CARD_WORDS.accountMismatch
            : shapeChanged ? BROWSER_SHAPE_WORDS.member
              : outcome.problem === 'wrong-object' || outcome.problem === 'wrong-parent' ? BROWSER_CARD_WORDS.wrongObject
              : state === 'ng' ? BROWSER_CARD_WORDS.ng : BROWSER_CARD_WORDS.notRead

  return {
    title: line.label,
    state,
    headline,
    ...(bound && map.account ? { account: { label: map.account.label, value: outcome.account !== null ? { status: 'read', text: outcome.account } : { status: 'unreadable' } } } : {}),
    sections,
    checks,
    notes,
  }
}

/** A check's row text, from the map's and the line's words and the supplied value only. */
function checkLabel(c: BrowserCheck, line: BrowserOpenedLine, map: BrowserMap, facts: BrowserReadFacts, outcome: BrowserReadLineOutcome): string {
  const label = (read: string): string => quoted(line.readLabels[read] ?? read)
  const thing = map.things[line.read.reads.find(r => r.name === c.read)?.thing ?? '']
  const field = (f: string): string => thing?.fields[f]?.label ?? f
  // A supplied value is shown only once the values passed and as a real day (independent review L4): never raw text.
  const value = (name: string): string => {
    const v = outcome.values === null && Object.prototype.hasOwnProperty.call(facts.values ?? {}, name) ? facts.values[name]?.value : undefined
    return isBrowserDate(v) ? v : '—'
  }
  switch (c.word) {
    case 'unchanged_except':
      return `${label(c.read)}は${label(c.reference)}と、${c.except.map(field).join('・') || '番号'}のほかは同じ`
    case 'changed_from':
      return `${label(c.read)}の${c.fields.map(field).join('・')}は、${label(c.reference)}と違う`
    case 'source_unchanged':
      return `${label(c.read)}は、書く前と変わっていない`
    case 'no_sibling_named': {
      const parent = thing?.parent ? map.things[thing.parent.thing]?.label ?? '' : ''
      return `同じ${parent}に、${field(c.field)}が同じものはほかにない`
    }
    case 'date_in_text':
      return `${label(c.read)}の${field(c.field)}に、基準の日付（${value(c.date)}）が入っている`
    case 'datetime_on_date':
      return `${label(c.read)}の${field(c.field)}が、基準の日付（${value(c.date)}）の日`
  }
}
