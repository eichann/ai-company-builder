/**
 * Plans of 「ブラウザ操作」 on the server (PR 6a; agent-browser.md "Plans, executions, permits and
 * locks"; internal design memo §30–§31): what a plan's facts must look like, the target lock key,
 * and the states of a plan and of its one execution. Pure; the server applies it.
 *
 * Facts (design memo §27.2, §30.6, §31.3) are what the app's checker read on the page — never the
 * AI's word. Each is `{ status: known | unknown, value?, complete?, readAt, source }`; unknown, an
 * empty list and 0 are three different answers. A plan is registered only when every fact its type
 * marks `required` is `known` with a value of its shape (one validator per fact and facts version,
 * here), and every fact marked `complete` was read whole (`complete === true`).
 */
import { canonicalJson } from './fixed-content'
import {
  BROWSER_ID_VALUE_RE, BROWSER_PATH_RE, isPlainBrowserText,
  type BrowserFieldKind, type BrowserOperation, type BrowserPlanValues,
} from './plugin-browser-declaration'

/** The facts version this build reads and writes (part of each approved combination). */
export const BROWSER_FACTS_VERSION = 1

export type BrowserFactStatus = 'known' | 'unknown'

/** One fact as the app registers it. */
export interface BrowserFact {
  status: BrowserFactStatus
  /** Present only when known. */
  value?: unknown
  /** True when the checker read every part of it (all pages, nothing cut). */
  complete?: boolean
  /** When it was read (ISO 8601, UTC). */
  readAt: string
  /** The path on the operated host it was read from. */
  source: string
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const isId = (v: unknown): v is string => typeof v === 'string' && BROWSER_ID_VALUE_RE.test(v)
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => own(v, k))

/** The fact's own shape (not its value), or why not. */
export function browserFactShapeProblem(raw: unknown): string | null {
  if (!isMap(raw)) return 'の形が正しくありません'
  const allowed = ['status', 'value', 'complete', 'readAt', 'source']
  if (Object.keys(raw).some(k => !allowed.includes(k))) return 'に知らない項目があります'
  if (raw.status !== 'known' && raw.status !== 'unknown') return 'の status は known か unknown です'
  if (raw.status === 'unknown' && own(raw, 'value')) return 'は読めていないのに値があります'
  if (own(raw, 'complete') && typeof raw.complete !== 'boolean') return 'の complete は true か false です'
  if (typeof raw.readAt !== 'string' || !ISO_RE.test(raw.readAt) || Number.isNaN(Date.parse(raw.readAt))) return 'の読んだ時刻が正しくありません'
  if (typeof raw.source !== 'string' || !BROWSER_PATH_RE.test(raw.source)) return 'の読み先が正しくありません'
  return null
}

/** One fact's value check: null when the value has the fact's shape. */
type ValueCheck = (value: unknown) => boolean

export interface BrowserFactSchema {
  /** Every fact this checker can read, with its value's shape. */
  facts: Record<string, ValueCheck>
  /**
   * Checks across facts and the plan's values (a fact that names the target must name the plan's
   * target), or null. Only facts present and known are given.
   */
  across(facts: Record<string, unknown>, values: BrowserPlanValues): string | null
}

const listOf = (check: (v: unknown) => boolean, max: number) => (v: unknown): boolean => Array.isArray(v) && v.length <= max && v.every(check)

/**
 * `lstep.reminder_step`, facts version 1 (design memo §31.3). Names and bodies are for showing only:
 * nothing here takes a name as evidence of where a step belongs (`step_parent` does that).
 */
