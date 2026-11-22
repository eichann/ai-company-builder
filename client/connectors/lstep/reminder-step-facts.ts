/**
 * The facts `lstep.reminder_step` reads for a plan, facts version 2 (6b-2b; design 6b-2 §2-3;
 * agent-browser.md "The facts a checker reads"; shapes in shared/core/browser-plans.ts). Only reads
 * `explore` declares (./declaration.ts), only shapes seen on the real site with the owner's login
 * (design memo §34–§36). What is not confirmed is never guessed: it is `unknown`, and a required fact
 * unknown makes no plan.
 *
 * | Fact | Read from | Status today |
 * |---|---|---|
 * | `account` | the reminder page's `<meta name="lm-account-id">` (`accountFromMeta`, the run's reading) | confirmed §34 |
 * | `step_parent`, `state` | the reminder page: the step's box `templateStep<step>` and its `openModal(…)` slots (the run's `view`) | box confirmed §34; slots from the 11/20 capture |
 * | `templates` | `GET /api/templates?group=<folder>&page=<n>` entries `{ id, name, content_text, form_type, group }`, found by id, folder by folder (`/api/template-groups`) | confirmed §34, §36; `form_type` 8 = text (§34), any other → no plan |
 * | `names.reminder` | `GET /api/episodes?group=<folder>&page=<n>` entry `name`, found by id (`/api/episode-groups`) | confirmed §35, §36 |
 * | `schedule.timing`, `names.step` | the step's box: one element whose whole visible text is a timing (「当日 09:00」「3 日前 に送信」), never a link or what holds one (a template's name); a timing inside a link → unknown | the text forms are §34's; **where it stands in the box is not confirmed** |
 * | `shared_with` | — | **not confirmed** where the site lists the 回 using a reminder: always `unknown` (so no plan yet) |
 * | `audience` | — | no reading confirmed to mean "people who will still receive this step": always `unknown` (optional, shown 「読み取れませんでした」) |
 *
 * The folder scans read a folder list, then each folder's pages in order (at most 10, the declared
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
  BrowserCheckerFacts, BrowserCheckerView, BrowserFactAnswer, BrowserFactDraft, BrowserFactRequest, BrowserJsonValue, BrowserPageElement, BrowserPageRead,
} from '../../shared/browser-runner'

/** The facts version these readers produce (shared/core/browser-plans.ts `BROWSER_FACT_SCHEMAS`). */
export const LSTEP_FACTS_VERSION = 2
/** `form_type` of a text-only template (design memo §34: the test templates, both text, were 8). */
const TEXT_FORM_TYPE = 8
/** The declared `pages.max` of `reminders` and `templates` (./declaration.ts). */
const MAX_PAGES = 10
const POSITIVE_ID = /^[1-9][0-9]{0,18}$/
/**
 * A step's timing as the page shows it — 「当日 09:00」, 「3日前 09:00」, 「N 日前 に送信」 (§34) — recognised
 * whole, never taken apart: the card shows it as it stands (its base differs per person).
 */
const TIMING_RE = /^(?:当日|[1-9][0-9]{0,2} ?日(?:前|後))(?: ?(?:[01]?[0-9]|2[0-3]):[0-5][0-9])?(?: ?に送信)?$/

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

const REMINDERS: ScanSpec = { folders: 'reminder_folders', list: 'reminders', param: 'group' }
const TEMPLATES: ScanSpec = { folders: 'template_folders', list: 'templates', param: 'template_group' }

/** Attributes a template's slot call stands in (as ./reminder-steps-reader.ts reads them). */
const CALL_ATTRIBUTES = ['onclick', 'href', 'data-onclick'] as const
/** A link or button of the box — a template's slot (`openModal(…)`) or any other: its text is a template's or a control's, never the step's timing. */
const isLink = (el: BrowserPageElement): boolean =>
  el.tag === 'a' || el.tag === 'button' || CALL_ATTRIBUTES.some(name => /openModal\s*\(/.test(el.attr(name) ?? ''))
const holdsLink = (el: BrowserPageElement): boolean => el.find({}).some(isLink)

/**
 * The step's timing in its box: exactly one distinct visible text that is a whole timing, else null.
 * Never from a link (a template named 「当日 09:00」 is a template's name) nor from an element holding
 * one; and a timing-shaped text inside any link makes the timing unknown (where the real one stands
 * is not confirmed: in doubt, no fact).
 */
function timingOf(answer: BrowserFactAnswer, step: string): string | null {
  if (!answer.ok || answer.kind !== 'html' || !POSITIVE_ID.test(step)) return null
  const boxes = answer.view.find({ id: `templateStep${step}` })
  if (boxes.length !== 1) return null
  // A link whose text (or a part's) is timing-shaped: unknown. So a link is never a candidate below either.
  const links = boxes[0].find({}).filter(isLink)
  if (links.some(link => [link, ...link.find({})].some(el => TIMING_RE.test(el.text())))) return null
  const texts = new Set(boxes[0].find({}).filter(el => !holdsLink(el)).map(el => el.text()).filter(t => TIMING_RE.test(t)))
  if (texts.size !== 1) return null
  const [timing] = [...texts]
  return isPlainBrowserText(timing, 100) ? timing : null
}

/**
 * The facts reader of `lstep.reminder_step` (version 2), over the checker's own run-time `view` for the
 * account and the step's state (the same reading the run compares `before` with).
 */
export function createLstepReminderStepFacts(view: (values: BrowserPlanValues, reads: readonly BrowserPageRead[]) => BrowserCheckerView): BrowserCheckerFacts {
  const pageAt = (values: BrowserPlanValues, answers: readonly BrowserFactAnswer[]) =>
    answers.findIndex(a => a.read === 'reminder' && a.values.reminder === values.target.reminder)
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
      const r = scan(REMINDERS, new Set([reminder]), answers).next
      if (r) next.push(r)
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

      const timing = checked?.state && page ? timingOf(page, values.target.step ?? '') : null
      facts.schedule = timing ? { status: 'known', value: { timing }, complete: true, from: at } : unknown()

      const reminderFound = checked?.state ? scan(REMINDERS, new Set([values.target.reminder]), answers).found.get(values.target.reminder) : undefined
      const reminderName = reminderFound && reminderFound !== 'ambiguous' ? field(reminderFound.entry, 'name') : undefined
      facts.names = timing && isPlainBrowserText(reminderName, 200) && reminderFound && reminderFound !== 'ambiguous'
        // Stamped from the page: the step's name is read there through the view, so a page not read
        // whole leaves the names unknown too (the core's rule).
        ? { status: 'known', value: { reminder: reminderName, step: timing }, from: at }
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
