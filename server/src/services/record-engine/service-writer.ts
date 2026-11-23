import { SERVICE_MADE_TYPES, SERVICE_OWNED_TYPES, SERVICE_RECEIPT_TYPES, SERVICE_TRANSITIONS, serviceTransitionAllowed } from '../../../shared/core/core-types'
import { findPrivateScope, type ScopeWithRules } from '../../../shared/core/permissions'
import { normalizeRepoPath } from '../../../shared/core/paths'
import type { TypeDefinition } from '../../../shared/core/record-types'
import { SYSTEM_ACTOR_PREFIX, type LedgerChange, type LedgerEntry, type LedgerValue, type LedgerVia } from '../../../shared/core/record-ledger'
import { newRecordId, RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordAccessRow, RecordLinkRow, RecordMemberSet, RecordRepository } from '../../ports/records'
import { listedUserIds, recordReader } from '../record-access'
import { currentTypes } from '../record-index'
import { recordSummaries } from '../records'
import { followLinkName, linkedParents, placeWithin } from './bundle-place'
import { interfaceLinkMisses } from './links'
import { MEMBERS_MAX, meetingMembers, withNamedPeople } from './members'
import { ASSIGNEE_CANNOT_READ } from './refusals'
import type { RecordChange, RecordEngineDeps } from './types'
import { checkValue } from './values'

/** Who a core service acts for (the ledger's actor): a person, their AI, or an outside system. */
export interface ServiceActor {
  id: string
  kind: 'human' | 'ai' | 'external'
  /** The agent for an AI, the plugin / service for an outside system. */
  source: string | null
  conversationId?: string | null
  proposedBy?: 'ai' | null
  /** The absent member a delegate stood in for (「代わりに（本来は X）」); the calling service decides it. */
  onBehalfOf?: string | null
  /** The AI's execution run (S10b), from its token; or the server's own run of a scheduled job (an `acb:` actor). */
  runId?: string | null
  /** A person's call through a plugin's screen (the bridge, plan 4b B6): kept on a created record's first entry. */
  via?: LedgerVia | null
}

/**
 * Where a new service record is read — **always said** (records.md "全社 is a choice"): leaving it out
 * does not compile, so no service lands a record company-wide by forgetting. Exactly one of:
 * - `folder`: the readers' folder, never a private folder and never `''`; **`null` = the whole company,
 *   written out on purpose** (a copied place of a company-wide record, `placeOfRow`). A record linked to a
 *   members-only meeting is members-only by itself (its list and the people named) — then a folder is
 *   refused (`bad-place`), and `folder: null` is how a service says "the meeting's people" there.
 * - `personalOwner` (「持ち主だけ」): the one member who may read it — the inbox's record of someone's own
 *   mail (inbox.md); every person named must be that member.
 * - `members` (「この人たちだけ」, records.md "Members-only records"): the members who may read it (each a
 *   member of the company, at most 200); every person named must be listed. `memberSets`: the groups and
 *   departments on that list, copied from the record it is placed like (`placeOfRow`).
 */
export type ServiceCreatePlace =
  | { folder: string | null; personalOwner?: never; members?: never; memberSets?: never }
  | { personalOwner: string; folder?: never; members?: never; memberSets?: never }
  | { members: readonly string[]; memberSets?: readonly RecordMemberSet[]; folder?: never; personalOwner?: never }

/** A new record of a service-owned type (`SERVICE_OWNED_TYPES`), with its place (`ServiceCreatePlace`). */
export type ServiceCreateInput = ServiceCreateFields & ServiceCreatePlace

interface ServiceCreateFields {
  type: string
  /** A chosen id (e.g. derived from an idempotency key); default: a new one. */
  id?: string
  title: string
  summary?: string
  /** Server fields, checked by the type's kinds; every person named must be able to read the record. */
  fields?: Record<string, LedgerValue>
  /** Link name → record ids. */
  links?: Record<string, string[]>
  actor: ServiceActor
  note?: string
  /**
   * Start in this state instead of the type's initial one: only a state the
   * initial one may move to along `SERVICE_TRANSITIONS` (as if created, then
   * moved) — the inbox's 確認待ち / 部署の番 / やることにしなかった.
   */
  state?: string
  /** Tell nobody (signal the app only): a record made in the AI's turn waits for the AI, not a person. */
  quiet?: boolean
  /** Also tell these members (besides the assignee and next actor): a meeting's attendees (minutes.md). */
  notify?: readonly string[]
}

