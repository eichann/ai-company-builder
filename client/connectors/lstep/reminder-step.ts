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
 * - Every page carries the logged-in LINE account as `<meta name="lm-account-id" content="<id>">`
 *   (confirmed on the real site with the owner's login, 2026-11-22, design memo §34: another
 *   account's objects answer 404). `accountFromMeta` reads it; none, or two different values, is no
 *   account (the run stops before any write, "account-unknown").
 *
 * - The real page's rows of a step's attached templates (design memo §39–§41; §41 = the raw page as the
 *   server sends it, no scripts run — what main reads): a table in `#template_confirm_<step>`, **outside**
 *   `templateStep<step>` (which there holds only the 「テンプレートから追加」 form), one row per attached
 *   template: `<tr><th><small>#N</small></th><td>テンプレート <name> …</td><td><button
 *   @click="openModal(<reminder>, <step>, <hole>, <template id>, <form type>)">編集</button></td><td>` and a
 *   delete form `POST /line/episode/step/pack` with hidden `_method=DELETE`, `hole_id=<hole>`,
 *   `content_id=<step>`. The page's inline script defines `openModal(episodeId, packId, holeId, eggId,
 *   eggFormType)`: the 4th argument is the attached template's id (8 = text). (The rendered page loses the
 *   `@click` attribute — Vue consumes it — which is why §40's rendered capture showed no id.) The checker
 *   reads each row (`stepTable`): exactly one `openModal(…)` naming this reminder and this step, with a
 *   positive hole and template id, and exactly one delete form of this step whose `hole_id` is that
 *   hole; the footer row (no header cell) holds neither; any other shape → no target. Element ids play
 *   no part (the page repeats them on every row). Nothing else of the page is read (it also carries
 *   account-wide counts in Vue props: never read).

 * The facts for a plan (facts version 2, 6b-2b) are read by ./reminder-step-facts.ts, which takes the
 * account and the step's state from this checker's `view`.
 *
 * Site code: imported only by the composition root (and tests), never by the core
 * (architecture-boundaries.test.ts 「the browser core knows no site」).
 */
import type { BrowserPlanValues } from '../../../shared/core/plugin-browser-declaration'
import type { BrowserChecker, BrowserCheckerView, BrowserPageRead } from '../../shared/browser-runner'
import { createLstepReminderStepFacts } from './reminder-step-facts'

export const LSTEP_REMINDER_STEP_CHECKER = 'lstep.reminder_step'

/** Reads the logged-in outside account's id from the page (null: cannot tell). */
export type AccountReader = (html: string) => string | null

/**
 * The start tags of real markup, each whole: an attribute value that spells a tag (`title='<meta …>'`)
 * stays inside its own tag, and what `<style>`, `<noscript>` and `<template>` hold (besides scripts,
 * text areas and comments, `markupOnly`) is not markup a person sees.
 */
function startTags(html: string): string[] {
  const markup = markupOnly(html).replace(/<(style|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
  const tags: string[] = []
  let at = 0
  while (at < markup.length) {
    const open = markup.indexOf('<', at)
    if (open < 0) break
    if (!/[A-Za-z]/.test(markup[open + 1] ?? '')) { at = open + 1; continue }
    let end = open + 1
    let quote: string | null = null
    for (; end < markup.length; end++) {
      const c = markup[end]
      if (quote) { if (c === quote) quote = null } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    tags.push(markup.slice(open, end + 1))
    at = end + 1
  }
  return tags
}

/**
 * The LINE account from the page's `<meta name="lm-account-id" content="…">`, in real markup only
 * (`startTags`): exactly one value, a positive integer, else null (missing, two different values,
 * anything else).
 */
export const accountFromMeta: AccountReader = html => {
  const found = new Set<string>()
  for (const tag of startTags(html).filter(t => /^<meta\b/i.test(t))) {
    if (attribute(tag, 'name')?.toLowerCase() !== 'lm-account-id') continue
    const value = attribute(tag, 'content')
    found.add(value === null ? '' : value.trim())
  }
  if (found.size !== 1) return null
  const [value] = [...found]
  return POSITIVE_ID.test(value) ? value : null
}

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

/** The start of every step's attached-template table (`id="template_confirm_<n>"` as an attribute). */
function allTableStarts(markup: string): number[] {
  return [...markup.matchAll(/<[a-z][a-z0-9-]*\b[^<>]*?\sid\s*=\s*(["'])template_confirm_[0-9]+\1[^<>]*>/gi)].map(m => m.index ?? 0)
}

/** The start of every step's box (`id="templateStep<n>"` as an attribute), in order. */
function allBoxStarts(markup: string): number[] {
  return [...markup.matchAll(/<[a-z][a-z0-9-]*\b[^<>]*?\sid\s*=\s*(["'])templateStep[0-9]+\1[^<>]*>/gi)].map(m => m.index ?? 0)
}

function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? (m[1] ?? m[2]) : null
}

const DELETE_FORM_PATH = '/line/episode/step/pack'

/**
 * The slots (`hole_id`) of this step's attached-template rows, failing closed (null: the page is not
 * what we think):
 * - every `<form` start tag must open a form closed before the next one opens (an unclosed or nested one
 *   leaves more start tags than closed forms);
 * - every form whose action mentions `episode/step/pack` must have, once the origin is removed, exactly
 *   the path `/line/episode/step/pack` (a row's delete form) or `/line/episode/step/pack/template` (the
 *   add form) — a trailing slash, a query, a relative path or anything else → null;
 * - a delete form has exactly one `content_id`, a positive id as written (padded → null); when it is the
 *   step: exactly one positive `hole_id` and `_method` `DELETE`, and no hole twice; another step's form is
 *   left alone.
 * Element ids play no part (the page repeats them on every row).
 */
export function stepHoles(markup: string, step: string): string[] | null {
  const holes: string[] = []
  const forms = [...markup.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)]
  if (forms.length !== (markup.match(/<form\b/gi) ?? []).length) return null
  for (const m of forms) {
    const tag = /^<form\b[^>]*>/i.exec(m[0])?.[0] ?? ''
    const rawAction = attribute(tag, 'action') ?? ''
    if (!/episode\/step\/pack/i.test(rawAction)) continue
    const action = rawAction.replace(/^https?:\/\/[^/?#]+/i, '')
    if (action === `${DELETE_FORM_PATH}/template`) continue
    if (action !== DELETE_FORM_PATH) return null
    const inputs = (name: string) => (m[0].match(/<input\b[^>]*>/gi) ?? []).filter(t => attribute(t, 'name') === name).map(t => attribute(t, 'value'))
    const content = inputs('content_id')
    if (content.length !== 1 || !POSITIVE_ID.test(content[0] ?? '')) return null
    if (content[0] !== step) continue
    const hole = inputs('hole_id')
    const method = inputs('_method')
    if (hole.length !== 1 || !POSITIVE_ID.test(hole[0] ?? '') || method.length !== 1 || (method[0] ?? '').toUpperCase() !== 'DELETE') return null
    if (holes.includes(hole[0] as string)) return null
    holes.push(hole[0] as string)
  }
  return holes
}

/**
 * This step's attached-template table (`#template_confirm_<step>`, design memo §41) from its tag to the
 * step's box: the template id of each row and where the table stands. undefined: no such table; null:
 * not the shape seen — the table twice or after the box; a row with a header cell (「#N」) without exactly
 * one `openModal(<reminder>, <step>, <hole>, <template>, …)` (positive ids) and exactly one delete form of
 * this step with that hole; a row without a header cell holding a call or a delete form of this step; a
 * call outside the rows.
 */
export function stepTable(markup: string, reminder: string, step: string, boxStart: number): { templates: string[]; start: number; end: number } | null | undefined {
  const at = [...markup.matchAll(new RegExp(`<[a-z][a-z0-9-]*\\b[^<>]*?\\sid\\s*=\\s*(["'])template_confirm_${step}\\1[^<>]*>`, 'gi'))].map(m => m.index ?? 0)
  if (at.length === 0) return undefined
  if (at.length !== 1 || at[0] > boxStart) return null
  const region = markup.slice(at[0], boxStart)
  const templates: string[] = []
  let calls = 0
  for (const m of region.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi)) {
    const row = m[0]
    const found = [...row.matchAll(OPEN_MODAL)]
    calls += found.length
    const holes = stepHoles(row, step)
    if (holes === null) return null
    if (!/<th\b/i.test(row)) {
      if (found.length > 0 || holes.length > 0) return null
      continue
    }
    if (found.length !== 1) return null
    const [, r, st, hole, template] = found[0]
    // The hole needs no check of its own: it must equal the row's delete form's, a positive id (stepHoles).
    if (r !== reminder || st !== step || !POSITIVE_ID.test(template)) return null
    if (holes.length !== 1 || holes[0] !== hole) return null
    templates.push(template)
  }
  // Every call in the table stands in one of its rows.
  if ([...region.matchAll(OPEN_MODAL)].length !== calls) return null
  return { templates, start: at[0], end: boxStart }
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
  const checker: BrowserChecker = {
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
      // The box ends at the next step's box or the next step's table, whichever comes first (the real page
      // puts each step's table before its box, so the next step's table follows this box).
      const end = [...allBoxStarts(markup), ...allTableStarts(markup)].filter(i => i > start).sort((x, y) => x - y)[0] ?? markup.length
      // The step's attached templates: the rows of its table (the real page, design memo §41), each read
      // whole, and the slots in its box (the 11/20 capture's shape).
      const table = stepTable(markup, reminder, step, start)
      if (table === null) return none
      const templates: string[] = table ? [...table.templates] : []
      for (const m of markup.matchAll(OPEN_MODAL)) {
        const at = m.index ?? 0
        if (table && at >= table.start && at < table.end) continue
        const inBox = at > start && at < end
        // Every slot in the box is this reminder's and this step's; a slot of the step elsewhere is not
        // what we think the page is.
        if (inBox && (m[1] !== reminder || m[2] !== step)) return none
        if (!inBox && m[2] === step) return none
        if (inBox) templates.push(m[4])
      }
      // Every delete form of this step is a row of its table (one elsewhere: not what we think).
      const holes = stepHoles(markup, step)
      if (holes === null || holes.length !== (table ? table.templates.length : 0)) return none
      return { account, state: { templates: templates.sort() }, ignored, problem }
    },
  }
  // The facts for a plan (6b-2b) read the account and the step's state with this same `view`: what the
  // person approves as `before` is exactly what the run compares the page with.
  return { ...checker, facts: createLstepReminderStepFacts(checker.view) }
}
