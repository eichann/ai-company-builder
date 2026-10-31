/**
 * The fake HubSpot (「練習用の HubSpot」, milestone 3 design §3): a small Hono
 * app with the data in memory that answers the CRM API calls the HubSpot
 * plugin makes, in the shapes of HubSpot's public documentation. Used by the
 * server tests (passed straight in) and on the staging server
 * (`pnpm fake:hubspot`, `serve.ts`).
 *
 * Test and staging code only: it lives under `server/tests/`, which the
 * production image never copies (server/Dockerfile copies `server/src` and
 * `shared`), and nothing in `server/src` may import it
 * (`tests/unit/layering.test.ts`).
 *
 * Paths: both the v3 form (`/crm/v3/objects/deals/{id}`) and the dated form
 * (`/crm/objects/2026-03/deals/{id}`, `/crm/properties/2026-03/deals`,
 * `/crm/pipelines/2026-03/deals`) reach the same handler.
 *
 * Only what the plugin uses: deals (list, get, search, update, create,
 * archive), deal properties and pipelines, companies (get) and deal → company
 * / contact associations, contacts (get), owners (list), notes (create with
 * an association, get, archive), meetings (create with the 212 meeting → deal
 * association, get, search, archive — milestone 4's `log_meeting`), and the
 * account details (`/account-info/v3/details` or a dated version: the portal
 * id, which tells the fake and the real HubSpot — or two accounts — apart).
 *
 * The matching mark (milestone 4 design §3-6, §4-4): deals and meetings have a
 * custom unique-value property `acb_operation_id`. A second live object with
 * the same value is a 409 CONFLICT; `GET …/{value}?idProperty=acb_operation_id`
 * finds one at once, while search does not see a new object until the
 * indexing delay (`searchIndexDelayMs`; HubSpot: new objects may take a few
 * moments to appear in search) has passed. Which scope creating a meeting
 * needs is not documented (design §5-4, unverified): `meetingScopes` sets it,
 * default the deals scopes as anken-sync assumes.
 *
 * Keys: `Authorization: Bearer pat-fake-…` only, each with its own scopes; a
 * missing scope answers HubSpot's 403 MISSING_SCOPES. Rate limits (100 per
 * 10 s per key, search 5 per second) can be turned on. Faults for tests:
 * delays, 500s, a write applied whose answer never arrives, and a change made
 * "by someone in HubSpot".
 */
import { Hono, type Context } from 'hono'
import { defaultSeed, type Seed } from './seed'

export const FAKE_HUBSPOT_KEY_PREFIX = 'pat-fake-'

export const HUBSPOT_SCOPES = {
  dealsRead: 'crm.objects.deals.read',
  dealsWrite: 'crm.objects.deals.write',
  dealSchemasRead: 'crm.schemas.deals.read',
  companiesRead: 'crm.objects.companies.read',
  ownersRead: 'crm.objects.owners.read',
  contactsRead: 'crm.objects.contacts.read',
  contactsWrite: 'crm.objects.contacts.write',
} as const

/** The four scopes the design asks a key for (§4-2), without the note scopes. */
export const PLUGIN_BASE_SCOPES = [
  HUBSPOT_SCOPES.dealsRead, HUBSPOT_SCOPES.dealsWrite, HUBSPOT_SCOPES.companiesRead, HUBSPOT_SCOPES.ownersRead,
]
/** Every scope the fake knows (notes too). */
export const ALL_FAKE_SCOPES = Object.values(HUBSPOT_SCOPES)

/** HubSpot's association type ids (associations v4 guide): note → deal 214, note → company 190. */
export const NOTE_TO_DEAL = 214
export const NOTE_TO_COMPANY = 190
/** Meeting → deal 212, meeting → contact 200; deal → company 5, deal → contact 3. */
export const MEETING_TO_DEAL = 212
export const MEETING_TO_CONTACT = 200
export const DEAL_TO_COMPANY = 5
export const DEAL_TO_CONTACT = 3

/** The custom unique-value property ACB writes on what it creates (the owner makes it in HubSpot). */
export const OPERATION_ID_PROPERTY = 'acb_operation_id'

export interface RateLimitOptions {
  /** Requests per key per 10 seconds (HubSpot Free / Starter: 100). */
  perTenSeconds?: number
  /** Search requests per second (HubSpot: 5). */
  searchPerSecond?: number
}

export interface FakeHubSpotOptions {
  seed?: Seed
  /** Milliseconds since the epoch; tests pass their own clock. */
  now?: () => number
  /** Rate limits; omitted = none. `true` = HubSpot's numbers. */
  rateLimits?: RateLimitOptions | true
  /** Serve `/__fake/*` (faults and outside changes over HTTP, for the staging CLI). Off by default. */
  controlRoutes?: boolean
  /** The account's portal id (`GET /account-info/…/details`); another fake = another account. Default 90000001. */
  portalId?: number
  /** A created deal or meeting is missing from search for this long (HubSpot's indexing delay). Default 0. */
  searchIndexDelayMs?: number
  /** Scopes (any one of) for reading and for creating / archiving meetings. Default: the deals read / write scopes. */
  meetingScopes?: { read?: string[]; write?: string[] }
}

interface StoredObject {
  id: string
  properties: Record<string, string | null>
  createdAt: number
  updatedAt: number
  archived: boolean
  /** From this time on, search finds it. */
  indexedAt: number
}

interface Deal extends StoredObject {
  companyIds: string[]
  contactIds: string[]
  /** hs_deal_stage_probability was written by hand: the stage no longer sets it (as in HubSpot). */
  probabilityOverridden: boolean
}

interface Note extends StoredObject {
  dealIds: string[]
  companyIds: string[]
}

interface Meeting extends StoredObject {
  dealIds: string[]
  contactIds: string[]
}

export interface FakeRequestLog {
  method: string
  path: string
  status: number
}

export interface FakeHubSpot {
  /** The Hono app: `app.fetch` to serve it, `app.request` in tests. */
  app: Hono
  /** Adds (or replaces) a key; returns it. Default scopes: every scope the fake knows. */
  addKey(key: string, scopes?: readonly string[]): string
  /** Changes a key's scopes. */
  setScopes(key: string, scopes: readonly string[]): void
  removeKey(key: string): void
  /** The current properties of a deal (null when unknown); for tests' assertions. */
  deal(id: string): { properties: Record<string, string | null>; updatedAt: string; archived: boolean } | null
  note(id: string): { properties: Record<string, string | null>; archived: boolean; dealIds: string[] } | null
  meeting(id: string): { properties: Record<string, string | null>; archived: boolean; dealIds: string[]; contactIds: string[] } | null
  /** Every object (archived ones too) carrying this `acb_operation_id`: "was it created, and how often?". */
  withOperationId(value: string): { type: 'deals' | 'meetings'; id: string; archived: boolean }[]
  /** Changes the indexing delay for objects created from now on. */
  setSearchIndexDelay(ms: number): void
  /** Someone in HubSpot changes a deal (the design's §2-4 case): bumps hs_lastmodifieddate. */
  changeDealOutside(id: string, properties: Record<string, string>): void
  faults: FakeFaults
  /** Every request answered (method, path without query, status), in order. */
  requests: FakeRequestLog[]
  /** Releases every request held by `dropAnswerAfterWrite` (so a test can end cleanly). */
  close(): void
}