/** A state change (checked against `SERVICE_TRANSITIONS`) and/or field change of a service-owned record. */
export interface ServiceTransitionInput {
  recordId: string
  /** The ledger's action name (`approve`, `send`, `start_reading`…). */
  action: string
  /** The version the caller decided on: compare-and-set, nothing written when it moved. */
  expectedVersion: number
  /** The new state; null = the state stays (fields only). */
  to: string | null
  fields?: Record<string, LedgerValue>
  /**
   * Links to replace: link name → record ids ([] removes). Kept in the ledger
   * as `links.<name>` before / after (the meeting's まとまり, chosen by a person).
   */
  links?: Record<string, string[]>
  actor: ServiceActor
  note?: string
  /** Keep the entry as a decision with this reason (approving, sending back). */
  decisionReason?: string
  /** Also tell these members (besides the assignee and next actor). */
  notify?: string[]
  /** Tell nobody (signal the app only). */
  quiet?: boolean
  /**
   * Add these members to a members-only record's list (records.md "Members-only records": a
   * meeting's attendees the calendar added later). Kept in the ledger as `place.members` before /
   * after; refused (`bad-place`) on a record that is not members-only or with a non-member.
   */
  addMembers?: readonly string[]
}

export type ServiceWriteFailure =
  | 'records-off' | 'type-unknown' | 'not-service-owned' | 'bad-value' | 'bad-place' | 'assignee-cannot-read'
  | 'exists' | 'not-found' | 'stale' | 'transition-not-allowed'
  /** The type's feature is off (「使う機能」): its records are 「見るだけ」, nothing new, no change. */
  | 'feature-off'

export type ServiceWriteFailed = { ok: false; reason: ServiceWriteFailure; detail?: string }
export type ServiceWriteResult = { ok: true; record: RecordSummary; entry: LedgerEntry } | ServiceWriteFailed

/**
 * The run an entry was written in: the AI's (from its token), or the server's own run of a scheduled
 * job (an `acb:` actor such as `acb:job`, jobs.md "The runner"). Never a person's or an outside system's.
 */
const runOf = (actor: ServiceActor): string | null =>
  actor.kind === 'ai' || (actor.kind === 'external' && actor.id.startsWith(SYSTEM_ACTOR_PREFIX)) ? actor.runId ?? null : null

const fail = (reason: ServiceWriteFailure, detail?: string): ServiceWriteFailed => ({ ok: false, reason, ...(detail ? { detail } : {}) })

/** Where a record is read (a service's input), as another record's place. */
export type ServicePlace = { folder: string | null } | { personalOwner: string } | { members: readonly string[]; memberSets?: readonly RecordMemberSet[] }

/**
 * The place of `row`, for a record a service makes from it (a reply placed like its 連絡, a
 * draft like its meeting): owner-only stays its owner's, members-only its members', else its
 * folder. The one copy — copying `folder` alone would place what came from a members-only
 * record company-wide (records.md "Members-only records").
 */
export function placeOfRow(row: Pick<RecordAccessRow, 'folder' | 'personalOwner' | 'members' | 'memberSets'>): ServicePlace {
  if (row.personalOwner !== null) return { personalOwner: row.personalOwner }
  if (row.members !== null) return { members: row.members, ...(row.memberSets && row.memberSets.length > 0 ? { memberSets: row.memberSets } : {}) }
  // A row stored with `''` (the company root, before the writer refused it) is the whole company: copied as `null`.
  return { folder: row.folder || null }
}

/**
 * The place of a record made for `rows` (the まとまり, meeting, 連絡, やること… it links to) when one of
 * them is owner-only or members-only — never seen by more people than any of them (records.md
 * "Other records made for a まとまり"): owner-only → owner-only for `creator`, who must be that owner
 * (else `refused`); members-only → that list (one: as written, its groups too — `placeOfRow`;
 * several: who is on all of them now, as people, like several meetings' lists), which must include
 * `creator` (else `refused`). `null` when none is restricted: the caller places it by folder as before.
 */
