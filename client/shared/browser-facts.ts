/**
 * Reading a checker's facts for a plan (6b-2b; agent-browser.md "The facts a checker reads"): the
 * core's half. The checker (a site's reviewed code, `BrowserChecker.facts`) says which declared reads
 * to make and turns the answers into facts; this makes the reads — only reads the declaration's
 * `explore` declares, each address built by `explorePath` and handed to `read` (main's read session,
 * `exactRead` byte for byte) — parses each answer (HTML through the core's page view, JSON strictly),
 * and stamps every fact with when and where it was read. 6b-2c calls it to register a plan and again
 * right before the permit (`browserFactsChangedProblem`).
 *
 * Fail closed throughout: a read the declaration does not have, values it cannot build an address
 * from, more than `BROWSER_FACT_READS` reads, or a checker of another facts version end with no facts
 * (`problem`); a failed read is an answer `ok: false`, and a fact from it is never known, whatever the
 * checker says; a fact taken from a page whose view was not whole (an id or attribute written twice, a
 * hidden or ambiguous root) is `unknown` unless the checker read it from the raw markup by its run-time
 * rules (`rawMarkup`: the account, the target's state — what a run compares the page with); a read
 * already made is never made again; only declared facts are kept, and a declared one the checker gave
 * nothing for is `unknown`. Second layer kept on purpose: `exploreAddressProblem` on the address
 * `explorePath` built (the parser admits only such parts; `exactRead` checks it again).
 * The result is checked with `browserFactsProblem` (required / known / complete / shape / across).
 */
import { browserFactsProblem, type BrowserFact } from '../../shared/core/browser-plans'
import { explorePath, exploreAddressProblem, type BrowserOperation, type BrowserPlanValues, type PluginBrowser } from '../../shared/core/plugin-browser-declaration'
import { parseStrictJson } from './browser-json'
import { createPageView, type BrowserHtmlDocument } from './browser-page'
import type { BrowserChecker, BrowserFactAnswer, BrowserFactDraft, BrowserPreviewReader } from './browser-runner'

/** The most reads one reading of the facts makes (a folder scan included); more = no facts. */
export const BROWSER_FACT_READS = 50

export type BrowserFactsOutcome =
  | { facts: Record<string, BrowserFact>; problem: string | null; checkerProblem?: string }
  | { facts: null; problem: 'no-facts' | 'facts-version' | 'undeclared-read' | 'bad-address' | 'too-many-reads' | 'stop' }

export interface BrowserFactsInput {
  checker: BrowserChecker
  browser: PluginBrowser
  operation: BrowserOperation
  factsVersion: number
  values: BrowserPlanValues
  /** The connector's preview readers: a declared read's reader says whether its answer is HTML or JSON. */
  readers: readonly BrowserPreviewReader[]
  /** GET of exactly this address with the window's login; 'stop' = the request ended (context, cancel, time). */
  read(address: string): Promise<{ status: number; body: string } | 'failed' | 'stop'>
  parseHtml(text: string): BrowserHtmlDocument
  now(): Date
}

const sameRequest = (a: { read: string; values: Readonly<Record<string, string>>; page?: number }, b: typeof a): boolean =>
  a.read === b.read && (a.page ?? 1) === (b.page ?? 1)
  && Object.keys(a.values).length === Object.keys(b.values).length && Object.entries(a.values).every(([k, v]) => b.values[k] === v)

export async function readBrowserFacts(input: BrowserFactsInput): Promise<BrowserFactsOutcome> {
  const reader = input.checker.facts
  if (!reader) return { facts: null, problem: 'no-facts' }
  if (reader.version !== input.factsVersion) return { facts: null, problem: 'facts-version' }
  const answers: BrowserFactAnswer[] = []
  const meta: Array<{ path: string; readAt: string; whole: () => boolean }> = []
  for (;;) {
    let wanted
    try { wanted = reader.next(input.values, answers) } catch { return { facts: null, problem: 'no-facts' } }
    // Only what was not read yet: a checker asking again for the same read would loop.
    const fresh = wanted.filter(w => !answers.some(a => sameRequest(a, w)))
    if (fresh.length === 0) break
    for (const want of fresh) {
      const declared = Object.prototype.hasOwnProperty.call(input.browser.explore, want.read) ? input.browser.explore[want.read] : undefined
      if (!declared) return { facts: null, problem: 'undeclared-read' }
      const address = explorePath(declared, { ...want.values }, want.page)
      if (!address || exploreAddressProblem(address)) return { facts: null, problem: 'bad-address' }
      if (answers.length >= BROWSER_FACT_READS) return { facts: null, problem: 'too-many-reads' }
      const kind = input.readers.find(r => r.id === declared.reader)
      if (!kind) return { facts: null, problem: 'undeclared-read' }
      const got = await input.read(address)
      if (got === 'stop') return { facts: null, problem: 'stop' }
      const request = { read: want.read, values: { ...want.values }, ...(want.page !== undefined ? { page: want.page } : {}) }
      const at = { path: address.split('?')[0], readAt: input.now().toISOString() }
      if (got === 'failed' || got.status !== 200) {
        answers.push({ ...request, ok: false })
        meta.push({ ...at, whole: () => false })
      } else if ('answer' in kind && kind.answer === 'json') {
        const parsed = parseStrictJson(got.body)
        answers.push(parsed ? { ...request, ok: true, kind: 'json', json: parsed.value } : { ...request, ok: false })
        // A JSON answer has no view: parsed strictly, or `ok: false` (never known).
        meta.push({ ...at, whole: () => true })
      } else {
        let page: ReturnType<typeof createPageView> | null = null
        try { page = createPageView(input.parseHtml(got.body)) } catch { page = null }
        answers.push(page ? { ...request, ok: true, kind: 'html', body: got.body, view: page.view } : { ...request, ok: false })
        meta.push({ ...at, whole: page ? page.complete : () => false })
      }
    }
  }
  if (answers.length === 0) return { facts: null, problem: 'no-facts' }
  let drafts: Record<string, BrowserFactDraft>
  let checkerProblem: string | undefined
  try {
    const out = reader.read(input.values, answers)
    drafts = out.facts
    checkerProblem = out.problem
  } catch { return { facts: null, problem: 'no-facts' } }
  const facts: Record<string, BrowserFact> = {}
  for (const name of Object.keys(input.operation.facts)) {
    const draft = Object.prototype.hasOwnProperty.call(drafts, name) ? drafts[name] : undefined
    const from = draft && Number.isInteger(draft.from) && draft.from >= 0 && draft.from < answers.length ? draft.from : 0
    const { path, readAt, whole } = meta[from]
    // A fact from a page whose view was not whole (checked after the checker read it) is not known,
    // unless the checker read it from the raw markup by its run-time rules (`rawMarkup`); a fact from
    // an answer that failed is never known.
    const known = draft?.status === 'known' && draft.value !== undefined && answers[from].ok && (whole() || draft.rawMarkup === true)
    facts[name] = known
      ? { status: 'known', value: draft.value, ...(draft.complete !== undefined ? { complete: draft.complete } : {}), readAt, source: path }
      : { status: 'unknown', readAt, source: path }
  }
  return { facts, problem: browserFactsProblem(input.operation, input.factsVersion, facts, input.values), ...(checkerProblem ? { checkerProblem } : {}) }
}