const LSTEP_REMINDER_STEP_V1: BrowserFactSchema = {
  facts: {
    // The LINE account logged in.
    account: v => isMap(v) && exactKeys(v, ['id']) && isId(v.id),
    // Which reminder the step belongs to, as the page says.
    step_parent: v => isMap(v) && exactKeys(v, ['reminder']) && isId(v.reminder),
    // The templates on the step.
    state: v => isMap(v) && exactKeys(v, ['templates']) && listOf(isId, 200)(v.templates),
    names: v => isMap(v) && exactKeys(v, ['reminder', 'step']) && isPlainBrowserText(v.reminder, 200) && isPlainBrowserText(v.step, 200),
    // Each template's body, by its id.
    template_bodies: v => isMap(v) && Object.keys(v).length <= 200 && Object.entries(v).every(([k, body]) => isId(k) && isPlainBrowserText(body, 5000, true)),
    // The episodes (回) using this step / reminder.
    shared_with: v => isMap(v) && exactKeys(v, ['count', 'items']) && Number.isSafeInteger(v.count) && (v.count as number) >= 0
      && listOf(x => isPlainBrowserText(x, 200), 50)(v.items) && (v.count as number) >= (v.items as unknown[]).length,
  },
  across(facts, values) {
    const parent = facts.step_parent as { reminder: string } | undefined
    if (parent && parent.reminder !== values.target.reminder) return 'ページで読んだ段の所属が、計画のリマインダと違います'
    const bodies = facts.template_bodies as Record<string, string> | undefined
    if (bodies) {
      const needed = [...((facts.state as { templates: string[] } | undefined)?.templates ?? []), ...(own(values.change, 'template') ? [values.change.template] : [])]
      if (needed.some(id => !own(bodies, id))) return '足すテンプレートと、段に付いているテンプレートの本文がそろっていません'
    }
    return null
  },
}

/** Facts version → checker id → its schema. A version is never changed once released: a new shape is a new version. */
export const BROWSER_FACT_SCHEMAS: Readonly<Record<number, Readonly<Record<string, BrowserFactSchema>>>> = {
  1: { 'lstep.reminder_step': LSTEP_REMINDER_STEP_V1 },
}

/** The schema for a type's checker in a facts version, or null. */
export function browserFactSchema(factsVersion: number, checker: string): BrowserFactSchema | null {
  const byChecker = own(BROWSER_FACT_SCHEMAS, String(factsVersion)) ? BROWSER_FACT_SCHEMAS[factsVersion] : undefined
  return byChecker && own(byChecker, checker) ? byChecker[checker] : null
}

/** Why the type's declared facts cannot be read with this facts version (a declared fact the schema does not know), or null. */
export function browserFactsDeclarationProblem(operation: BrowserOperation, factsVersion: number): string | null {
  const schema = browserFactSchema(factsVersion, operation.checker)
  if (!schema) return `確かめる部品「${operation.checker}」の事実の形（版 ${factsVersion}）がありません`
  for (const name of Object.keys(operation.facts)) if (!own(schema.facts, name)) return `事実「${name}」の形（版 ${factsVersion}）がありません`
  if (operation.effect !== 'read' && !own(schema.facts, 'account')) return `確かめる部品「${operation.checker}」はアカウントを読みません`
  return null
}

/**
 * Why these facts cannot make a plan of this type (Japanese, for the person), or null (design memo
 * §31.3): only facts the type declares; each one's shape; every `required` fact present, known and of
 * its value's shape; every `complete` one read whole; the checks across facts and the plan's values.
 */
export function browserFactsProblem(operation: BrowserOperation, factsVersion: number, facts: unknown, values: BrowserPlanValues): string | null {
  const declared = browserFactsDeclarationProblem(operation, factsVersion)
  if (declared) return declared
  const schema = browserFactSchema(factsVersion, operation.checker) as BrowserFactSchema
  if (!isMap(facts)) return 'サイトから読み取った情報がありません'
  for (const name of Object.keys(facts)) if (!own(operation.facts, name)) return `「${name}」はこの操作で読む情報ではありません`
  const known: Record<string, unknown> = {}
  for (const [name, rule] of Object.entries(operation.facts)) {
    if (!own(facts, name)) {
      if (rule.required) return `「${name}」をサイトから読み取れていません`
      continue
    }
    const fact = facts[name]
    const shape = browserFactShapeProblem(fact)
    if (shape) return `「${name}」${shape}`
    const f = fact as unknown as BrowserFact
    if (f.status !== 'known') {
      if (rule.required) return `「${name}」をサイトから読み取れていません`
      continue
    }
    if (!own(f, 'value') || !schema.facts[name](f.value)) return `「${name}」の値の形が正しくありません`
    if (rule.complete && f.complete !== true) return `「${name}」を全部は読み取れていません`
    known[name] = f.value
  }
  return schema.across(known, values)
}

