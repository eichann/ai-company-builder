/**
 * Lステップ's reviewed adapter and its connector declaration, bundled with the app
 * (agent-browser.md "The runner"). The shelf still refuses browser connectors, so this
 * declaration does not come through it: it ships in the app, next to the adapter that reads for it.
 *
 * What the page shows (captured on test objects only, 2026-11-20):
 * - `GET /line/episode/show/<reminder>`: per message slot of a step
 *   `openModal(<reminder>, <step>, <hole>, <template id>, <type>)` — the 4th argument is the attached
 *   template; a step's block carries `templateStep<step>`.
 * - Adding a template to a step: `POST /line/episode/step/pack/template`, a form with
 *   `_token=<csrf>&_lm_user_id=<session>&content_id=<step>&template_id=<template>`; afterwards the
 *   step shows one more `openModal(...)` with that template and a new hole.
 *
 * NOT CONFIRMED on the real site: where the page names the logged-in LINE account in a stable way,
 * and exactly where `_token` / `_lm_user_id` sit in the page. The account is read by an injected
 * reader; the app's default reads nothing (`UNCONFIRMED_ACCOUNT`), so a real run stops before any
 * write ("account-unknown") until someone confirms the reader against the real page.
 */
import type { BrowserPlanValues } from '../../../shared/core/plugin-browser-declaration'
import type { BrowserAdapterView, BrowserOperationAdapter, BrowserPageRead, BrowserTargetState } from '../browser-runner'

export const LSTEP_ADD_TEMPLATE_ADAPTER = 'lstep.reminder_step_add_template'

/** The declaration (`plugins.md` "Browser connectors"): parsed and checked by the core like any package. */
export const LSTEP_DECLARATION = `id: lstep
version: 0.1.0
label: Lステップ
contract: 1
browser:
  host: manager.linestep.net
  asset_hosts: [d1nhtjid4lgi9y.cloudfront.net, profile.line-scdn.net]
  account:
    label: LINE アカウント
  operations:
    reminder_step_add_template:
      label: リマインダの段にテンプレートを足す
      effect: write
      adapter: ${LSTEP_ADD_TEMPLATE_ADAPTER}
      shared: 全部の回で共有のリマインダです。前の回の人にも届きます。
      target:
        reminder: id
        step: id
      change:
        template: id
      writes:
        - method: POST
          path: /line/episode/step/pack/template
          body: { content_id: "{step}", template_id: "{template}" }
          ignore_body: [_token, _lm_user_id]
`

/** Reads the logged-in outside account's id from the page (null: cannot tell). */
export type AccountReader = (html: string) => string | null

/** The app's reader until the real page's account marker is confirmed: never an account. */
export const UNCONFIRMED_ACCOUNT: AccountReader = () => null

/** Lステップ's ids are positive integers: never `0`, `-1` or anything a server could read as "all". */
const POSITIVE_ID = /^[1-9][0-9]{0,18}$/
/** A hidden field's value we pass on (a CSRF token, a session id): plain token characters only. */
const FIELD_VALUE = /^[A-Za-z0-9_\-.:=+/]{1,200}$/
const OPEN_MODAL = /openModal\(\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,/g

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

export function createLstepAddTemplateAdapter(readAccount: AccountReader): BrowserOperationAdapter {
  const ids = (values: BrowserPlanValues) => ({ reminder: values.target.reminder, step: values.target.step, template: values.change.template })
  return {
    id: LSTEP_ADD_TEMPLATE_ADAPTER,
    readPaths(values) {
      const { reminder } = ids(values)
      return POSITIVE_ID.test(reminder ?? '') ? [`/line/episode/show/${reminder}`] : []
    },
    view(values, reads: readonly BrowserPageRead[]): BrowserAdapterView {
      const { reminder, step, template } = ids(values)
      const page = reads.find(r => r.path === `/line/episode/show/${reminder}`)
      if (!page) return { account: null, state: null, ignored: {}, problem: 'not-read' }
      let account: string | null = null
      try { account = readAccount(page.body) } catch { account = null }
      const ignored: Record<string, string> = {}
      const token = fieldValue(page.body, '_token')
      const user = fieldValue(page.body, '_lm_user_id')
      if (token) ignored._token = token
      if (user) ignored._lm_user_id = user
      const problem = token ? undefined : 'csrf-missing'
      if (![reminder, step, template].every(v => POSITIVE_ID.test(v ?? ''))) return { account, state: null, ignored, problem }
      // The step is one of this reminder's: its block is on the reminder's page.
      if (!new RegExp(`templateStep${step}(?![0-9])`).test(page.body)) return { account, state: null, ignored, problem }
      const templates: string[] = []
      for (const m of page.body.matchAll(OPEN_MODAL)) {
        if (m[2] !== step) continue
        // A slot of this step under another reminder: the page is not what we think it is.
        if (m[1] !== reminder) return { account, state: null, ignored, problem }
        templates.push(m[4])
      }
      return { account, state: { templates: templates.sort() }, ignored, problem }
    },
    after(before: BrowserTargetState, values) {
      return { templates: [...(before.templates ?? []), ids(values).template].sort() }
    },
  }
}
