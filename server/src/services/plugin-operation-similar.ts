/**
 * Similar existing records before a create of a record (design §6-3; owner
 * decision 2026-11-02, plugins.md "Similar records"): what the approval card
 * shows so the person notices a duplicate before a new record (a deal) is made.
 *
 * Found by the operation's `similar` (absent: by name through the object's
 * `search` call, as before):
 * - `counterpart`: records of the create's type in ACB linked to the same 相手
 *   — the request's meeting's 相手, every record of its 名寄せ identity and the
 *   相手 records with the same company domain (never a free-mail domain);
 * - `name`: records of that type whose title holds one of the title's words;
 * - the connector's declared search (`search`), read only: by the 相手's
 *   outside id (the search's `counterpart` filter) and by the title's words.
 *   Only outside items already imported through the current connection as a
 *   record of this plugin come back.
 * Every candidate is a live record **the member may read**; an unreadable one
 * is left out as if it did not exist (counts included). At most SIMILAR_MAX.
 * A search that cannot be asked now leaves ACB's own records (`unavailable`).
 */
import { identityKeysOf, isFreeMailDomain } from '../../shared/core/identity'
import { MEETING_TYPE } from '../../shared/core/minutes'
import type { SimilarRule } from '../../shared/core/plugins'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { LedgerValue } from '../../shared/core/record-ledger'
import type { TypeDefinition } from '../../shared/core/record-types'
import { SIMILAR_MAX, type SimilarRecord, type SimilarRecords } from '../../shared/types/approvals'
import type { CompanyData } from '../ports/company-data'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { EXTERNAL_ID_RE } from './plugin-connector'
import type { OperationChecks } from './plugin-operation-checks'
import { isObj, type PluginOperationDeps } from './plugin-operation-common'
import { TITLE_MAX } from './plugin-operation-inputs'
import { recordReader } from './record-access'
import { currentTypes } from './record-index'

/** HubSpot's search takes at most 5 filter groups: up to 2 相手 and 3 words. */
const COUNTERPART_GROUPS = 2
const NAME_WORDS = 3
const SCAN = 50

/** The title's words worth matching (2 characters or more, at most NAME_WORDS). */
export function titleWords(title: string): string[] {
  return [...new Set(title.normalize('NFC').split(/[\s\u3000（）()「」『』【】・,、。/]+/).filter(w => w.length >= 2))].slice(0, NAME_WORDS)
}

