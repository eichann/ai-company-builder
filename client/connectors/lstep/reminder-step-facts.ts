/**
 * The facts `lstep.reminder_step` reads for a plan, facts version 2 (6b-2b, 0.6.1; design 6b-2 §2-3;
 * agent-browser.md "The facts a checker reads"; shapes in shared/core/browser-plans.ts). Only reads
 * `explore` declares (./declaration.ts), only shapes seen on the real site with the owner's login
 * (design memo §34–§36, §39). What is not confirmed is never guessed: it is `unknown`, and a required fact
 * unknown makes no plan.
 *
 * | Fact | Read from | Status today |
 * |---|---|---|
 * | `account` | the reminder page's `<meta name="lm-account-id">` (`accountFromMeta`, the run's reading) | confirmed §34 |
 * | `step_parent`, `state` | the reminder page: the step's box `templateStep<step>` and its `openModal(…)` slots (the run's `view`) | box confirmed §34; slots from the 11/20 capture |
 * | `templates` | `GET /api/templates?group=<folder>&page=<n>` entries `{ id, name, content_text, form_type, group }`, found by id, folder by folder (`/api/template-groups`) | confirmed §34, §36; `form_type` 8 = text (§34), any other → no plan |
 * | `names.reminder` | `GET /api/episodes/<reminder>` `name`, under the same conditions as the timing (0.6.1; 0.6.0 walked the reminder folders for it) | the shape confirmed §39 |
 * | `schedule.timing`, `names.step` | `GET /api/episodes/<reminder>` (strict JSON): the one step whose `id` is the target step, in this reminder's answer (`id`), not hidden (`hid_at: null`), naming the reminder (`episode_id`); its `step_type` / `step_days` / `step_time` through the fixed table of ./reminder-schedule.ts (`1` / `0` / `HH:MM:00` → 「当日 HH:MM」, anything else unknown) | confirmed §39 (`1` / `0` / `09:00:00` shown 「当日 09:00」); other combinations not seen → unknown |
 * | `shared_with` | — | Lステップ has no reverse lookup of the 回 using a reminder (people join it from tags, forms, keywords, friend-add, reservations, actions; the owner, 2026-11-22): always `unknown`, **optional since 0.6.1** — the card always shows the declaration's `shared` warning instead |
 * | `audience` | — | no reading confirmed to mean "people who will still receive this step": always `unknown` (optional, shown 「読み取れませんでした」) |
 *
 * The template folder scan reads a folder list, then each folder's pages in order (at most 10, the declared
 * `pages.max`) until every id sought is found, then stop; the core caps the reads in all
 * (`BROWSER_FACT_READS`). An entry counts only when every folder id it carries names the folder asked
 * (as the list readers do: a folder filter the site did not apply shows as entries of other folders,
 * left out), an id found twice with different contents **among the pages read** is not found — folders
 * after the one where the last id was found are not read, so a copy there is not seen (ids are the
 * site's own record numbers; walking every folder would make the cap, and so no facts, likely) — and
 * 「未分類」 (`id 0`) is never asked (not a positive id): a template there is not found → `templates`
 * unknown → no plan.
 */
import { isPlainBrowserText, type BrowserPlanValues } from '../../../shared/core/plugin-browser-declaration'
import type {
  BrowserCheckerFacts, BrowserCheckerView, BrowserFactAnswer, BrowserFactDraft, BrowserFactRequest, BrowserJsonValue, BrowserPageRead,
} from '../../shared/browser-runner'
import { reminderName, reminderStep, stepTiming } from './reminder-schedule'

/** The facts version these readers produce (shared/core/browser-plans.ts `BROWSER_FACT_SCHEMAS`). */
export const LSTEP_FACTS_VERSION = 2
/** `form_type` of a text-only template (design memo §34: the test templates, both text, were 8). */
const TEXT_FORM_TYPE = 8
/** The declared `pages.max` of `reminders` and `templates` (./declaration.ts). */
const MAX_PAGES = 10
const POSITIVE_ID = /^[1-9][0-9]{0,18}$/