/** The outside account the facts name (the `account` fact's id), or null. */
export function browserFactsAccount(facts: unknown): string | null {
  if (!isMap(facts) || !isMap(facts.account) || facts.account.status !== 'known') return null
  const v = facts.account.value
  return isMap(v) && isId(v.id) ? v.id : null
}

/** The target's state the checker read (the `state` fact: named lists of ids), or null. */
export function browserFactsState(facts: unknown): Record<string, string[]> | null {
  if (!isMap(facts) || !isMap(facts.state) || facts.state.status !== 'known') return null
  const v = facts.state.value
  if (!isMap(v) || !Object.values(v).every(list => Array.isArray(list) && list.every(isId))) return null
  return Object.fromEntries(Object.entries(v).map(([k, list]) => [k, [...(list as string[])]]))
}

/**
 * The target lock key (design memo §30.5): the canonical JSON of a structured value — never a joined
 * string, so a text value cannot run into the next part — of the company, the operated host, the
 * outside account, the type's lock kind and the type's target fields with the plan's values, by name.
 * Built by the server from the approved declaration, never taken from the app. A text value is NFC
 * (canonicalJson); an id is as declared (`BROWSER_ID_VALUE_RE`). The type's version plays no part:
 * the same kind and fields give the same key across versions.
 */
export function browserLockKey(input: {
  company: string; host: string; account: string; kind: string
  fields: Readonly<Record<string, BrowserFieldKind>>; target: Readonly<Record<string, string>>
}): string {
  const names = Object.keys(input.fields).sort()
  return canonicalJson({
    company: input.company, host: input.host, account: input.account, kind: input.kind,
    fields: names.map(n => [n, input.target[n]]),
  })
}

/** A plan's states (`browser_plans`, design memo §30.3). */
export type BrowserPlanState = 'draft' | 'approved' | 'claimed' | 'closed' | 'done'
/** An execution's states (`browser_executions`, design memo §30.4 with §31.1–2). */
export type BrowserExecutionState = 'claimed' | 'permitted' | 'unknown' | 'succeeded' | 'failed' | 'confirmed_done' | 'confirmed_not_done' | 'void'
export const BROWSER_FINAL_EXECUTION_STATES: readonly BrowserExecutionState[] = ['succeeded', 'failed', 'confirmed_done', 'confirmed_not_done', 'void']
export const isFinalExecutionState = (s: BrowserExecutionState): boolean => BROWSER_FINAL_EXECUTION_STATES.includes(s)

/** What the app reports after a permit: sent and the page shows the plan (succeeded), stopped before sending (failed), or not known. */
export type BrowserReportResult = 'succeeded' | 'failed' | 'unknown'
export const BROWSER_REPORT_RESULTS: readonly BrowserReportResult[] = ['succeeded', 'failed', 'unknown']

/** The time contract (design memo §30.1, §29.3), in milliseconds. */
export const BROWSER_PLAN_TIMES = {
  /** A plan lives an hour from its creation (approval does not extend it). */
  planLifetime: 60 * 60_000,
  /** A claimed execution with no permit becomes void after this. */
  claimWithoutPermit: 2 * 60_000,
  /** A permit is good for this long (the app stops sending after it). */
  permit: 5_000,
  /** Beyond the permit, how long before a person may confirm (and a silent execution becomes unknown). */
  grace: 30_000,
  /** After this since the permit, an owner / admin may confirm in the member's place (§31.1). */
  adminConfirmAfter: 24 * 60 * 60_000,
  /** Facts read longer ago than this do not make a plan. */
  factsMaxAge: 10 * 60_000,
} as const