export function createOperationSimilar(
  deps: Pick<PluginOperationDeps, 'companyData' | 'plugins' | 'connector' | 'importer'> & { checks: Pick<OperationChecks, 'newRecordChecks' | 'precheckFor'> },
) {
  const { companyData, connector, importer, checks } = deps

  /** The 相手 the request is about: its meeting's 相手, with its 名寄せ identity and the same company domain — only records the member reads. */
  function counterpartsOf(member: Member, handle: CompanyData, meetingId: string | null): string[] {
    if (meetingId === null || !RECORD_ID_RE.test(meetingId)) return []
    const reader = recordReader(member, handle.scopes.listWithRules())
    const meeting = handle.records.byIds([meetingId])[0]
    if (!meeting || meeting.type !== MEETING_TYPE || meeting.removedAt !== null || !reader.record(meeting)) return []
    const counterpartTypes = new Set([...currentTypes(handle.records)].filter(([, t]) => t.definition.implements.includes('counterpart')).map(([n]) => n))
    const first = handle.records.linksFrom([meeting.id]).filter(l => l.name === 'counterpart' && l.targetId).map(l => l.targetId as string)
    const ids = new Set<string>(first)
    for (const id of first) {
      const m = handle.identities.member(id)
      if (m) for (const x of handle.identities.members(m.identityId)) ids.add(x.recordId)
      const s = handle.records.states([id])[0]
      const domain = s ? identityKeysOf(fieldsOf(s.fields)).domain : null
      if (domain && !isFreeMailDomain(domain) && counterpartTypes.size > 0) {
        for (const r of handle.records.candidates({ types: [...counterpartTypes], fields: [{ name: 'domain', values: [domain] }] }, SCAN)) ids.add(r.id)
      }
    }
    return handle.records.byIds([...ids]).filter(r => r.removedAt === null && counterpartTypes.has(r.type) && reader.record(r)).map(r => r.id)
  }

  return async function similarRecords(member: Member, pluginId: string, operation: string, input: { title: string; meetingId: string | null }): Promise<Outcome<SimilarRecords>> {
    const c = await checks.newRecordChecks(member, { kind: 'human' }, pluginId, operation)
    if (c.refusal) return c.refusal
    const { title } = input
    if (typeof title !== 'string' || title.trim() === '' || title.length > TITLE_MAX) return refuse('bad-request', `title: 1–${TITLE_MAX} characters`)
    const { plugin, op } = c
    const handle = companyData.forCompany(member.companyId)
    const reader = recordReader(member, handle.scopes.listWithRules())
    const recordType = plugin.manifest.objects[op.object]?.recordType ?? ''
    const def: TypeDefinition | undefined = plugin.types[recordType]
    const titleFrom = plugin.mapping.objects[op.object]?.fields.title?.from ?? null
    // Not declared: by name through the object's own search call (milestone 4's behaviour).
    const rule: SimilarRule = op.similar ?? {
      by: ['name'], status: null,
      search: plugin.manifest.objects[op.object]?.endpoints.search ? { operation: '', label: '', object: op.object, counterpart: null } : null,
    }
    const old = new Set(handle.plugins.oldConnectionRecordIds())
    const usable = (r: RecordRow | undefined): r is RecordRow => !!r && r.removedAt === null && r.type === recordType && !old.has(r.id) && reader.record(r)
    const found = new Map<string, SimilarRecord['matchedBy']>()
    const add = (rows: RecordRow[], why: SimilarRecord['matchedBy']) => {
      for (const r of [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))) {
        if (usable(r) && !found.has(r.id)) found.set(r.id, why)
      }
    }

    // 1. The same 相手 in ACB.
    const counterparts = rule.by.includes('counterpart') ? counterpartsOf(member, handle, input.meetingId) : []
    if (counterparts.length > 0) {
      const linked = [...new Set(handle.records.linksTo(counterparts).map(l => l.sourceId))]
      add(handle.records.byIds(linked), 'counterpart')
    }

    // 2. The connector's search (read only), by the 相手's outside id and the title's words.
    const words = rule.by.includes('name') ? titleWords(title) : []
    let outside: SimilarRecords['outside'] = 'not-asked'
    const search = rule.search
    if (search) {
      const groups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> = []
      if (search.counterpart && rule.by.includes('counterpart')) {
        const cp = search.counterpart
        const outsideIds = [...new Set(counterparts.map(id => handle.plugins.linkOfRecord(id))
          .filter(l => !!l && l.pluginId === pluginId && l.connectionId === plugin.connectionId && l.object === cp.object && EXTERNAL_ID_RE.test(l.externalId))
          .map(l => l!.externalId))].slice(0, COUNTERPART_GROUPS)
        for (const x of outsideIds) groups.push({ filters: [{ propertyName: cp.property, operator: 'EQ', value: x }] })
      }
      if (titleFrom) for (const w of words) groups.push({ filters: [{ propertyName: titleFrom, operator: 'CONTAINS_TOKEN', value: `*${w}*` }] })
      if (groups.length > 0) {
        outside = 'unavailable'
        const precheck = checks.precheckFor(member, { kind: 'human' }, plugin, ['viewer'], null, c.place, () => true)
        const account = await importer.verifyAccount(member.companyId, plugin, precheck).catch(() => null)
        if (account?.ok) {
          const r = await connector.call(member.companyId, plugin, {
            endpoint: 'search', object: search.object, body: { filterGroups: groups, properties: titleFrom ? [titleFrom] : [], limit: 20 },
          }, precheck).catch(() => null)
          if (r && r.ok && isObj(r.body) && Array.isArray(r.body.results)) {
            outside = 'checked'
            const ids: string[] = []
            for (const x of r.body.results) {
              if (!isObj(x) || typeof x.id !== 'string' || !EXTERNAL_ID_RE.test(x.id)) continue
              const link = handle.plugins.link(plugin.connectionId, account.accountId, search.object, x.id)
              if (link && link.pluginId === pluginId) ids.push(link.recordId)
            }
            add(handle.records.byIds(ids), 'outside')
          }
        }
      }
    }

    // 3. The title's words in ACB.
    for (const w of words) add(handle.records.byIds(handle.records.candidates({ types: [recordType], text: w }, SCAN).map(r => r.id)), 'name')

    const ids = [...found.keys()].slice(0, SIMILAR_MAX)
    const rows = new Map(handle.records.byIds(ids).map(r => [r.id, r]))
    const states = new Map(handle.records.states(ids).map(s => [s.recordId, s]))
    const items: SimilarRecord[] = ids.flatMap(id => {
      const row = rows.get(id)
      if (!row) return []
      const s = states.get(id)
      const fields = s ? fieldsOf(s.fields) : {}
      const statusField = rule.status ? def?.fields[rule.status] : undefined
      const raw = rule.status ? fields[rule.status] : undefined
      const status = statusField && typeof raw === 'string' ? statusField.optionLabels?.[raw] ?? raw : (s?.state ?? null)
      const assignee = def?.fields.assignee?.kind === 'person' && typeof fields.assignee === 'string' ? fields.assignee : null
      const updatedAt = s && s.updatedAt > row.updatedAt ? s.updatedAt : row.updatedAt
      return [{ recordId: id, title: row.title, status, assignee, updatedAt, matchedBy: found.get(id)! }]
    })
    return ok({ items, typeLabel: def?.label ?? recordType, outside })
  }
}

function fieldsOf(json: string): Record<string, LedgerValue> {
  try {
    const v = JSON.parse(json) as unknown
    return isObj(v) ? v as Record<string, LedgerValue> : {}
  } catch { return {} }
}
