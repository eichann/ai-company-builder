/**
 * Lステップ's checker of a reminder's step (agent-browser.md "The checker", design memo §24): it
 * confirms only what the site's request does not carry — the step is one of the planned reminder's
 * (the request names the step alone), the logged-in LINE account, the step's templates before and
 * after — and reads the CSRF / session values. Every operation on a step's templates uses it; what
 * the step must show afterwards is the operation's `expect` in the declaration (./declaration.ts).
 *
 * What the page shows (captured on test objects only, 2026-11-20):
 * - `GET /line/episode/show/<reminder>`: per message slot of a step
 *   `openModal(<reminder>, <step>, <hole>, <template id>, <type>)` — the 4th argument is the attached
 *   template; a step's block carries `templateStep<step>`.
 *
 * NOT CONFIRMED on the real site: where the page names the logged-in LINE account in a stable way,
 * and exactly where `_token` / `_lm_user_id` sit in the page. The account is read by an injected
 * reader; the default reads nothing (`UNCONFIRMED_ACCOUNT`), so a real run stops before any write
 * ("account-unknown") until someone confirms the reader against the real page.
 *
 * Site code: imported only by the composition root (and tests), never by the core
 * (architecture-boundaries.test.ts 「the browser core knows no site」).
 */
import type { BrowserPlanValues } from '../../../shared/core/plugin-browser-declaration'
import type { BrowserChecker, BrowserCheckerView, BrowserPageRead } from '../../shared/browser-runner'

export const LSTEP_REMINDER_STEP_CHECKER = 'lstep.reminder_step'

/** Reads the logged-in outside account's id from the page (null: cannot tell). */
export type AccountReader = (html: string) => string | null

/** The app's reader until the real page's account marker is confirmed: never an account. */
export const UNCONFIRMED_ACCOUNT: AccountReader = () => null

/** Lステップ's ids are positive integers: never `0`, `-1` or anything a server could read as "all". */
const POSITIVE_ID = /^[1-9][0-9]{0,18}$/
/** A hidden field's value we pass on (a CSRF token, a session id): plain token characters only. */
const FIELD_VALUE = /^[A-Za-z0-9_\-.:=+/]{1,200}$/
const OPEN_MODAL = /openModal\(\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,/g

/** The page without what is not markup: scripts, text areas and comments (an id or a call written there is not the page). */
export function markupOnly(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<textarea\b[\s\S]*?(?:<\/textarea\s*>|$)/gi, ' ')
}

/** Where `id="templateStep<step>"` stands as an attribute of a tag (every one). */
function stepBoxStarts(markup: string, step: string): number[] {
  const starts: number[] = []
  const re = new RegExp(`<[a-z][a-z0-9-]*\\b[^<>]*?\\sid\\s*=\\s*(["'])templateStep${step}\\1[^<>]*>`, 'gi')
  for (const m of markup.matchAll(re)) starts.push(m.index ?? 0)
  return starts
}

/** The start of every step's box (`id="templateStep<n>"` as an attribute), in order. */
function allBoxStarts(markup: string): number[] {
  return [...markup.matchAll(/<[a-z][a-z0-9-]*\b[^<>]*?\sid\s*=\s*(["'])templateStep[0-9]+\1[^<>]*>/gi)].map(m => m.index ?? 0)
}

function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? (m[1] ?? m[2]) : null
}

/** The one value of a hidden field (or meta) named `name`; two different values = none (ambiguous). */
function fieldValue(html: string, name: string): string | null {
  const found = new Set<string>()
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    if (attribute(tag, 'name') === name) {
      const v = attribute(tag, 'value')
      if (v !== null) found.add(v)
    }
  }
  if (name === '_token') {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      if (attribute(tag, 'name') === 'csrf-token') {
        const v = attribute(tag, 'content')
        if (v !== null) found.add(v)
      }
    }
  }
  if (found.size !== 1) return null
  const [v] = [...found]
  return FIELD_VALUE.test(v) ? v : null
}

export function createLstepReminderStepChecker(readAccount: AccountReader): BrowserChecker {
  const ids = (values: BrowserPlanValues) => ({ reminder: values.target.reminder, step: values.target.step })
  return {
    id: LSTEP_REMINDER_STEP_CHECKER,
    // The write names the step only; the reminder is confirmed here: the step's box is on the reminder's page.
    confirms: ['reminder', 'step'],
    readPaths(values) {
      const { reminder } = ids(values)
      return POSITIVE_ID.test(reminder ?? '') ? [`/line/episode/show/${reminder}`] : []
    },
    view(values, reads: readonly BrowserPageRead[]): BrowserCheckerView {
      const { reminder, step } = ids(values)
      const page = reads.find(r => r.path === `/line/episode/show/${reminder}`)
      if (!page) return { account: null, state: null, ignored: {}, problem: 'not-read' }
      let account: string | null = null
      try { account = readAccount(page.body) } catch { account = null }
      const markup = markupOnly(page.body)
      const ignored: Record<string, string> = {}
      const token = fieldValue(markup, '_token')
      const user = fieldValue(markup, '_lm_user_id')
      if (token) ignored._token = token
      if (user) ignored._lm_user_id = user
      const problem = token ? undefined : 'csrf-missing'
      const none = { account, state: null, ignored, problem }
      // Every id of the plan — each target field (a later type's `hole` too) and each change field —
      // is a positive integer: never `0`, `-1` or "all", whichever operation uses this checker.
      if (![reminder, step, ...Object.values(values.target), ...Object.values(values.change)].every(v => POSITIVE_ID.test(v ?? ''))) return none
      // The step is one of this reminder's: its box (`id="templateStep<step>"`, exactly once, as an
      // attribute in the markup) is on the reminder's page.
      const starts = stepBoxStarts(markup, step)
      if (starts.length !== 1) return none
      const start = starts[0]
      const end = allBoxStarts(markup).find(i => i > start) ?? markup.length
      const templates: string[] = []
      for (const m of markup.matchAll(OPEN_MODAL)) {
        const at = m.index ?? 0
        const inBox = at > start && at < end
        // Every slot in the box is this reminder's and this step's; a slot of the step elsewhere is not
        // what we think the page is.
        if (inBox && (m[1] !== reminder || m[2] !== step)) return none
        if (!inBox && m[2] === step) return none
        if (inBox) templates.push(m[4])
      }
      return { account, state: { templates: templates.sort() }, ignored, problem }
    },
  }
}