type JsonObject = { readonly [key: string]: BrowserJsonValue }
const jsonObject = (v: BrowserJsonValue | undefined): JsonObject | null => (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : null)
const field = (o: JsonObject | null, key: string): BrowserJsonValue | undefined => (o && Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined)
function idOf(v: BrowserJsonValue | undefined): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null
  return typeof v === 'string' && POSITIVE_ID.test(v) ? v : null
}
/** Every folder id an entry carries (`group_id`, `group.id`, a plain `group`). */
function foldersOf(entry: JsonObject): Array<BrowserJsonValue | undefined> {
  const out: Array<BrowserJsonValue | undefined> = []
  const groupId = field(entry, 'group_id')
  if (groupId !== undefined) out.push(groupId)
  const group = field(entry, 'group')
  if (group !== undefined) out.push(jsonObject(group) ? field(jsonObject(group), 'id') : group)
  return out
}

interface ScanSpec {
  /** The declared read of the folder list (no values). */
  folders: string
  /** The declared paginated read of one folder's entries. */
  list: string
  /** Its folder `{name}`. */
  param: string
}

/** What a folder scan found: each id sought → its entry and the answer it came from, or 'ambiguous'. */
type Found = Map<string, { entry: JsonObject; at: number } | 'ambiguous'>

/**
 * A folder scan over the answers so far: the next read it needs (none = done) and what it found. Pure:
 * it is worked out again from the answers every time.
 */
function scan(spec: ScanSpec, wanted: ReadonlySet<string>, answers: readonly BrowserFactAnswer[]): { next: BrowserFactRequest | null; found: Found } {
  const found: Found = new Map()
  const done = () => [...wanted].every(id => { const f = found.get(id); return f !== undefined && f !== 'ambiguous' })
  if (wanted.size === 0) return { next: null, found }
  const listAt = answers.findIndex(a => a.read === spec.folders)
  if (listAt < 0) return { next: { read: spec.folders, values: {} }, found }
  const list = answers[listAt]
  const data = list.ok && list.kind === 'json' ? field(jsonObject(list.json), 'data') : undefined
  if (!Array.isArray(data)) return { next: null, found }
  const folders = [...new Set((data as readonly BrowserJsonValue[]).map(e => idOf(field(jsonObject(e), 'id'))).filter((id): id is string => id !== null))]
  for (const folder of folders) {
    for (let n = 1; n <= MAX_PAGES; n++) {
      const at = answers.findIndex(a => a.read === spec.list && a.values[spec.param] === folder && (a.page ?? 1) === n)
      if (at < 0) return done() ? { next: null, found } : { next: { read: spec.list, values: { [spec.param]: folder }, page: n }, found }
      const answer = answers[at]
      if (!answer.ok || answer.kind !== 'json') break
      const page = jsonObject(answer.json)
      const entries = field(page, 'data')
      if (Array.isArray(entries)) {
        for (const raw of entries as readonly BrowserJsonValue[]) {
          const entry = jsonObject(raw)
          const id = entry ? idOf(field(entry, 'id')) : null
          if (!entry || !id || !wanted.has(id)) continue
          const named = foldersOf(entry)
          if (named.length === 0 || named.some(g => idOf(g) !== folder)) continue
          const before = found.get(id)
          if (before === undefined) found.set(id, { entry, at })
          else if (before !== 'ambiguous' && JSON.stringify(before.entry) !== JSON.stringify(entry)) found.set(id, 'ambiguous')
        }
      }
      if (done()) return { next: null, found }
      // The page says where it stands, else the folder's later pages are not read.
      const current = field(page, 'current_page')
      const last = field(page, 'last_page')
      if (current !== n || typeof last !== 'number' || n >= last) break
    }
  }
  return { next: null, found }
}

const TEMPLATES: ScanSpec = { folders: 'template_folders', list: 'templates', param: 'template_group' }

/** The step's timing from the reminder's JSON answer (./reminder-schedule.ts), else null. */
function timingOf(answer: BrowserFactAnswer | undefined, reminder: string, step: string): string | null {
  if (!answer || !answer.ok || answer.kind !== 'json') return null
  const found = reminderStep(answer.json, reminder, step)
  const timing = found ? stepTiming(found) : null
  return timing && isPlainBrowserText(timing, 100) ? timing : null
}

/**
 * The facts reader of `lstep.reminder_step` (version 2), over the checker's own run-time `view` for the
 * account and the step's state (the same reading the run compares `before` with).
 */