export interface FakeFaults {
  /** Delay every answer by this many milliseconds (0 = none). */
  delayMs: number
  /** The next `count` requests answer `status` (default 500) without doing anything. */
  failNext(count?: number, status?: number): void
  /** The next `count` writes (PATCH, POST, DELETE) answer `status` (default 500) without doing anything; reads pass. */
  failNextWrite(count?: number, status?: number): void
  /**
   * The next `count` writes (PATCH, POST, DELETE) are applied and then never
   * answered: over a real socket the connection is cut; through `app.fetch`
   * the promise stays pending until `close()`. 「届いたか分からない」.
   */
  dropAnswerAfterWrite(count?: number): void
  reset(): void
}

/** Built-in deal properties (HubSpot's defaults the plugin uses) plus div's custom 受注確度. */
interface PropertyDef {
  name: string
  label: string
  type: 'string' | 'number' | 'datetime' | 'date' | 'enumeration' | 'bool'
  fieldType: string
  groupName: string
  description: string
  options?: { label: string; value: string }[]
  calculated: boolean
  readOnlyValue: boolean
  hubspotDefined: boolean
  /** "Unique value" custom property (hasUniqueValue): one object per value, usable as idProperty. */
  unique?: boolean
}

const STAGES = [
  { id: 'appointmentscheduled', label: 'Appointment Scheduled', probability: '0.2', isClosed: false },
  { id: 'qualifiedtobuy', label: 'Qualified To Buy', probability: '0.4', isClosed: false },
  { id: 'presentationscheduled', label: 'Presentation Scheduled', probability: '0.6', isClosed: false },
  { id: 'decisionmakerboughtin', label: 'Decision Maker Bought-In', probability: '0.8', isClosed: false },
  { id: 'contractsent', label: 'Contract Sent', probability: '0.9', isClosed: false },
  { id: 'closedwon', label: 'Closed Won', probability: '1.0', isClosed: true },
  { id: 'closedlost', label: 'Closed Lost', probability: '0.0', isClosed: true },
] as const

const DEAL_PROPERTIES: PropertyDef[] = [
  { name: 'dealname', label: 'Deal Name', type: 'string', fieldType: 'text', groupName: 'dealinformation', description: 'The name given to this deal.', calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'pipeline', label: 'Pipeline', type: 'enumeration', fieldType: 'select', groupName: 'dealinformation', description: 'The pipeline the deal is in.', options: [{ label: 'Sales Pipeline', value: 'default' }], calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'dealstage', label: 'Deal Stage', type: 'enumeration', fieldType: 'radio', groupName: 'dealinformation', description: 'The stage of the deal.', options: STAGES.map(s => ({ label: s.label, value: s.id })), calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'amount', label: 'Amount', type: 'number', fieldType: 'number', groupName: 'dealinformation', description: 'The total amount of the deal.', calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'closedate', label: 'Close Date', type: 'datetime', fieldType: 'date', groupName: 'dealinformation', description: 'Date the deal was closed. Set automatically by HubSpot.', calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'hubspot_owner_id', label: 'Deal owner', type: 'enumeration', fieldType: 'select', groupName: 'dealinformation', description: 'The owner of the deal.', options: [], calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'hs_next_step', label: 'Next step', type: 'string', fieldType: 'textarea', groupName: 'dealinformation', description: 'A short description of the next step.', calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'description', label: 'Deal Description', type: 'string', fieldType: 'textarea', groupName: 'dealinformation', description: 'Description of the deal.', calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'hs_forecast_probability', label: 'Forecast probability', type: 'number', fieldType: 'number', groupName: 'dealinformation', description: 'The probability a deal will close, set by the owner.', calculated: false, readOnlyValue: false, hubspotDefined: true },
  // Set from the stage; writable, but a written value stops the stage from setting it (knowledge base).
  { name: 'hs_deal_stage_probability', label: 'Deal probability', type: 'number', fieldType: 'number', groupName: 'dealinformation', description: 'The probability a deal will close. Defaults to the deal stage probability setting.', calculated: false, readOnlyValue: false, hubspotDefined: true },
  { name: 'hs_is_closed_won', label: 'Is Closed Won', type: 'bool', fieldType: 'booleancheckbox', groupName: 'dealinformation', description: 'True if the deal is in the closed won state.', options: [{ label: 'True', value: 'true' }, { label: 'False', value: 'false' }], calculated: true, readOnlyValue: true, hubspotDefined: true },
  { name: 'hs_is_closed', label: 'Is Deal Closed?', type: 'bool', fieldType: 'booleancheckbox', groupName: 'dealinformation', description: 'True if the deal is closed.', options: [{ label: 'True', value: 'true' }, { label: 'False', value: 'false' }], calculated: true, readOnlyValue: true, hubspotDefined: true },
  { name: 'createdate', label: 'Create Date', type: 'datetime', fieldType: 'date', groupName: 'dealinformation', description: 'Date the deal was created.', calculated: false, readOnlyValue: true, hubspotDefined: true },
  { name: 'hs_lastmodifieddate', label: 'Last Modified Date', type: 'datetime', fieldType: 'date', groupName: 'dealinformation', description: 'Most recent timestamp of any property update for this deal.', calculated: false, readOnlyValue: true, hubspotDefined: true },
  { name: 'hs_object_id', label: 'Record ID', type: 'number', fieldType: 'number', groupName: 'dealinformation', description: 'The unique ID for this record. Set automatically by HubSpot.', calculated: false, readOnlyValue: true, hubspotDefined: true },
  // div's custom property 「受注確度」 (design §1-5).
  { name: 'juchu_kakudo', label: '受注確度', type: 'enumeration', fieldType: 'select', groupName: 'dealinformation', description: '', options: [{ label: '高', value: 'high' }, { label: '中', value: 'medium' }, { label: '低', value: 'low' }], calculated: false, readOnlyValue: false, hubspotDefined: false },
  // ACB's matching mark (milestone 4 design §3-6), made by the owner with "unique value" on.
  { name: OPERATION_ID_PROPERTY, label: 'ACB 操作番号', type: 'string', fieldType: 'text', groupName: 'dealinformation', description: '', calculated: false, readOnlyValue: false, hubspotDefined: false, unique: true },
]
const DEAL_PROPERTY = new Map(DEAL_PROPERTIES.map(p => [p.name, p]))
/** What GET returns without `properties` (HubSpot's default set for deals). */
const DEAL_DEFAULT_PROPERTIES = ['amount', 'closedate', 'createdate', 'dealname', 'dealstage', 'hs_lastmodifieddate', 'hs_object_id', 'pipeline']
const DEAL_ALWAYS = ['createdate', 'hs_lastmodifieddate', 'hs_object_id']
const COMPANY_DEFAULT_PROPERTIES = ['createdate', 'domain', 'hs_lastmodifieddate', 'hs_object_id', 'name']
const NOTE_PROPERTIES = new Set(['hs_timestamp', 'hs_note_body', 'hubspot_owner_id'])
/** Meeting properties (meetings guide) plus the custom matching mark. */
const MEETING_PROPERTIES = new Set(['hs_timestamp', 'hs_meeting_title', 'hs_meeting_body', 'hs_internal_meeting_notes', 'hs_meeting_external_url', 'hs_meeting_location', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hubspot_owner_id', OPERATION_ID_PROPERTY])
const MEETING_OUTCOMES = ['SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELED']
const MEETING_DEFAULT_PROPERTIES = ['hs_createdate', 'hs_lastmodifieddate', 'hs_object_id']
const CONTACT_DEFAULT_PROPERTIES = ['createdate', 'email', 'firstname', 'hs_object_id', 'lastmodifieddate', 'lastname']

/** Search limits (search guide): 200 per page, 10,000 results per query, 5 groups × 6 filters. */
const SEARCH_MAX_LIMIT = 200
const SEARCH_MAX_RESULTS = 10_000
const SEARCH_MAX_GROUPS = 5
const SEARCH_MAX_FILTERS = 6

let correlationCounter = 0
const correlationId = () => `fake-${(++correlationCounter).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`

class HubSpotError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.message ?? status))
  }
}

