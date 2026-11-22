/**
 * A reminder's steps and a step's timing from the JSON Lステップ's own pages read (0.6.1; design memo
 * §39, §40, the owner's login, read only). Both answers are parsed strictly by the core
 * (`parseStrictJson`: a key written twice refuses the whole answer).
 *
 * - `explore.reminder_schedule`: `GET /api/episodes/<reminder>` → `{ id, name, order, type, hid_at,
 *   steps: [{ id, order, step_days, step_time, step_type, step_minutes, skip, initial, egg_id,
 *   member_query_id, action_id, episode_id }] }` (§39; the captured test step carries `episode_id`).
 *   It counts only when it is this reminder's (`id`), not hidden (`hid_at` present and `null`), with a
 *   `steps` list of objects in which the step's id stands exactly once and that step names this reminder
 *   (`episode_id`) — `reminderStep`. The reminder's `name` comes from it too (`reminderName`, same
 *   conditions; a name is for showing only, never evidence).
 * - `explore.step_timing`: `GET /api/episode-steps/<step>` → `{ episode_id, episode_group_id,
 *   episode_name, episode_step_id, step_timing_text }` (§40): **Lステップ's own display text for the
 *   step's timing** (「当日 09:00」, 「3日前 19:00」, …). Taken verbatim — never parsed or rebuilt (its
 *   base differs per person; the site's text spares us guessing what `step_days` / `step_type` mean) —
 *   when `episode_step_id` is the step and `episode_id` the reminder, trimmed, one line of plain text,
 *   1–100 characters (`stepTimingText`); anything else is no timing.
 */
import { isPlainBrowserText } from '../../../shared/core/plugin-browser-declaration'
import type { BrowserExploreItem, BrowserJsonExploreReader, BrowserJsonValue } from '../../shared/browser-runner'

export const LSTEP_REMINDER_SCHEDULE_READER = 'lstep.reminder_schedule'
export const LSTEP_STEP_TIMING_READER = 'lstep.step_timing'

const POSITIVE_ID = /^[1-9][0-9]{0,18}$/

type JsonObject = { readonly [key: string]: BrowserJsonValue }
const jsonObject = (v: BrowserJsonValue | undefined): JsonObject | null => (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : null)
const field = (o: JsonObject | null, key: string): BrowserJsonValue | undefined => (o && Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined)
function idOf(v: BrowserJsonValue | undefined): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null
  return typeof v === 'string' && POSITIVE_ID.test(v) ? v : null
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

/** The site's own timing text of this step of this reminder, trimmed, one plain line of 1–100 characters, else null. */
export function stepTimingText(json: BrowserJsonValue, reminder: string, step: string): string | null {
  const answer = jsonObject(json)
  if (!POSITIVE_ID.test(reminder) || !POSITIVE_ID.test(step)) return null
  if (idOf(field(answer, 'episode_step_id')) !== step || idOf(field(answer, 'episode_id')) !== reminder) return null
  const text = field(answer, 'step_timing_text')
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  return isPlainBrowserText(trimmed, 100) ? trimmed : null
}

/**
 * The preview's reader of the reminder's answer: its steps (`step`). Not this reminder's, hidden, a step
 * that is not an object, without a plain id, naming another reminder or standing twice → incomplete.
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
        items.push({ field: 'step', value: id })
      }
      return { items, complete }
    },
  }
}

/**
 * The preview's reader of a step's answer: the step (`step`) labelled with the site's timing text. The
 * read names the step only, so the answer's reminder is not checked here (the facts check it).
 */
export function createLstepStepTimingReader(): BrowserJsonExploreReader {
  return {
    id: LSTEP_STEP_TIMING_READER,
    answer: 'json',
    fields: ['step'],
    extra: [],
    read(values, json) {
      const step = values.step ?? ''
      const answer = jsonObject(json)
      const reminder = idOf(field(answer, 'episode_id'))
      const text = reminder ? stepTimingText(json, reminder, step) : null
      return text ? { items: [{ field: 'step', value: step, label: text }], complete: true } : { items: [], complete: false }
    },
  }
}