export function restrictedPlaceOf(
  rows: readonly (Pick<RecordAccessRow, 'folder' | 'personalOwner' | 'members' | 'memberSets'> | null | undefined)[], creator: string,
): ServicePlace | 'refused' | null {
  const restricted = rows.filter((r): r is Pick<RecordAccessRow, 'folder' | 'personalOwner' | 'members' | 'memberSets'> => !!r && (r.personalOwner !== null || r.members !== null))
  if (restricted.length === 0) return null
  const owners = restricted.filter(r => r.personalOwner !== null)
  if (owners.length > 0) {
    if (owners.some(r => r.personalOwner !== creator)) return 'refused'
    if (restricted.some(r => r.personalOwner === null && !listedUserIds(r).includes(creator))) return 'refused'
    return { personalOwner: creator }
  }
  if (restricted.length === 1) return listedUserIds(restricted[0]).includes(creator) ? placeOfRow(restricted[0]) : 'refused'
  const lists = restricted.map(r => listedUserIds(r))
  const common = lists.slice(1).reduce<string[]>((acc, list) => acc.filter(id => list.includes(id)), [...lists[0]])
  return common.includes(creator) ? { members: common } : 'refused'
}

/**
 * With a members-only place from `restrictedPlaceOf`: does everyone on that list (as it is now) read every
 * other source that is placed by a folder (or company-wide)? A record made from a members-only まとまり and
 * an 経理部 approval / やること is read only by people who read both — when someone on the list does not read
 * such a source, the caller refuses (the safe side: nobody is dropped from the list quietly). Owner-only
 * places pass: their one reader read every source to link it.
 */
export function listReadsSources(
  companyId: string, scopes: ScopeWithRules[], roleOf: (userId: string) => string | null, place: ServicePlace,
  rows: readonly (RecordAccessRow | null | undefined)[],
): boolean {
  if (!('members' in place)) return true
  const people = listedUserIds({ members: place.members, memberSets: place.memberSets ?? [] })
  const placed = rows.filter((r): r is RecordAccessRow => !!r && r.personalOwner === null && r.members === null)
  return people.every(userId => {
    const role = roleOf(userId)
    // Not a member of the company (any more): reads nothing through any route, so widens nothing.
    if (role === null) return true
    const reader = recordReader({ companyId, userId, role }, scopes)
    return placed.every(r => reader.record(r))
  })
}

/**
 * The engine's entry for the core services of milestone 4 (minutes intake,
 * approvals, outbound mail, decisions; records.md "Service writer"). Like
 * `createExternalRecordWriter`, composition.ts hands it to those services
 * only — no route, screen or AI reaches it. It creates records of
 * `SERVICE_OWNED_TYPES` (with values, links and a folder or a committed file
 * path) and changes their state along `SERVICE_TRANSITIONS`, with the
 * engine's duties: values checked by kind, every person named able to read
 * the record (`ASSIGNEE_CANNOT_READ`), state + ledger in one transaction with
 * a compare-and-set on the version, the actor the caller names, and the
 * members it names told (kind + version only). Whether that actor may do it
 * (an approver approving, the author sending) is the calling service's rule.
 */
