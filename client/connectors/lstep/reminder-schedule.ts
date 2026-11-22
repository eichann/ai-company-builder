/**
 * A reminder's steps and their timing from the JSON the reminder page itself reads (`explore.reminder_schedule`
 * in ./declaration.ts, 0.6.1; design memo §39, the owner's login, read only):
 * `GET /api/episodes/<reminder>` → `{ id, name, order, type, hid_at, steps: [{ id, order, step_days,
 * step_time: "09:00:00", step_type, step_minutes, skip, initial, egg_id, member_query_id, action_id,
 * episode_id }] }`. One source for the step's timing (0.6.0 read it from the page's text, which on the
 * real page always failed: the page repeats ids in every step's form).
 *
 * **The timing mapping** (`stepTiming`), fixed and tested — only what the JSON and the page were seen
 * to agree on (§39: the test step `step_type 1`, `step_days 0`, `step_time 09:00:00` shows 「当日 09:00」):
 *
 * | `step_type` | `step_days` | `step_time` | shown |
 * |---|---|---|---|
 * | `1` (number) | `0` (number) | `HH:MM:00` (00–23, 00–59) | 「当日 HH:MM」 |
 * | anything else | | | unknown (no fact, no plan) |
 *
 * Not mapped (decision, safe side): any non-zero `step_days` — the page shows 「N日前 HH:MM」 forms
 * (§15, §34), but which sign (or which `step_type`) means 「前」 or 「後」 was not seen; seconds other
 * than `00`; any other `step_type`. `step_minutes`, `skip`, `initial` are not read (their meaning is not
 * confirmed; the shown timing above was confirmed whatever they held).
 *
 * The reminder's `name` (`reminderName`) is read from the same answer, under the same conditions
 * (0.6.1: the owner's rule to let plans be made where safety holds — one answer instead of a folder walk
 * that could stop at the read cap; a name is for showing only, never evidence).
 *
 * The answer counts only when it is this reminder's (`id`), not hidden (`hid_at` present and `null`),
 * with a `steps` list in which the step's id stands exactly once and that step names this reminder
 * (`episode_id`). The answer is parsed strictly by the core (`parseStrictJson`: a key written twice
 * refuses the whole answer).
 */
import type { BrowserExploreItem, BrowserJsonExploreReader, BrowserJsonValue } from '../../shared/browser-runner'

export const LSTEP_REMINDER_SCHEDULE_READER = 'lstep.reminder_schedule'

const POSITIVE_ID = /^[1-9][0-9]{0,18}$/
const STEP_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9]):00$/

type JsonObject = { readonly [key: string]: BrowserJsonValue }
const jsonObject = (v: BrowserJsonValue | undefined): JsonObject | null => (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : null)
const field = (o: JsonObject | null, key: string): BrowserJsonValue | undefined => (o && Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined)
function idOf(v: BrowserJsonValue | undefined): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null
  return typeof v === 'string' && POSITIVE_ID.test(v) ? v : null
}

/** A step's timing as the page shows it, from its JSON (the table above), else null. */
export function stepTiming(step: JsonObject): string | null {
  if (field(step, 'step_type') !== 1 || field(step, 'step_days') !== 0) return null
  const time = field(step, 'step_time')
  const m = typeof time === 'string' ? STEP_TIME.exec(time) : null
  return m ? `当日 ${m[1]}:${m[2]}` : null
}

/** The reminder's steps when the answer is this reminder's and not hidden, else null. */
function stepsOf(json: BrowserJsonValue, reminder: string): JsonObject[] | null {
  const answer = jsonObject(json)
  if (!POSITIVE_ID.test(reminder) || idOf(field(answer, 'id')) !== reminder) return null
  if (field(answer, 'hid_at') !== null) return null
  const steps = field(answer, 'steps')
  if (!Array.isArray(steps)) return null
  const out: JsonObject[] = []
  for (const raw of steps as readonly BrowserJsonValue[]) {
    const step = jsonObject(raw)
    if (!step) return null
    out.push(step)
  }
  return out
}

/** The one step of this id in this reminder's answer (exactly once, naming the reminder), else null. */
export function reminderStep(json: BrowserJsonValue, reminder: string, step: string): JsonObject | null {
  const steps = stepsOf(json, reminder)
  if (!steps || !POSITIVE_ID.test(step)) return null
  const hits = steps.filter(s => idOf(field(s, 'id')) === step)
  if (hits.length !== 1) return null
  return idOf(field(hits[0], 'episode_id')) === reminder ? hits[0] : null
}

/** The reminder's name in its own answer (this reminder's, not hidden, with its steps list), else null. */
export function reminderName(json: BrowserJsonValue, reminder: string): BrowserJsonValue | null {
  if (!stepsOf(json, reminder)) return null
  const name = field(jsonObject(json), 'name')
  return name === undefined ? null : name
}

/**
 * The preview's reader of the same answer: the reminder's steps (`step`), labelled with their timing
 * when the table maps it (no label otherwise). Not this reminder's, hidden, a step that is not an
 * object, without a plain id, naming another reminder or standing twice → incomplete.
 */
export function createLstepReminderScheduleReader(): BrowserJsonExploreReader {
  return {
    id: LSTEP_REMINDER_SCHEDULE_READER,
    answer: 'json',
    fields: ['step'],
    extra: [],
    read(values, json) {
      const reminder = values.reminder ?? ''
      const steps = stepsOf(json, reminder)
      if (!steps) return { items: [], complete: false }
      let complete = true
      const seen = new Set<string>()
      const twice = new Set<string>()
      for (const s of steps) {
        const id = idOf(field(s, 'id'))
        if (id) { if (seen.has(id)) twice.add(id); seen.add(id) }
      }
      const items: BrowserExploreItem[] = []
      for (const s of steps) {
        const id = idOf(field(s, 'id'))
        if (!id || twice.has(id) || idOf(field(s, 'episode_id')) !== reminder) { complete = false; continue }
        const timing = stepTiming(s)
        items.push(timing ? { field: 'step', value: id, label: timing } : { field: 'step', value: id })
      }
      return { items, complete }
    },
  }
}
