/**
 * Lステップ's readers for map 1.0.2 (./map.ts): each turns one strictly read JSON answer into its thing's state — exactly
 * the map's fields, each of its kind — and throws on anything it does not understand (the core then says 「読み取れません
 * でした」; never a guess). The core has already checked every key against the map before a reader runs
 * (`readBrowserThing`); a reader decides the values. Only shapes stage 0 recorded; where it recorded a name but not a
 * value's spelling, both plausible spellings are taken and nothing else:
 * - ids: a positive whole number, as a number or digits (a folder may be `0`, 「未分類」, or none);
 * - flags: true / false, or 0 / 1;
 * - texts: plain text (the core's rule); an empty text is read as none (the card says 「なし」 for both);
 * - dates `YYYY-MM-DD`, times `HH:MM` (or `HH:MM:00`); numbers as a number or a decimal in digits;
 * - an action's input (1.0.1, the full key sets confirmed): type 13 with exactly `tag_ids`, 12 with exactly `egg_id`, 15
 *   with exactly `episode_id` and `firetype`, each with `member_query_id` and `send_member_query_id` null — the other
 *   kinds' keys absent, a condition on who receives it not null → not read. Any other type → not read (an action doing
 *   something unread is never "the same").
 */
import type { BrowserThingReader } from '../../../shared/core/browser-map'
// The old path's checker, unchanged (memo §6 「読む部品はそのまま」, §16-7 R3: the same reading as the run-time reader): the
// step's templates are read exactly as `lstep@0.6.x` reads them. Its folder's fingerprint is part of this map's
// `readersHash` (client/scripts/browser-opened.ts), so a change there needs a new map version too.
import { createLstepReminderStepChecker } from '../../connectors/lstep/reminder-step'

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const field = (o: Json, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
const fail = (why: string): never => { throw new Error(why) }

const POSITIVE = /^[1-9][0-9]{0,18}$/
function id(v: unknown, opts: { zero?: boolean; nullable?: boolean } = {}): string | null {
  if (v === null && opts.nullable) return null
  if (typeof v === 'number' && Number.isSafeInteger(v) && (v > 0 || (opts.zero && v === 0))) return String(v)
  if (typeof v === 'string' && (POSITIVE.test(v) || (opts.zero && v === '0'))) return v
  return fail('id')
}
function flag(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (v === 0 || v === 1) return v === 1
  return fail('flag')
}
function text(v: unknown, nullable: boolean): string | null {
  if (v === null || v === '') return nullable ? null : fail('text')
  return typeof v === 'string' ? v : fail('text')
}
function date(v: unknown): string | null {
  if (v === null || v === '') return null
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fail('date')
}
function time(v: unknown): string | null {
  if (v === null || v === '') return null
  if (typeof v !== 'string') return fail('time')
  const m = /^(\d{2}:\d{2})(?::00)?$/.exec(v)
  return m ? m[1] : fail('time')
}
function number(v: unknown): number | null {
  if (v === null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d{1,4}(\.\d{1,15})?$/.test(v)) return Number(v)
  return fail('number')
}

/** `GET /api/landings/<id>`: no id of its own (the core adds the address's). */
export const readLanding: BrowserThingReader = (a) => {
  if (!isObject(a)) return fail('landing')
  const params = field(a, 'custom_params')
  if (!Array.isArray(params)) return fail('custom_params')
  return {
    name: text(field(a, 'name'), false),
    qr_text: text(field(a, 'qr_text'), true),
    action_id: id(field(a, 'action_id')),
    prevent_default: flag(field(a, 'prevent_default')),
    only_welcome: flag(field(a, 'only_welcome')),
    cv_head: text(field(a, 'cv_head'), true),
    cv_body: text(field(a, 'cv_body'), true),
    group_id: id(field(a, 'group_id'), { zero: true, nullable: true }),
    from_date: date(field(a, 'from_date')),
    from_time: time(field(a, 'from_time')),
    to_date: date(field(a, 'to_date')),
    to_time: time(field(a, 'to_time')),
    out_of_period_message: text(field(a, 'out_of_period_message'), true),
    latitude: number(field(a, 'latitude')),
    longitude: number(field(a, 'longitude')),
    radius: number(field(a, 'radius')),
    params: params.map(p => (isObject(p) ? id(field(p, 'var_id')) : fail('custom_params'))),
    only_once_param_sync: flag(field(a, 'only_once_param_sync')),
  }
}

/** One row of `GET /api/landings?group=<folder>&page=<n>` (the row object itself). */
export const readLandingRow: BrowserThingReader = (a) => {
  if (!isObject(a)) return fail('landing_row')
  return {
    id: id(field(a, 'id')),
    name: text(field(a, 'name'), false),
    follow_url: text(field(a, 'follow_url'), false),
    qr_url: text(field(a, 'qr_url'), false),
    validity_period_from: text(field(a, 'validity_period_from'), true),
    validity_period_to: text(field(a, 'validity_period_to'), true),
  }
}

const INPUT_KEYS: Readonly<Record<string, readonly string[]>> = {
  13: ['tag_ids'],
  12: ['egg_id'],
  15: ['episode_id', 'firetype'],
}
const ALL_INPUT_KEYS = ['tag_ids', 'egg_id', 'episode_id', 'firetype']
/** Keys every input carries (null everywhere seen): a value here would be a condition the state does not hold. */
const NULL_INPUT_KEYS = ['member_query_id', 'send_member_query_id']

/** `GET /api/actions/<id>`: its inputs grouped by what they do; no id of its own (the core adds the address's). */
export const readActionSet: BrowserThingReader = (a) => {
  if (!isObject(a)) return fail('action_set')
  const inputs = field(a, 'inputs')
  if (!Array.isArray(inputs)) return fail('inputs')
  const tags: string[] = []
  const templates: string[] = []
  const stops: string[] = []
  for (const input of inputs) {
    if (!isObject(input)) return fail('input')
    const type = String(id(field(input, 'type')))
    const own = INPUT_KEYS[type] ?? fail('input type')
    // Exactly this kind's keys (1.0.1): the other kinds' are absent; the conditions null.
    for (const k of ALL_INPUT_KEYS) if (!own.includes(k) && field(input, k) !== undefined) fail('input keys')
    for (const k of NULL_INPUT_KEYS) if (field(input, k) !== null) fail('input condition')
    if (type === '13') {
      const ids = field(input, 'tag_ids')
      if (!Array.isArray(ids) || ids.length === 0) return fail('tag_ids')
      for (const t of ids) tags.push(id(t) as string)
    } else if (type === '12') {
      templates.push(id(field(input, 'egg_id')) as string)
    } else {
      stops.push(`${id(field(input, 'episode_id'))}_${id(field(input, 'firetype'), { zero: true })}`)
    }
  }
  return {
    name: text(field(a, 'a_name'), true),
    twice: twice(field(a, 'a_twice_type')),
    tags,
    templates,
    stops,
  }
}

/** `a_twice_type` as written: a whole number or a short plain word, never parsed for meaning. */
function twice(v: unknown): string | null {
  if (v === null || v === '') return null
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v)
  if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v)) return v
  return fail('a_twice_type')
}

