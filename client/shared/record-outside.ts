/**
 * Records as the AI reads them (records_get / records_query / records_my_turn / records_ai_turn,
 * `ai-turns.md` "Outside text"): a record's title, summary and text fields may be a mail's subject,
 * a Slack message, a calendar invite or text an AI copied from them, so each becomes
 * `{ outside: … }` (`shared/core/outside-text.ts`, the one standard); ids, types, states, dates,
 * numbers, choices, people, links and tags stay plain. The answer then says once what `outside`
 * means and flags instruction-like text. Pure.
 */
import { OUTSIDE_VALUE_NOTE, outsideTextFlags, outsideValue } from '../../shared/core/outside-text'
import { INSTRUCTION_LIKE_WORDS } from '../../shared/core/instruction-like'
import { RECORD_ID_RE } from '../../shared/core/records'

/** The field kinds whose values are the app's own (never outside text). */
const PLAIN_KINDS: ReadonlySet<string> = new Set(['number', 'boolean', 'date', 'datetime', 'choice', 'person', 'record', 'tags'])

/** A field's kind in its type, or undefined when the type or field is unknown (then a string is treated as text). */
export type FieldKindOf = (type: string, field: string) => string | undefined

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isRecord = (v: Record<string, unknown>): boolean =>
  typeof v.id === 'string' && RECORD_ID_RE.test(v.id) && typeof v.type === 'string' && typeof v.title === 'string'

export function markRecordOutside(answer: unknown, kindOf: FieldKindOf): unknown {
  const texts: string[] = []
  const mark = (text: string) => { texts.push(text); return outsideValue(text) }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (!isObject(v)) return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = walk(x)
    if (!isRecord(v)) return out
    const type = v.type as string
    out.title = mark(v.title as string)
    if (typeof v.summary === 'string' && v.summary !== '') out.summary = mark(v.summary)
    if (isObject(v.fields)) {
      out.fields = Object.fromEntries(Object.entries(v.fields).map(([f, x]) => {
        const kind = kindOf(type, f)
        return [f, typeof x === 'string' && x !== '' && (kind === undefined || !PLAIN_KINDS.has(kind)) ? mark(x) : walk(x)]
      }))
    }
    return out
  }
  const marked = walk(answer)
  if (texts.length === 0 || !isObject(marked)) return marked
  const flags = outsideTextFlags(texts.join('\n'))
  return {
    outsideNote: OUTSIDE_VALUE_NOTE,
    ...(flags.length > 0 ? { instructionLike: flags.map(l => INSTRUCTION_LIKE_WORDS[l] ?? l) } : {}),
    ...marked,
  }
}