export function createLstepReminderStepFacts(view: (values: BrowserPlanValues, reads: readonly BrowserPageRead[]) => BrowserCheckerView): BrowserCheckerFacts {
  const pageAt = (values: BrowserPlanValues, answers: readonly BrowserFactAnswer[]) =>
    answers.findIndex(a => a.read === 'reminder' && a.values.reminder === values.target.reminder)
  const scheduleAt = (values: BrowserPlanValues, answers: readonly BrowserFactAnswer[]) =>
    answers.findIndex(a => a.read === 'reminder_schedule' && a.values.reminder === values.target.reminder)
  const stateOf = (values: BrowserPlanValues, answer: BrowserFactAnswer | undefined): BrowserCheckerView | null => {
    if (!answer || !answer.ok || answer.kind !== 'html') return null
    return view(values, [{ path: `/line/episode/show/${values.target.reminder}`, body: answer.body }])
  }
  const templatesSought = (values: BrowserPlanValues, state: BrowserCheckerView | null): Set<string> => {
    const ids = [...(state?.state?.templates ?? []), values.change.template]
    return new Set(ids.filter((id): id is string => typeof id === 'string' && POSITIVE_ID.test(id)))
  }
  return {
    version: LSTEP_FACTS_VERSION,
    next(values, answers) {
      const reminder = values.target.reminder
      if (!POSITIVE_ID.test(reminder ?? '')) return []
      const at = pageAt(values, answers)
      if (at < 0) return [{ read: 'reminder', values: { reminder } }]
      const checked = stateOf(values, answers[at])
      // No target on the page: nothing else is worth reading (no plan can come of it).
      if (!checked?.state) return []
      const next: BrowserFactRequest[] = []
      if (scheduleAt(values, answers) < 0) next.push({ read: 'reminder_schedule', values: { reminder } })
      const t = scan(TEMPLATES, templatesSought(values, checked), answers).next
      if (t) next.push(t)
      return next
    },
    read(values, answers) {
      const at = Math.max(0, pageAt(values, answers))
      const page = answers[at]
      const checked = page?.read === 'reminder' ? stateOf(values, page) : null
      const unknown = (from = at): BrowserFactDraft => ({ status: 'unknown', from })
      const facts: Record<string, BrowserFactDraft> = {}
      let problem: string | undefined

      facts.account = checked?.account ? { status: 'known', value: { id: checked.account }, from: at, rawMarkup: true } : unknown()
      if (checked?.state) {
        facts.step_parent = { status: 'known', value: { reminder: values.target.reminder }, from: at, rawMarkup: true }
        facts.state = { status: 'known', value: { templates: [...checked.state.templates] }, complete: true, from: at, rawMarkup: true }
      } else {
        facts.step_parent = unknown()
        facts.state = unknown()
      }

      const sAt = scheduleAt(values, answers)
      const timing = checked?.state && sAt >= 0 ? timingOf(answers[sAt], values.target.reminder, values.target.step ?? '') : null
      facts.schedule = timing ? { status: 'known', value: { timing }, complete: true, from: sAt } : unknown(sAt >= 0 ? sAt : at)

      const scheduleAnswer = sAt >= 0 ? answers[sAt] : undefined
      const shown = timing && scheduleAnswer?.ok && scheduleAnswer.kind === 'json' ? reminderName(scheduleAnswer.json, values.target.reminder) : null
      facts.names = timing && isPlainBrowserText(shown, 200)
        // Stamped from the reminder's JSON answer, where the step's name (its timing) is read.
        ? { status: 'known', value: { reminder: shown, step: timing }, from: sAt }
        : unknown()

      if (checked?.state) {
        const sought = templatesSought(values, checked)
        const found = scan(TEMPLATES, sought, answers).found
        const templates: Record<string, { name: string; kind: 'text'; body: string }> = {}
        let whole = true
        let from = at
        for (const id of sought) {
          const hit = found.get(id)
          if (!hit || hit === 'ambiguous') { whole = false; continue }
          const name = field(hit.entry, 'name')
          const body = field(hit.entry, 'content_text')
          // The first version reads text-only templates (6b-2 decision 2): any other kind makes no plan.
          if (field(hit.entry, 'form_type') !== TEXT_FORM_TYPE) { whole = false; problem = 'template-not-text'; continue }
          if (!isPlainBrowserText(name, 200) || !isPlainBrowserText(body, 5000, true)) { whole = false; continue }
          templates[id] = { name, kind: 'text', body }
          if (id === values.change.template) from = hit.at
        }
        facts.templates = whole ? { status: 'known', value: templates, complete: true, from } : unknown()
      } else facts.templates = unknown()

      // Not confirmed on the real site (design 6b-2b; to check at the owner's next login): never guessed.
      facts.shared_with = unknown()
      facts.audience = unknown()
      return problem ? { facts, problem } : { facts }
    },
  }
}