/** `GET /api/episodes/<id>` (§39): not hidden (`hid_at` null), every step naming this reminder, no step twice. */
export const readReminder: BrowserThingReader = (a) => {
  if (!isObject(a)) return fail('reminder')
  if (field(a, 'hid_at') !== null) return fail('hidden')
  const reminder = id(field(a, 'id')) as string
  const steps = field(a, 'steps')
  if (!Array.isArray(steps)) return fail('steps')
  const ids = steps.map(s => {
    if (!isObject(s)) return fail('step')
    if (id(field(s, 'episode_id')) !== reminder) return fail('step of another reminder')
    return id(field(s, 'id')) as string
  })
  if (new Set(ids).size !== ids.length) return fail('a step twice')
  return { id: reminder, name: text(field(a, 'name'), false), steps: ids }
}

/** Reads only the step's state: the account is the line's own read of the marker, the page's form values are the write's. */
const stepView = createLstepReminderStepChecker(() => null).view

/**
 * The reminder's page `GET /line/episode/show/<reminder>` (an html thing): the step's templates exactly as the old path's
 * checker reads them (its box exactly once on this reminder's page, every row and slot naming this reminder and this
 * step, every delete form of the step a row — anything else: no state). The reminder is the one main asked the page
 * for; the core puts the step's id in.
 */
export const readReminderStep: BrowserThingReader = (page, ids) => {
  if (typeof page !== 'string' || !ids || !ids.parent || !POSITIVE.test(ids.id) || !POSITIVE.test(ids.parent)) return fail('ids')
  const view = stepView({ target: { reminder: ids.parent, step: ids.id }, change: {} }, [{ path: `/line/episode/show/${ids.parent}`, body: page }])
  if (!view.state) return fail('no step')
  return { reminder: ids.parent, templates: [...view.state.templates] }
}

/** `GET /api/episode-steps/<step>` (§40): the site's own timing text, trimmed, one line. */
export const readStepTiming: BrowserThingReader = (a) => {
  if (!isObject(a)) return fail('step_timing')
  const timing = field(a, 'step_timing_text')
  if (typeof timing !== 'string' || /[\r\n]/.test(timing) || timing.trim() === '' || timing.trim().length > 100) return fail('timing')
  return { step: id(field(a, 'episode_step_id')), reminder: id(field(a, 'episode_id')), timing: timing.trim() }
}

/** One entry of `GET /api/template-groups` (§36): 「未分類」 is `0` (§40). */
export const readTemplateFolder: BrowserThingReader = (a) => {
  if (!isObject(a)) return fail('template_folder')
  return { id: id(field(a, 'id'), { zero: true }), name: text(field(a, 'name'), false) }
}

/** `form_type` of a text template (§34): the only kind read (the old path's rule, 6b-2 decision 2). */
const TEXT_FORM_TYPE = 8

/** One entry of `GET /api/templates?group=<folder>&page=<n>`: text only; no folder (「未分類」) is folder `0`. */
export const readTemplate: BrowserThingReader = (a) => {
  if (!isObject(a)) return fail('template')
  if (field(a, 'form_type') !== TEXT_FORM_TYPE) return fail('not text')
  const group = field(a, 'group')
  const folder = group === null ? '0' : isObject(group) ? id(field(group, 'id'), { zero: true }) : fail('group')
  const body = field(a, 'content_text')
  if (typeof body !== 'string') return fail('body')
  return { id: id(field(a, 'id')), folder, name: text(field(a, 'name'), false), body }
}

export const LSTEP_MAP_READERS: Readonly<Record<string, BrowserThingReader>> = {
  landing: readLanding,
  landing_row: readLandingRow,
  action_set: readActionSet,
  reminder: readReminder,
  reminder_step: readReminderStep,
  step_timing: readStepTiming,
  template_folder: readTemplateFolder,
  template: readTemplate,
}