const errorBody = (category: string, message: string, extra: Record<string, unknown> = {}) =>
  ({ status: 'error', message, correlationId: correlationId(), category, ...extra })

const notFound = () => new HubSpotError(404, errorBody('OBJECT_NOT_FOUND', 'Object not found.  objectId are usually numeric.'))
const badRequest = (message: string, extra: Record<string, unknown> = {}) => new HubSpotError(400, errorBody('VALIDATION_ERROR', message, extra))

interface PropertyProblem { isValid: false; message: string; error: string; name: string }
const propertyValuesInvalid = (problems: PropertyProblem[]) =>
  badRequest(`Property values were not valid: ${JSON.stringify(problems)}`)

/**
 * `/crm/v3/<api>/<rest>` or `/crm/<api>/<YYYY-MM>/<rest>` → `<api>/<rest>`;
 * null for anything else.
 */
export function normalizeCrmPath(path: string): string | null {
  const v3 = /^\/crm\/v3\/(objects|properties|pipelines|owners|associations)(\/.*)?$/.exec(path)
  if (v3) return v3[1] + (v3[2] ?? '')
  const dated = /^\/crm\/(objects|properties|pipelines|owners|associations)\/(\d{4}-\d{2})(\/.*)?$/.exec(path)
  if (dated) return dated[1] + (dated[3] ?? '')
  const account = /^\/account-info\/(?:v3|\d{4}-\d{2})\/details$/.exec(path)
  if (account) return 'account-info/details'
  return null
}