export function createServiceRecordWriter(deps: Pick<RecordEngineDeps, 'companyData' | 'transactions' | 'clock' | 'ids' | 'isMember' | 'roleOf' | 'notify' | 'recordChanged' | 'featureOff'>) {
  const { companyData } = deps

  /** Every person value can read a record at `place` (a private folder's name is never said). */
  function readersOk(companyId: string, place: RecordAccessRow, values: Record<string, LedgerValue>, def: TypeDefinition): boolean {
    const scopes = companyData.forCompany(companyId).scopes.listWithRules()
    return Object.entries(values).every(([name, v]) => {
      if (def.fields[name]?.kind !== 'person' || typeof v !== 'string') return true
      const role = deps.roleOf(companyId, v)
      return role !== null && recordReader({ companyId, userId: v, role }, scopes).record(place)
    })
  }

  /** Is `place` within every live parent `links` names through the type's follow link (none: true)? */
  function withinParents(companyId: string, records: RecordRepository, def: TypeDefinition, place: RecordAccessRow, links: readonly RecordLinkRow[]): boolean {
    const parents = linkedParents(records, def, links)
    if (parents.length === 0) return true
    const scopes = companyData.forCompany(companyId).scopes.listWithRules()
    return parents.every(p => placeWithin(companyId, scopes, id => deps.roleOf(companyId, id), place, p))
  }

  function checkFields(companyId: string, def: TypeDefinition, raw:Record<string, LedgerValue> | undefined): { values: Record<string, LedgerValue> } | ServiceWriteFailed {
    const values: Record<string, LedgerValue> = {}
    for (const [name, value] of Object.entries(raw ?? {})) {
      const f = Object.prototype.hasOwnProperty.call(def.fields, name) ? def.fields[name] : undefined
      if (!f || f.source !== 'server') return fail('bad-value', `${name} is not a server field of ${def.name}`)
      const v = checkValue(f.kind, value, f.options, id => deps.isMember(companyId, id))
      if (v !== null && typeof v === 'object') return fail('bad-value', `${name}: ${v.error}`)
      values[name] = v
    }
    return { values }
  }

  function tell(companyId: string, actorId: string, userIds: Array<LedgerValue | undefined>, change: RecordChange, quiet = false, alsoActor = false) {
    // Every reader hears that it changed (the app refetches); quiet: that signal only, no notice.
    try { deps.recordChanged?.(companyId, change.entry.recordId) } catch { /* the app's own check catches up */ }
    if (quiet) return
    const to = [...new Set(userIds.filter((u): u is string => typeof u === 'string' && (alsoActor || u !== actorId)))]
    if (to.length > 0) { try { deps.notify(companyId, to, change) } catch { /* the app's own check catches up */ } }
  }

  /** Everything `create` checks, without writing: the prepared rows, or why not. */
  function prepare(companyId: string, input: ServiceCreateInput) {
    const records = companyData.forCompany(companyId).records
    if (!records.settings().enabled) return fail('records-off')
    if (!SERVICE_OWNED_TYPES.includes(input.type) && !SERVICE_RECEIPT_TYPES.includes(input.type) && !SERVICE_MADE_TYPES.includes(input.type)) return fail('not-service-owned')
    // A feature turned off makes nothing new (records.md "Features on and off"): the backstop under every service.
    // A sent mail's receipt (SERVICE_RECEIPT_TYPES) is still written: sending stays on with the inbox off.
    if (!SERVICE_RECEIPT_TYPES.includes(input.type) && deps.featureOff?.(companyId, input.type)) return fail('feature-off')
    const def = currentTypes(records).get(input.type)?.definition
    if (!def) return fail('type-unknown')
    const title = input.title.normalize('NFC').trim()
    if (title === '' || title.length > 200) return fail('bad-value', 'title: 1–200 characters')
    const summary = (input.summary ?? '').normalize('NFC').slice(0, 300)
    const scopes = companyData.forCompany(companyId).scopes.listWithRules()
    if (def.storage === 'file') return fail('bad-place', 'records of this type are files')
    // The place is always said (`ServiceCreatePlace`; a caller typed loosely is held to it here too): none → refused.
    if (input.folder === undefined && input.personalOwner === undefined && input.members === undefined) return fail('bad-place')
    let folder: string | null = null
    if (input.folder !== undefined && input.folder !== null) {
      folder = normalizeRepoPath(input.folder)
      // `''` would read as the company root (everyone): the whole company is `null`, said on purpose.
      if (!folder || findPrivateScope(scopes, folder)) return fail('bad-place')
    }
    const personalOwner = input.personalOwner ?? null
    if (personalOwner !== null && (folder !== null || !deps.isMember(companyId, personalOwner))) return fail('bad-place')
    let members: string[] | null = null
    let memberSets: RecordMemberSet[] = []
    if (input.memberSets !== undefined && input.members === undefined) return fail('bad-place')
    if (input.members !== undefined) {
      members = [...new Set(input.members)]
      memberSets = [...(input.memberSets ?? [])]
      if (folder !== null || personalOwner !== null || members.length > MEMBERS_MAX || !members.every(m => deps.isMember(companyId, m))) return fail('bad-place')
    }
    const state = input.state ?? def.initial
    if (input.state !== undefined && input.state !== def.initial && (!def.states.includes(input.state) || !serviceTransitionAllowed(def.name, def.initial, input.state))) {
      return fail('transition-not-allowed')
    }
    const checked = checkFields(companyId, def, input.fields)
    if (!('values' in checked)) return checked
    const values = checked.values
    if (def.implements.includes('request')) {
      if (input.actor.kind !== 'external') values.requested_by ??= input.actor.id
      values.next_actor ??= values.assignee ?? null
    }
    const id = input.id ?? newRecordId(def.name, deps.ids.newToken().slice(0, 16))
    if (!RECORD_ID_RE.test(id) || !id.startsWith(`${def.name}-`)) return fail('bad-value', 'id')
    const links: RecordLinkRow[] = []
    for (const [name, targets] of Object.entries(input.links ?? {})) {
      const l = Object.prototype.hasOwnProperty.call(def.links, name) ? def.links[name] : undefined
      if (!l || l.target === 'file') return fail('bad-value', `${name} is not a record link of ${def.name}`)
      for (const t of targets) {
        if (!RECORD_ID_RE.test(t)) return fail('bad-value', `${name}: a record id`)
        links.push({ sourceId: id, name, position: links.length, targetId: t, targetPath: null })
      }
      if (interfaceLinkMisses(records, l, targets).length > 0) return fail('bad-value', `${name}: records implementing ${l.target}`)
    }
    // Made from a members-only meeting: members-only too (its list and the people named here),
    // never placed in a folder — a service passing one is refused (fails closed).
    const inherited = members === null && personalOwner === null ? meetingMembers(records, links) : null
    if (inherited !== null) {
      if (folder !== null) return fail('bad-place')
      members = withNamedPeople(inherited.users, def, values)
      memberSets = inherited.sets
    }
    // Owner-only / members-only only when the calling service says whose (the inbox) or a meeting's list is inherited.
    const place: RecordAccessRow = { id, type: def.name, scopeId: null, path: null, folder, personalOwner, members, memberSets }
    // A type that follows its parent (`place_follows`, records.md "Following the parent's 見える範囲"): the place a
    // service says is never wider than the parent it links (else `bad-place`, nothing written; never narrowed here).
    if (!withinParents(companyId, records, def, place, links)) return fail('bad-place')
    if (!readersOk(companyId, place, values, def)) return fail('assignee-cannot-read', ASSIGNEE_CANNOT_READ)
    const existing = records.find(id)
    if (existing && (existing.type !== def.name || records.states([id]).length > 0)) return fail('exists')
    return { ok: true as const, records, def, id, title, summary, folder, personalOwner, members, memberSets, state, values, links }
  }

  return {
    /** Would `create` accept this now? (A caller with outside work to do first asks, so nothing is left half-made.) */
    check(companyId: string, input: ServiceCreateInput): ServiceWriteFailed | null {
      const p = prepare(companyId, input)
      return p.ok ? null : p
    },

    create(companyId: string, input: ServiceCreateInput): ServiceWriteResult {
      const p = prepare(companyId, input)
      if (!p.ok) return p
      const { records, def, id, values, links, state } = p
      const at = deps.clock.now()
      const entry: LedgerEntry = {
        recordId: id, version: 1, action: 'create', fromState: null, toState: state, actorId: input.actor.id, actorKind: input.actor.kind,
        actorSource: input.actor.source, at, note: input.note ?? '',
        changes: [
          { field: 'state', before: null, after: state },
          ...Object.entries(values).filter(([, v]) => v !== null).map(([field, after]) => ({ field, before: null, after })),
        ],
        attachments: [], decision: null, isDecision: false, typeVersion: def.version, reversesVersion: null,
        proposedBy: input.actor.kind === 'human' && input.actor.proposedBy === 'ai' ? 'ai' : null, conversationId: input.actor.conversationId ?? null,
        runId: runOf(input.actor),
        ...(input.actor.kind === 'human' && input.actor.via ? { via: { plugin: input.actor.via.plugin, version: input.actor.via.version } } : {}),
      }
      const existing = records.find(id)
      let written = false
      try {
        written = deps.transactions.run(() => {
          records.upsert({
            id, type: def.name, typeVersion: existing?.typeVersion ?? def.version, scopeId: null, path: null, folder: p.folder, personalOwner: p.personalOwner,
            members: p.members, title: p.title, summary: p.summary, createdAt: existing?.createdAt ?? at, updatedAt: at, removedAt: null,
          })
          if (p.members !== null) records.addMembers(id, p.members, input.actor.id, at)
          if (p.members !== null && p.memberSets.length > 0) records.addMemberSets(id, p.memberSets, input.actor.id, at)
          records.replaceLinks(id, links)
          if (!records.writeState({ recordId: id, state, fields: JSON.stringify(values), version: 1, updatedAt: at }, 0)) throw new Error('exists')
          records.appendLedger(entry)
          return true
        })
      } catch {
        written = false
      }
      if (!written) return fail('exists')
      tell(companyId, input.actor.id, [values.assignee, values.next_actor, ...(input.notify ?? [])], { type: def.name, entry, fields: values }, input.quiet)
      return { ok: true, record: recordSummaries(records, records.byIds([id])).get(id) as RecordSummary, entry }
    },

    transition(companyId: string, input: ServiceTransitionInput): ServiceWriteResult {
      const records = companyData.forCompany(companyId).records
      if (!records.settings().enabled) return fail('records-off')
      const row = RECORD_ID_RE.test(input.recordId) ? records.byIds([input.recordId])[0] : undefined
      if (!row || row.removedAt !== null) return fail('not-found')
      // 「見るだけ」: a record of a feature that is off is never moved (the clock, a service) until it is on again.
      if (deps.featureOff?.(companyId, row.type)) return fail('feature-off')
      // Another type (task) only along its listed state changes (the server clock's move, core-types.ts
      // WAIT_OVER; the inbox's reply check) — or a note alone that changes nothing (「返事は済み」):
      // never a field-only or link change.
      if (!SERVICE_OWNED_TYPES.includes(row.type)) {
        if (!Object.prototype.hasOwnProperty.call(SERVICE_TRANSITIONS, row.type)) return fail('not-service-owned')
        const noteOnly = Object.keys(input.fields ?? {}).length === 0 && input.links === undefined && (input.note ?? '') !== ''
        if (input.to === null && !noteOnly) return fail('not-service-owned')
      }
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return fail('type-unknown')
      const s = records.states([row.id])[0]
      let now: Record<string, LedgerValue> = {}
      try { now = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { now = {} }
      const version = s?.version ?? 0
      const state = s ? s.state : def.initial
      if (input.expectedVersion !== version) return fail('stale')
      const nextState = input.to ?? state
      if (nextState !== state && (nextState === null || !serviceTransitionAllowed(row.type, state, nextState))) return fail('transition-not-allowed')
      const checked = checkFields(companyId, def, input.fields)
      if (!('values' in checked)) return checked
      const set = checked.values
      if (!readersOk(companyId, row, set, def)) return fail('assignee-cannot-read', ASSIGNEE_CANNOT_READ)
      const next = { ...now, ...set }
      const changes: LedgerChange[] = []
      if (nextState !== state) changes.push({ field: 'state', before: state, after: nextState })
      for (const [field, after] of Object.entries(set)) {
        const before = now[field] ?? null
        if (before !== after) changes.push({ field, before, after })
      }
      const currentLinks = records.linksFrom([row.id])
      const newLinks: RecordLinkRow[] = []
      for (const [name, targets] of Object.entries(input.links ?? {})) {
        const l = Object.prototype.hasOwnProperty.call(def.links, name) ? def.links[name] : undefined
        if (!l || l.target === 'file') return fail('bad-value', `${name} is not a record link of ${def.name}`)
        if (l.cardinality === 'one' && targets.length > 1) return fail('bad-value', `${name}: one record`)
        for (const t of targets) {
          if (!RECORD_ID_RE.test(t)) return fail('bad-value', `${name}: a record id`)
          newLinks.push({ sourceId: row.id, name, position: 0, targetId: t, targetPath: null })
        }
        if (interfaceLinkMisses(records, l, targets).length > 0) return fail('bad-value', `${name}: records implementing ${l.target}`)
        const before = currentLinks.filter(x => x.name === name).map(x => x.targetId).join(',') || null
        const after = targets.join(',') || null
        if (before !== after) changes.push({ field: `links.${name}`, before, after })
      }
      // New members of a members-only record's list (only such a record, only members of the company).
      const adding = input.addMembers ? [...new Set(input.addMembers)] : []
      if (input.addMembers && (row.members === null || adding.length > MEMBERS_MAX || !adding.every(m => deps.isMember(companyId, m)))) return fail('bad-place')
      const joined = row.members !== null ? adding.filter(m => !row.members?.includes(m)) : []
      if (joined.length > 0) {
        // The list's groups / departments stay, after its people (`listLedgerValue`'s order); none: as before.
        const sets = (row.memberSets ?? []).map(s => `${s.type}:${s.id}`)
        changes.push({ field: 'place.members', before: [...(row.members ?? []), ...sets].join(','), after: [...(row.members ?? []), ...joined, ...sets].join(',') })
      }
      const replacedLinks = input.links
        ? [...currentLinks.filter(x => !(x.name in (input.links as Record<string, string[]>))), ...newLinks].map((x, i) => ({ ...x, position: i }))
        : null
      // Linking a parent the record follows (`place_follows`), or adding people to its list: only when it stays
      // within its parents (never narrowed here). Without such a change a parent already linked is not asked again
      // (a record from before its type followed stays as it is).
      const follow = followLinkName(def)
      if (follow !== null) {
        const after: RecordAccessRow = joined.length > 0 ? { ...row, members: [...(row.members ?? []), ...joined] } : row
        const kept = replacedLinks ?? currentLinks
        const asked = joined.length > 0
          ? kept.filter(x => x.name === follow)
          : kept.filter(x => x.name === follow && !currentLinks.some(c => c.name === follow && c.targetId === x.targetId))
        if (!withinParents(companyId, records, def, after, asked)) return fail('bad-place')
      }
      const at = deps.clock.now()
      const isDecision = input.decisionReason !== undefined
      const entry: LedgerEntry = {
        recordId: row.id, version: version + 1, action: input.action, fromState: state, toState: nextState,
        actorId: input.actor.id, actorKind: input.actor.kind, actorSource: input.actor.source, at, note: input.note ?? '', changes, attachments: [],
        decision: isDecision ? { reason: input.decisionReason as string, materials: [], policyVersion: null, precedents: [], supersedes: null } : null,
        isDecision, typeVersion: row.typeVersion, reversesVersion: null,
        proposedBy: input.actor.kind === 'human' && input.actor.proposedBy === 'ai' ? 'ai' : null, conversationId: input.actor.conversationId ?? null,
        ...(input.actor.onBehalfOf ? { onBehalfOf: input.actor.onBehalfOf } : {}),
        runId: runOf(input.actor),
      }
      const written = deps.transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: nextState, fields: JSON.stringify(next), version: entry.version, updatedAt: at }, version)) return false
        if (replacedLinks) records.replaceLinks(row.id, replacedLinks)
        if (joined.length > 0) records.addMembers(row.id, joined, input.actor.id, at)
        records.appendLedger(entry)
        return true
      })
      if (!written) return fail('stale')
      // A member's own AI acting for them, the service naming them in `notify` (the inbox's reply check,
      // owner FB #19): they did not do it, so they are told — the notices keep only the kinds meant for it.
      const alsoActor = input.actor.kind === 'ai' && (input.notify ?? []).includes(input.actor.id)
      tell(companyId, input.actor.id, [next.assignee, next.next_actor, ...(input.notify ?? [])], { type: row.type, entry, fields: next }, input.quiet, alsoActor)
      return { ok: true, record: recordSummaries(records, [row]).get(row.id) as RecordSummary, entry }
    },

    /**
     * A received message's title, only while it is still `expected` (compare-and-set): the inbox's
     * placeholder 「（件名なし）」 replaced by the owner's AI's short title (inbox.md). Only a
     * service's receipt type (`interaction`); the version and the ledger stay (a title is no field).
     */
    retitle(companyId: string, recordId: string, expected: string, title: string): boolean {
      const records = companyData.forCompany(companyId).records
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId])[0] : undefined
      if (!row || row.removedAt !== null || !SERVICE_RECEIPT_TYPES.includes(row.type) || row.title !== expected) return false
      const next = title.normalize('NFC').trim().slice(0, 200)
      if (next === '') return false
      deps.transactions.run(() => records.upsert({ ...row, title: next, updatedAt: deps.clock.now() }))
      try { deps.recordChanged?.(companyId, row.id) } catch { /* the app's own check catches up */ }
      return true
    },
  }
}

export type ServiceRecordWriter = ReturnType<typeof createServiceRecordWriter>