export function createFakeHubSpot(options: FakeHubSpotOptions = {}): FakeHubSpot {
  const now = options.now ?? (() => Date.now())
  const limits: Required<RateLimitOptions> | null = options.rateLimits === undefined
    ? null
    : { perTenSeconds: 100, searchPerSecond: 5, ...(options.rateLimits === true ? {} : options.rateLimits) }
  const seed = options.seed ?? defaultSeed()
  const portalId = options.portalId ?? 90000001
  let searchIndexDelayMs = options.searchIndexDelayMs ?? 0
  const meetingScopes = {
    read: options.meetingScopes?.read ?? [HUBSPOT_SCOPES.dealsRead],
    write: options.meetingScopes?.write ?? [HUBSPOT_SCOPES.dealsWrite],
  }
  const keys = new Map<string, Set<string>>()
  const requests: FakeRequestLog[] = []

  // Timestamps only move forward, so every change has a newer hs_lastmodifieddate.
  let lastStamp = 0
  const stamp = () => (lastStamp = Math.max(now(), lastStamp + 1))
  const iso = (ms: number) => new Date(ms).toISOString()

  const owners = seed.owners.map(o => ({ ...o }))
  const companies = new Map<string, StoredObject>()
  const deals = new Map<string, Deal>()
  const notes = new Map<string, Note>()
  const meetings = new Map<string, Meeting>()
  const contacts = new Map<string, StoredObject>()
  let nextNoteId = 3000000001
  let nextMeetingId = 4000000001
  let nextDealId = 1000001001

  const created = stamp()
  for (const c of seed.companies) {
    companies.set(c.id, { id: c.id, properties: { ...c.properties, hs_object_id: c.id, createdate: iso(created), hs_lastmodifieddate: iso(created) }, createdAt: created, updatedAt: created, archived: false, indexedAt: created })
  }
  for (const d of seed.deals) {
    const deal: Deal = { id: d.id, properties: { ...d.properties, hs_object_id: d.id, createdate: iso(created), hs_lastmodifieddate: iso(created) }, createdAt: created, updatedAt: created, archived: false, indexedAt: created, companyIds: [...d.companyIds], contactIds: [], probabilityOverridden: false }
    applyStage(deal)
    deals.set(d.id, deal)
  }
  for (const ct of seed.contacts ?? []) {
    contacts.set(ct.id, { id: ct.id, properties: { ...ct.properties, hs_object_id: ct.id, createdate: iso(created), lastmodifieddate: iso(created) }, createdAt: created, updatedAt: created, archived: false, indexedAt: created })
    for (const dealId of ct.dealIds) deals.get(dealId)?.contactIds.push(ct.id)
  }

  function applyStage(deal: Deal) {
    const stage = STAGES.find(s => s.id === deal.properties.dealstage)
    if (!stage) return
    deal.properties.hs_is_closed_won = String(stage.id === 'closedwon')
    deal.properties.hs_is_closed = String(stage.isClosed)
    if (!deal.probabilityOverridden) deal.properties.hs_deal_stage_probability = stage.probability
  }

  function touch(obj: StoredObject) {
    obj.updatedAt = stamp()
    obj.properties.hs_lastmodifieddate = iso(obj.updatedAt)
  }

  // ---- faults ----
  let failCount = 0
  let failStatus = 500
  let dropCount = 0
  let failWriteCount = 0
  let failWriteStatus = 500
  const held = new Set<() => void>()
  const faults: FakeFaults = {
    delayMs: 0,
    failNext(count = 1, status = 500) { failCount = count; failStatus = status },
    failNextWrite(count = 1, status = 500) { failWriteCount = count; failWriteStatus = status },
    dropAnswerAfterWrite(count = 1) { dropCount = count },
    reset() { faults.delayMs = 0; failCount = 0; dropCount = 0; failWriteCount = 0 },
  }

  // ---- rate limits (sliding windows) ----
  const perKeyCalls = new Map<string, number[]>()
  const searchCalls: number[] = []
  function overLimit(key: string, isSearch: boolean): HubSpotError | null {
    if (!limits) return null
    const t = now()
    if (isSearch) {
      while (searchCalls.length && searchCalls[0] <= t - 1000) searchCalls.shift()
      if (searchCalls.length >= limits.searchPerSecond) {
        return new HubSpotError(429, { status: 'error', message: 'You have reached your secondly limit.', errorType: 'RATE_LIMIT', correlationId: correlationId(), policyName: 'SECONDLY', requestId: correlationId() })
      }
      searchCalls.push(t)
      return null
    }
    const calls = perKeyCalls.get(key) ?? []
    while (calls.length && calls[0] <= t - 10_000) calls.shift()
    if (calls.length >= limits.perTenSeconds) {
      return new HubSpotError(429, { status: 'error', message: 'You have reached your ten_secondly_rolling limit.', errorType: 'RATE_LIMIT', correlationId: correlationId(), policyName: 'TEN_SECONDLY_ROLLING', requestId: correlationId() })
    }
    calls.push(t)
    perKeyCalls.set(key, calls)
    return null
  }

  // ---- shapes ----
  function pick(obj: StoredObject, requested: string[] | null, defaults: string[], always: string[]) {
    const names = requested ? [...new Set([...requested, ...always])] : defaults
    const properties: Record<string, string | null> = {}
    for (const n of names) {
      // Unknown names are left out (as HubSpot does); known ones without a value are null.
      if (n in obj.properties) properties[n] = obj.properties[n] ?? null
      else if (DEAL_PROPERTY.has(n) || NOTE_PROPERTIES.has(n) || MEETING_PROPERTIES.has(n) || defaults.includes(n)) properties[n] = null
    }
    return { id: obj.id, properties, createdAt: iso(obj.createdAt), updatedAt: iso(obj.updatedAt), archived: obj.archived }
  }

  const dealOut = (d: Deal, requested: string[] | null) => pick(d, requested, DEAL_DEFAULT_PROPERTIES, DEAL_ALWAYS)

  function listParam(c: Context, name: string): string[] | null {
    const values = c.req.queries(name)
    if (!values || values.length === 0) return null
    return values.flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean)
  }

  function liveDeal(id: string): Deal {
    const d = deals.get(id)
    if (!d || d.archived) throw notFound()
    return d
  }

  function validateDealProperties(deal: Deal | null, input: unknown): Record<string, string> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw badRequest('Invalid input JSON: properties must be an object')
    const problems: PropertyProblem[] = []
    const out: Record<string, string> = {}
    for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
      const def = DEAL_PROPERTY.get(name)
      if (!def) { problems.push({ isValid: false, message: `Property "${name}" does not exist`, error: 'PROPERTY_DOESNT_EXIST', name }); continue }
      if (def.readOnlyValue) { problems.push({ isValid: false, message: `"${name}" is a read only property; its value cannot be set.`, error: 'READ_ONLY_VALUE', name }); continue }
      const value = raw === null ? '' : String(raw)
      if (def.type === 'enumeration' && value !== '') {
        const allowed = name === 'hubspot_owner_id' ? owners.map(o => o.id) : (def.options ?? []).map(o => o.value)
        if (name === 'dealstage') {
          const pipeline = out.pipeline ?? deal?.properties.pipeline ?? 'default'
          if (pipeline !== 'default') { problems.push({ isValid: false, message: `${value} is not a valid pipeline stage`, error: 'INVALID_OPTION', name }); continue }
        }
        if (!allowed.includes(value)) { problems.push({ isValid: false, message: `${value} was not one of the allowed options: [${allowed.join(', ')}]`, error: 'INVALID_OPTION', name }); continue }
      }
      if (def.type === 'number' && value !== '' && !/^-?\d+(\.\d+)?$/.test(value)) {
        problems.push({ isValid: false, message: `${value} was not a valid number.`, error: 'INVALID_FLOAT', name }); continue
      }
      out[name] = value
    }
    if (problems.length > 0) throw propertyValuesInvalid(problems)
    return out
  }

  // ---- the app ----
  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    requests.push({ method: c.req.method, path: c.req.path, status: c.res.status })
  })

  if (options.controlRoutes) {
    app.post('/__fake/deals/:id', async c => {
      const body = await c.req.json().catch(() => null) as { properties?: Record<string, string> } | null
      try {
        changeDealOutside(c.req.param('id'), body?.properties ?? {})
      } catch (err) {
        if (err instanceof HubSpotError) return c.json(err.body, err.status as 400)
        throw err
      }
      return c.json({ ok: true })
    })
    app.post('/__fake/settings', async c => {
      const body = await c.req.json().catch(() => ({})) as { searchIndexDelayMs?: number }
      if (typeof body.searchIndexDelayMs === 'number') searchIndexDelayMs = body.searchIndexDelayMs
      return c.json({ ok: true })
    })
    app.post('/__fake/faults', async c => {
      const body = await c.req.json().catch(() => ({})) as { delayMs?: number; failNext?: number; failStatus?: number; dropAnswerAfterWrite?: number; reset?: boolean }
      if (body.reset) faults.reset()
      if (typeof body.delayMs === 'number') faults.delayMs = body.delayMs
      if (typeof body.failNext === 'number') faults.failNext(body.failNext, body.failStatus)
      if (typeof body.dropAnswerAfterWrite === 'number') faults.dropAnswerAfterWrite(body.dropAnswerAfterWrite)
      return c.json({ ok: true })
    })
  }

  const handle = async (c: Context) => {
    const route = normalizeCrmPath(c.req.path)
    if (faults.delayMs > 0) await new Promise(r => setTimeout(r, faults.delayMs))
    try {
      // Authentication first, as HubSpot does (even for a path that does not exist).
      const auth = c.req.header('authorization') ?? ''
      const m = /^Bearer (\S+)$/.exec(auth)
      const key = m?.[1] ?? ''
      const scopes = keys.get(key)
      if (!key.startsWith(FAKE_HUBSPOT_KEY_PREFIX) || !scopes) {
        throw new HubSpotError(401, errorBody('INVALID_AUTHENTICATION', 'Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview'))
      }
      if (failCount > 0) {
        failCount--
        throw new HubSpotError(failStatus, errorBody('INTERNAL_ERROR', 'internal error'))
      }
      if (failWriteCount > 0 && c.req.method !== 'GET') {
        failWriteCount--
        throw new HubSpotError(failWriteStatus, errorBody('INTERNAL_ERROR', 'internal error'))
      }
      if (!route) throw new HubSpotError(404, errorBody('OBJECT_NOT_FOUND', 'Not found'))
      const handler = resolve(c.req.method, route)
      if (!handler) throw new HubSpotError(404, errorBody('OBJECT_NOT_FOUND', `Unable to infer object type from: ${route}`))

      if (handler.anyOf.length > 0 && !handler.anyOf.some(s => scopes.has(s))) {
        throw new HubSpotError(403, errorBody('MISSING_SCOPES', 'This app hasn\'t been granted all required scopes to make this call. Read more about required scopes here: https://developers.hubspot.com/scopes.', {
          errors: [{ message: 'One or more of the following scopes are required.', context: { requiredGranularScopes: handler.anyOf } }],
          links: { scopes: 'https://developers.hubspot.com/scopes' },
        }))
      }
      const isSearch = route.endsWith('/search')
      const limited = overLimit(key, isSearch)
      if (limited) throw limited

      const isWrite = c.req.method !== 'GET'
      const result = await handler.run(c)
      if (isWrite && dropCount > 0) {
        dropCount--
        return dropAnswer(c)
      }
      if (limits && !isSearch) {
        const used = perKeyCalls.get(key)?.length ?? 0
        c.header('X-HubSpot-RateLimit-Max', String(limits.perTenSeconds))
        c.header('X-HubSpot-RateLimit-Remaining', String(Math.max(0, limits.perTenSeconds - used)))
        c.header('X-HubSpot-RateLimit-Interval-Milliseconds', '10000')
      }
      if (result.status === 204) return c.body(null, 204)
      return c.json(result.body, result.status as 200)
    } catch (err) {
      if (err instanceof HubSpotError) return c.json(err.body, err.status as 400)
      throw err
    }
  }
  app.all('/crm/*', handle)
  app.all('/account-info/*', handle)

  /** The write happened; the answer does not arrive. */
  function dropAnswer(c: Context): Promise<Response> {
    const env = c.env as { incoming?: { socket?: { destroy(): void } } } | undefined
    const socket = env?.incoming?.socket
    if (socket) {
      socket.destroy()
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return new Promise<Response>(resolveHeld => {
      const release = () => { held.delete(release); resolveHeld(new Response(null, { status: 504 })) }
      held.add(release)
    })
  }

  type Result = { status: number; body?: unknown }
  interface Handler { anyOf: string[]; run(c: Context): Result | Promise<Result> }

  function resolve(method: string, route: string): Handler | null {
    const parts = route.split('/').filter(Boolean)
    const [api, objectType, id, extra] = parts
    const dealsRead = [HUBSPOT_SCOPES.dealsRead]
    // Account details: any valid key (no scope of its own).
    if (api === 'account-info' && objectType === 'details' && method === 'GET' && !id) return { anyOf: [], run: accountDetails }
    if (api === 'objects' && objectType === 'deals') {
      if (method === 'GET' && !id) return { anyOf: dealsRead, run: listDeals }
      if (method === 'POST' && !id) return { anyOf: [HUBSPOT_SCOPES.dealsWrite], run: createDeal }
      if (method === 'POST' && id === 'search' && !extra) return { anyOf: dealsRead, run: c => searchObjects(c, [...deals.values()], dealOut) }
      if (method === 'GET' && id && !extra) return { anyOf: dealsRead, run: c => getDeal(c, id) }
      if (method === 'PATCH' && id && !extra) return { anyOf: [HUBSPOT_SCOPES.dealsWrite], run: c => updateDeal(c, id) }
      if (method === 'DELETE' && id && !extra) return { anyOf: [HUBSPOT_SCOPES.dealsWrite], run: () => archive(deals, id) }
      return null
    }
    if (api === 'objects' && objectType === 'meetings') {
      if (method === 'POST' && !id) return { anyOf: meetingScopes.write, run: createMeeting }
      if (method === 'POST' && id === 'search' && !extra) return { anyOf: meetingScopes.read, run: c => searchObjects(c, [...meetings.values()], meetingOut) }
      if (method === 'GET' && id && !extra) return { anyOf: meetingScopes.read, run: c => getMeeting(c, id) }
      if (method === 'DELETE' && id && !extra) return { anyOf: meetingScopes.write, run: () => archive(meetings, id) }
      return null
    }
    if (api === 'objects' && objectType === 'contacts' && method === 'GET' && id && !extra) {
      return { anyOf: [HUBSPOT_SCOPES.contactsRead], run: c => getContact(c, id) }
    }
    if (api === 'objects' && objectType === 'companies' && method === 'GET' && id && !extra) {
      return { anyOf: [HUBSPOT_SCOPES.companiesRead], run: c => getCompany(c, id) }
    }
    if (api === 'objects' && objectType === 'notes') {
      if (method === 'POST' && !id) return { anyOf: [HUBSPOT_SCOPES.contactsWrite], run: createNote }
      if (method === 'GET' && id && !extra) return { anyOf: [HUBSPOT_SCOPES.contactsRead], run: () => getNote(id) }
      if (method === 'DELETE' && id && !extra) return { anyOf: [HUBSPOT_SCOPES.contactsWrite], run: () => archiveNote(id) }
      return null
    }
    // Properties and pipelines take any of these (their reference pages' security lists).
    const schemaScopes = [HUBSPOT_SCOPES.dealsRead, HUBSPOT_SCOPES.dealsWrite, HUBSPOT_SCOPES.dealSchemasRead]
    if (api === 'properties' && objectType === 'deals' && method === 'GET' && !id) return { anyOf: schemaScopes, run: listDealProperties }
    if (api === 'pipelines' && (objectType === 'deals' || objectType === '0-3') && method === 'GET' && !id) return { anyOf: schemaScopes, run: listDealPipelines }
    if (api === 'owners' && method === 'GET' && !objectType) return { anyOf: [HUBSPOT_SCOPES.ownersRead], run: listOwners }
    return null
  }

  /**
   * `{id}` is the record id, or with `idProperty` the value of a unique-value
   * property (found at once, unlike search). A property that is not unique
   * is a 400, as in HubSpot.
   */
  function byIdOrUnique<T extends StoredObject>(c: Context, map: Map<string, T>, id: string): T {
    const idProperty = c.req.query('idProperty')
    if (idProperty === undefined || idProperty === 'hs_object_id') {
      const o = map.get(id)
      if (!o || o.archived) throw notFound()
      return o
    }
    if (idProperty !== OPERATION_ID_PROPERTY) throw badRequest(`Property ${idProperty} is not a unique identifier property.`)
    const o = [...map.values()].find(x => !x.archived && x.properties[OPERATION_ID_PROPERTY] === id)
    if (!o) throw notFound()
    return o
  }

  function getDeal(c: Context, id: string): Result {
    const d = byIdOrUnique(c, deals, id)
    const out: Record<string, unknown> = dealOut(d, listParam(c, 'properties'))
    const assoc = listParam(c, 'associations')
    const associations: Record<string, unknown> = {}
    if (assoc?.includes('companies') || assoc?.includes('company')) {
      associations.companies = { results: d.companyIds.map(cid => ({ id: cid, type: 'deal_to_company' })) }
    }
    // HubSpot leaves out an association type with no results.
    if ((assoc?.includes('contacts') || assoc?.includes('contact')) && d.contactIds.length > 0) {
      associations.contacts = { results: d.contactIds.map(cid => ({ id: cid, type: 'deal_to_contact' })) }
    }
    if (Object.keys(associations).length > 0) out.associations = associations
    return { status: 200, body: out }
  }

  function getContact(c: Context, id: string): Result {
    const ct = contacts.get(id)
    if (!ct || ct.archived) throw notFound()
    return { status: 200, body: pick(ct, listParam(c, 'properties'), CONTACT_DEFAULT_PROPERTIES, ['createdate', 'lastmodifieddate', 'hs_object_id']) }
  }

  /** A second live object of the same type with the same unique value: 409, nothing created. */
  function assertUnique(map: Map<string, StoredObject>, value: string | null | undefined) {
    if (!value) return
    const other = [...map.values()].find(o => !o.archived && o.properties[OPERATION_ID_PROPERTY] === value)
    if (other) {
      throw new HubSpotError(409, errorBody('CONFLICT', `A record with the unique value ${value} for property ${OPERATION_ID_PROPERTY} already exists. Existing ID: ${other.id}`, { context: { id: [other.id] } }))
    }
  }

  type AssociationInput = { to?: { id?: unknown }; types?: { associationCategory?: string; associationTypeId?: number }[] }
  function associationsOf(input: AssociationInput[] | undefined): { toId: string; typeId: number }[] {
    const out: { toId: string; typeId: number }[] = []
    for (const a of input ?? []) {
      const toId = String(a.to?.id ?? '')
      for (const t of a.types ?? []) {
        if (t.associationCategory !== 'HUBSPOT_DEFINED') throw badRequest(`Unsupported association category: ${String(t.associationCategory)}`)
        out.push({ toId, typeId: Number(t.associationTypeId) })
      }
    }
    return out
  }

  async function createDeal(c: Context): Promise<Result> {
    const body = await c.req.json().catch(() => null) as { properties?: unknown; associations?: AssociationInput[] } | null
    if (!body || body.properties === undefined) throw badRequest('Invalid input JSON: properties is required')
    const values = validateDealProperties(null, body.properties)
    for (const required of ['dealname', 'dealstage']) {
      if (!values[required]) throw propertyValuesInvalid([{ isValid: false, message: `${required} is required`, error: 'REQUIRED_PROPERTY', name: required }])
    }
    const companyIds: string[] = []
    const contactIds: string[] = []
    for (const { toId, typeId } of associationsOf(body.associations)) {
      if (typeId === DEAL_TO_COMPANY && companies.has(toId)) companyIds.push(toId)
      else if (typeId === DEAL_TO_CONTACT && contacts.has(toId)) contactIds.push(toId)
      else throw badRequest(`Invalid association type id ${typeId} or target ${toId} for deal`)
    }
    assertUnique(deals, values[OPERATION_ID_PROPERTY])
    const id = String(nextDealId++)
    const t = stamp()
    const deal: Deal = {
      id, properties: { pipeline: 'default', ...values, hs_object_id: id, createdate: iso(t), hs_lastmodifieddate: iso(t) },
      createdAt: t, updatedAt: t, archived: false, indexedAt: now() + searchIndexDelayMs, companyIds, contactIds,
      probabilityOverridden: 'hs_deal_stage_probability' in values,
    }
    applyStage(deal)
    deals.set(id, deal)
    return { status: 201, body: dealOut(deal, [...new Set([...DEAL_DEFAULT_PROPERTIES, ...Object.keys(values)])]) }
  }

  const meetingOut = (m: StoredObject, requested: string[] | null) => pick(m, requested, MEETING_DEFAULT_PROPERTIES, ['hs_object_id'])

  async function createMeeting(c: Context): Promise<Result> {
    const body = await c.req.json().catch(() => null) as { properties?: Record<string, unknown>; associations?: AssociationInput[] } | null
    if (!body || typeof body.properties !== 'object' || body.properties === null) throw badRequest('Invalid input JSON: properties is required')
    const problems: PropertyProblem[] = []
    const props: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(body.properties)) {
      if (!MEETING_PROPERTIES.has(k)) problems.push({ isValid: false, message: `Property "${k}" does not exist`, error: 'PROPERTY_DOESNT_EXIST', name: k })
      else if (k === 'hs_meeting_outcome' && v !== null && !MEETING_OUTCOMES.includes(String(v))) problems.push({ isValid: false, message: `${String(v)} was not one of the allowed options: [${MEETING_OUTCOMES.join(', ')}]`, error: 'INVALID_OPTION', name: k })
      else props[k] = v === null ? null : String(v)
    }
    if (!props.hs_timestamp) problems.push({ isValid: false, message: 'hs_timestamp is required', error: 'REQUIRED_PROPERTY', name: 'hs_timestamp' })
    if (problems.length > 0) throw propertyValuesInvalid(problems)
    const dealIds: string[] = []
    const contactIds: string[] = []
    for (const { toId, typeId } of associationsOf(body.associations)) {
      if (typeId === MEETING_TO_DEAL) {
        if (!deals.get(toId) || deals.get(toId)!.archived) throw badRequest(`No deal with id ${toId}`)
        dealIds.push(toId)
      } else if (typeId === MEETING_TO_CONTACT && contacts.has(toId)) {
        contactIds.push(toId)
      } else {
        throw badRequest(`Invalid association type id ${typeId} for meeting`)
      }
    }
    assertUnique(meetings, props[OPERATION_ID_PROPERTY])
    const id = String(nextMeetingId++)
    const t = stamp()
    const meeting: Meeting = { id, properties: { ...props, hs_object_id: id, hs_createdate: iso(t), hs_lastmodifieddate: iso(t) }, createdAt: t, updatedAt: t, archived: false, indexedAt: now() + searchIndexDelayMs, dealIds, contactIds }
    meetings.set(id, meeting)
    return { status: 201, body: meetingOut(meeting, Object.keys(meeting.properties)) }
  }

  function getMeeting(c: Context, id: string): Result {
    const m = byIdOrUnique(c, meetings, id)
    const out: Record<string, unknown> = meetingOut(m, listParam(c, 'properties'))
    const assoc = listParam(c, 'associations')
    if ((assoc?.includes('deals') || assoc?.includes('deal')) && m.dealIds.length > 0) {
      out.associations = { deals: { results: m.dealIds.map(did => ({ id: did, type: 'meeting_event_to_deal' })) } }
    }
    return { status: 200, body: out }
  }

  /** DELETE = archive (recycling bin): gone from GET and search; its unique value is free again. */
  function archive(map: Map<string, StoredObject>, id: string): Result {
    const o = map.get(id)
    if (!o || o.archived) throw notFound()
    o.archived = true
    o.updatedAt = stamp()
    return { status: 204 }
  }

  function page<T>(items: T[], limitRaw: unknown, afterRaw: unknown, max: number) {
    const limit = limitRaw === undefined || limitRaw === null || limitRaw === '' ? 10 : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > max) throw badRequest(`limit must be between 1 and ${max}`)
    const after = afterRaw === undefined || afterRaw === null || afterRaw === '' ? 0 : Number(afterRaw)
    if (!Number.isInteger(after) || after < 0) throw badRequest('after must be an integer')
    const slice = items.slice(after, after + limit)
    const nextAfter = after + limit < items.length ? String(after + limit) : null
    return { slice, nextAfter }
  }

  function listDeals(c: Context): Result {
    const all = [...deals.values()].filter(d => !d.archived).sort((a, b) => Number(a.id) - Number(b.id))
    const { slice, nextAfter } = page(all, c.req.query('limit'), c.req.query('after'), 100)
    const props = listParam(c, 'properties')
    return { status: 200, body: { results: slice.map(d => dealOut(d, props)), ...(nextAfter ? { paging: { next: { after: nextAfter, link: `?after=${nextAfter}` } } } : {}) } }
  }

  async function searchObjects<T extends StoredObject>(c: Context, all: T[], out: (o: T, props: string[] | null) => unknown): Promise<Result> {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') throw badRequest('Invalid input JSON on line 1')
    const groups = (body.filterGroups ?? []) as { filters?: { propertyName?: string; operator?: string; value?: unknown; values?: unknown[] }[] }[]
    if (!Array.isArray(groups) || groups.length > SEARCH_MAX_GROUPS) throw badRequest(`There can be no more than ${SEARCH_MAX_GROUPS} filterGroups`)
    for (const g of groups) {
      if (!Array.isArray(g.filters) || g.filters.length > SEARCH_MAX_FILTERS) throw badRequest(`There can be no more than ${SEARCH_MAX_FILTERS} filters in a filterGroup`)
      for (const f of g.filters) {
        if (!f.propertyName || !['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY'].includes(f.operator ?? '')) {
          throw badRequest(`Invalid filter: ${JSON.stringify(f)}`)
        }
      }
    }
    const after = body.after === undefined ? 0 : Number(body.after)
    if (Number.isInteger(after) && after >= SEARCH_MAX_RESULTS) throw badRequest(`Paging beyond ${SEARCH_MAX_RESULTS} results is not supported.`)
    // A new object is not searchable until it is indexed (HubSpot's delay).
    const t = now()
    let matched = all.filter(d => !d.archived && d.indexedAt <= t)
    if (groups.length > 0) matched = matched.filter(d => groups.some(g => (g.filters ?? []).every(f => matches(d, f))))
    const sorts = (body.sorts ?? []) as ({ propertyName: string; direction?: string } | string)[]
    const sort = sorts[0]
    if (sort) {
      const prop = typeof sort === 'string' ? sort.replace(/^-/, '') : sort.propertyName
      const desc = typeof sort === 'string' ? sort.startsWith('-') : sort.direction === 'DESCENDING'
      matched.sort((a, b) => compareValues(a.properties[prop] ?? null, b.properties[prop] ?? null) * (desc ? -1 : 1))
    } else {
      matched.sort((a, b) => Number(a.id) - Number(b.id))
    }
    const capped = matched.slice(0, SEARCH_MAX_RESULTS)
    const { slice, nextAfter } = page(capped, body.limit, body.after, SEARCH_MAX_LIMIT)
    const props = Array.isArray(body.properties) ? (body.properties as string[]) : null
    return { status: 200, body: { total: matched.length, results: slice.map(d => out(d, props)), ...(nextAfter ? { paging: { next: { after: nextAfter } } } : {}) } }
  }

  function comparable(v: string | null): number | string | null {
    if (v === null || v === '') return null
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    const t = Date.parse(v)
    return Number.isNaN(t) ? v : t
  }
  function compareValues(a: string | null, b: string | null): number {
    const x = comparable(a), y = comparable(b)
    if (x === y) return 0
    if (x === null) return 1
    if (y === null) return -1
    return x < y ? -1 : 1
  }

  function matches(d: StoredObject, f: { propertyName?: string; operator?: string; value?: unknown; values?: unknown[] }): boolean {
    const actual = d.properties[f.propertyName!] ?? null
    const op = f.operator!
    if (op === 'HAS_PROPERTY') return actual !== null && actual !== ''
    if (op === 'NOT_HAS_PROPERTY') return actual === null || actual === ''
    if (op === 'IN' || op === 'NOT_IN') {
      const set = (f.values ?? []).map(v => String(v).toLowerCase())
      const has = actual !== null && set.includes(actual.toLowerCase())
      return op === 'IN' ? has : !has
    }
    const want = f.value === undefined || f.value === null ? null : String(f.value)
    if (op === 'EQ') return (actual ?? '').toLowerCase() === (want ?? '').toLowerCase()
    if (op === 'NEQ') return (actual ?? '').toLowerCase() !== (want ?? '').toLowerCase()
    if (actual === null || want === null) return false
    const cmp = compareValues(actual, want)
    if (op === 'GT') return cmp > 0
    if (op === 'GTE') return cmp >= 0
    if (op === 'LT') return cmp < 0
    return cmp <= 0
  }

  async function updateDeal(c: Context, id: string): Promise<Result> {
    const d = liveDeal(id)
    const body = await c.req.json().catch(() => null) as { properties?: unknown } | null
    if (!body || body.properties === undefined) throw badRequest('Invalid input JSON: properties is required')
    const values = validateDealProperties(d, body.properties)
    writeDeal(d, values)
    return { status: 200, body: dealOut(d, [...new Set([...DEAL_DEFAULT_PROPERTIES, ...Object.keys(values)])]) }
  }

  function writeDeal(d: Deal, values: Record<string, string>) {
    for (const [k, v] of Object.entries(values)) d.properties[k] = v
    if ('hs_deal_stage_probability' in values) d.probabilityOverridden = true
    applyStage(d)
    touch(d)
  }

  function changeDealOutside(id: string, properties: Record<string, string>) {
    const d = liveDeal(id)
    writeDeal(d, validateDealProperties(d, properties))
  }

  function getCompany(c: Context, id: string): Result {
    const co = companies.get(id)
    if (!co || co.archived) throw notFound()
    return { status: 200, body: pick(co, listParam(c, 'properties'), COMPANY_DEFAULT_PROPERTIES, DEAL_ALWAYS) }
  }

  function listDealProperties(): Result {
    const results = DEAL_PROPERTIES.map(p => ({
      updatedAt: iso(created),
      createdAt: iso(created),
      name: p.name,
      label: p.label,
      type: p.type,
      fieldType: p.fieldType,
      description: p.description,
      groupName: p.groupName,
      options: (p.name === 'hubspot_owner_id' ? owners.map(o => ({ label: `${o.lastName} ${o.firstName}`, value: o.id })) : p.options ?? [])
        .map((o, i) => ({ label: o.label, value: o.value, displayOrder: i, hidden: false })),
      displayOrder: -1,
      calculated: p.calculated,
      externalOptions: p.name === 'hubspot_owner_id',
      hasUniqueValue: p.unique === true,
      hidden: false,
      hubspotDefined: p.hubspotDefined,
      modificationMetadata: { archivable: !p.hubspotDefined, readOnlyDefinition: p.hubspotDefined, readOnlyValue: p.readOnlyValue },
      formField: !p.readOnlyValue,
    }))
    return { status: 200, body: { results } }
  }

  function listDealPipelines(): Result {
    return {
      status: 200,
      body: {
        results: [{
          id: 'default',
          label: 'Sales Pipeline',
          displayOrder: 0,
          archived: false,
          createdAt: iso(created),
          updatedAt: iso(created),
          stages: STAGES.map((s, i) => ({
            id: s.id,
            label: s.label,
            displayOrder: i,
            metadata: { isClosed: String(s.isClosed), probability: s.probability },
            archived: false,
            createdAt: iso(created),
            updatedAt: iso(created),
          })),
        }],
      },
    }
  }

  function accountDetails(): Result {
    return { status: 200, body: { portalId, accountType: 'STANDARD', timeZone: 'Asia/Tokyo', companyCurrency: 'JPY', additionalCurrencies: [], utcOffset: '+09:00', utcOffsetMilliseconds: 32400000, uiDomain: 'app-na2.hubspot.com', dataHostingLocation: 'na2' } }
  }

  function listOwners(): Result {
    return {
      status: 200,
      body: {
        results: owners.map(o => ({
          id: o.id,
          email: o.email,
          type: 'PERSON',
          firstName: o.firstName,
          lastName: o.lastName,
          userId: o.userId,
          userIdIncludingInactive: o.userId,
          createdAt: iso(created),
          updatedAt: iso(created),
          archived: false,
        })),
      },
    }
  }

  async function createNote(c: Context): Promise<Result> {
    const body = await c.req.json().catch(() => null) as { properties?: Record<string, unknown>; associations?: { to?: { id?: unknown }; types?: { associationCategory?: string; associationTypeId?: number }[] }[] } | null
    if (!body || typeof body.properties !== 'object' || body.properties === null) throw badRequest('Invalid input JSON: properties is required')
    const problems: PropertyProblem[] = []
    const props: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(body.properties)) {
      if (!NOTE_PROPERTIES.has(k)) problems.push({ isValid: false, message: `Property "${k}" does not exist`, error: 'PROPERTY_DOESNT_EXIST', name: k })
      else props[k] = v === null ? null : String(v)
    }
    if (!props.hs_timestamp) problems.push({ isValid: false, message: 'hs_timestamp is required', error: 'REQUIRED_PROPERTY', name: 'hs_timestamp' })
    if (problems.length > 0) throw propertyValuesInvalid(problems)
    const dealIds: string[] = []
    const companyIds: string[] = []
    for (const a of body.associations ?? []) {
      const toId = String(a.to?.id ?? '')
      for (const t of a.types ?? []) {
        if (t.associationCategory !== 'HUBSPOT_DEFINED') throw badRequest(`Unsupported association category: ${String(t.associationCategory)}`)
        if (t.associationTypeId === NOTE_TO_DEAL) {
          if (!deals.get(toId) || deals.get(toId)!.archived) throw badRequest(`No deal with id ${toId}`)
          dealIds.push(toId)
        } else if (t.associationTypeId === NOTE_TO_COMPANY) {
          if (!companies.get(toId)) throw badRequest(`No company with id ${toId}`)
          companyIds.push(toId)
        } else {
          throw badRequest(`Invalid association type id ${String(t.associationTypeId)} for note`)
        }
      }
    }
    const id = String(nextNoteId++)
    const t = stamp()
    const note: Note = { id, properties: { ...props, hs_object_id: id, hs_createdate: iso(t), hs_lastmodifieddate: iso(t) }, createdAt: t, updatedAt: t, archived: false, indexedAt: t, dealIds, companyIds }
    notes.set(id, note)
    return { status: 201, body: pick(note, Object.keys(note.properties), [], []) }
  }

  function getNote(id: string): Result {
    const n = notes.get(id)
    if (!n || n.archived) throw notFound()
    return { status: 200, body: pick(n, Object.keys(n.properties), [], []) }
  }

  /** DELETE = archive: the note goes to HubSpot's recycling bin (and is gone from GET). */
  function archiveNote(id: string): Result {
    const n = notes.get(id)
    if (!n || n.archived) throw notFound()
    n.archived = true
    n.updatedAt = stamp()
    return { status: 204 }
  }

  return {
    app,
    addKey(key, scopes = ALL_FAKE_SCOPES) {
      if (!key.startsWith(FAKE_HUBSPOT_KEY_PREFIX)) throw new Error(`fake HubSpot keys start with ${FAKE_HUBSPOT_KEY_PREFIX}`)
      keys.set(key, new Set(scopes))
      return key
    },
    setScopes(key, scopes) {
      if (!keys.has(key)) throw new Error('unknown fake key')
      keys.set(key, new Set(scopes))
    },
    removeKey(key) { keys.delete(key) },
    deal(id) {
      const d = deals.get(id)
      return d ? { properties: { ...d.properties }, updatedAt: iso(d.updatedAt), archived: d.archived } : null
    },
    note(id) {
      const n = notes.get(id)
      return n ? { properties: { ...n.properties }, archived: n.archived, dealIds: [...n.dealIds] } : null
    },
    meeting(id) {
      const m = meetings.get(id)
      return m ? { properties: { ...m.properties }, archived: m.archived, dealIds: [...m.dealIds], contactIds: [...m.contactIds] } : null
    },
    withOperationId(value) {
      const found: { type: 'deals' | 'meetings'; id: string; archived: boolean }[] = []
      for (const [type, map] of [['deals', deals], ['meetings', meetings]] as const) {
        for (const o of map.values()) if (o.properties[OPERATION_ID_PROPERTY] === value) found.push({ type, id: o.id, archived: o.archived })
      }
      return found
    },
    setSearchIndexDelay(ms) { searchIndexDelayMs = ms },
    changeDealOutside,
    faults,
    requests,
    close() { for (const release of [...held]) release() },
  }
}
