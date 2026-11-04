/** Creating a record that lives on the server (records.md "The state engine"). */
import { SERVICE_OWNED_TYPES } from '../../../shared/core/core-types'
import { findPrivateScope } from '../../../shared/core/permissions'
import { noTurnStates } from '../../../shared/core/record-types'
import type { LedgerChange, LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import { fileLinkPath, newRecordId, RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordLinkRow } from '../../ports/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { currentTypes } from '../record-index'
import { RECORDS_DISABLED } from '../records'
import { acceptanceOf, proposalOf } from '../../../shared/core/core-types'
import { applyAcceptance } from './acceptance'
import type { EngineContext } from './context'
import { interfaceLinkMisses, interfaceLinkRefusal } from './links'
import { ASSIGNEE_CANNOT_READ, REVIEWER_CANNOT_READ, bad, FILE_NOT_LINKABLE, LINK_TARGET_NOT_FOUND, TYPE_CREATED_BY_SERVICE } from './refusals'
import type { ActorInput } from './types'
import { checkValue, provenance } from './values'
import { MEETING_OUTPUT_KEY_MAX, MEETING_OUTPUT_REUSED_NOTE } from '../../../shared/core/meeting-outputs'
import { findMeetingOutput, meetingOutputId } from '../meeting-outputs'

export function creating(ctx: EngineContext) {
  const { deps, companyData, transactions, clock, open, canRead, placeFolder, changed, tell, summaryOf } = ctx
  /**
   * What the member's AI makes, placed as the member would expect (records.md "Where the AI puts
   * a request", owner decision 2026-11-03): a request about the member alone → owner-only with
   * the member as assignee; another person named, or a department asked for → the department of
   * the consultation (`defaultFolder`, sent by the app; none = the whole company), assignee as said
   * or the member. A meeting's outputs keep their own place (minutes.md).
   */
  function aiPlacement(member: Member, body: unknown): unknown {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
    const { defaultFolder, ...rest } = body as Record<string, unknown>
    const opened = open(member)
    const def = opened && typeof rest.type === 'string' ? currentTypes(opened.records).get(rest.type)?.definition : undefined
    if (!opened || !def || !def.implements.includes('request') || def.fields.assignee?.source !== 'server') return rest
    const links = rest.links
    if (typeof links === 'object' && links !== null && (links as Record<string, unknown>).meeting !== undefined) return rest
    if (rest.fields !== undefined && (typeof rest.fields !== 'object' || rest.fields === null || Array.isArray(rest.fields))) return rest
    const fields = { ...(rest.fields as Record<string, unknown> | undefined) }
    const said = fields.assignee
    const noAssignee = said === undefined || said === null
    const someoneElse = typeof said === 'string' && said !== member.userId
    const folderSaid = rest.folder !== undefined && rest.folder !== null
    const personalAllowed = !opened.records.typeVersions().some(t => t.name === def.name && t.source === 'plugin')
    if (noAssignee) fields.assignee = member.userId
    if (rest.personal === true) return { ...rest, fields }
    if (rest.personal === undefined && !folderSaid && !someoneElse && personalAllowed) return { ...rest, personal: true, fields }
    const folder = folderSaid ? rest.folder : typeof defaultFolder === 'string' && defaultFolder.trim() !== '' ? defaultFolder : undefined
    return { ...rest, fields, ...(folder !== undefined ? { folder } : {}) }
  }

  const api = {
    /**
     * The member's AI (`POST /api/records-ai/item`, tool records_create): `create` after the
     * AI's defaults (`aiPlacement`). The answer says where it went (`placed`), for the AI to tell.
     */
    createByAi(member: Member, actor: ActorInput, body: unknown) {
      return api.create(member, actor, aiPlacement(member, body))
    },

    /**
     * A record that lives on the server (types with storage `server` or
     * `either`; a company's own file-backed type is created by writing its file).
     */
    create(member: Member, actor: ActorInput, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry | null; reused?: true; note?: string; placed?: { personal: boolean; folder: string | null } }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      if (typeof b.type !== 'string') return bad('type is required')
      const def = currentTypes(records).get(b.type)?.definition
      if (!def) return bad('Unknown type', 'TYPE_UNKNOWN')
      if (SERVICE_OWNED_TYPES.includes(def.name)) return bad(TYPE_CREATED_BY_SERVICE.error, TYPE_CREATED_BY_SERVICE.code)
      if (def.storage === 'file') return bad('Records of this type are files: create the file', 'FILE_RECORD')
      if (typeof b.title !== 'string' || b.title.trim() === '' || b.title.length > 200) return bad('title: 1–200 characters')
      if (b.summary !== undefined && (typeof b.summary !== 'string' || b.summary.length > 300)) return bad('summary: up to 300 characters')
      // The item key of a meeting's output (minutes.md "Outputs made once"): one line, with a meeting link.
      if (b.key !== undefined && b.key !== null && (typeof b.key !== 'string' || b.key.trim() === '' || b.key.length > MEETING_OUTPUT_KEY_MAX || /[\r\n]/.test(b.key))) {
        return bad(`key: 1–${MEETING_OUTPUT_KEY_MAX} characters on one line`)
      }
      const itemKey = typeof b.key === 'string' ? b.key.normalize('NFC').trim() : null
      // `personal: true` = owner-only (「持ち主だけ」): the creator alone sees it, never with a folder.
      if (b.personal !== undefined && typeof b.personal !== 'boolean') return bad('personal must be true or false')
      const personalOwner = b.personal === true ? member.userId : null
      // A business plugin's types (deal, customer) are the place other records take their readers
      // from (approvals, minutes, sent mail): never owner-only — also when a company extends one.
      if (personalOwner !== null && records.typeVersions().some(t => t.name === def.name && t.source === 'plugin')) {
        return bad('この種類の記録は自分用にはできません', 'PERSONAL_NOT_FOR_TYPE')
      }
      if (personalOwner !== null && b.folder !== undefined && b.folder !== null) {
        return bad('自分用の記録には部署を指定できません。部署に出すときは「部署に出す」を使ってください', 'PERSONAL_WITH_FOLDER')
      }
      let folder: string | null = null
      if (b.folder !== undefined && b.folder !== null) {
        const f = placeFolder(member, def.name, b.folder, reader)
        if (typeof f !== 'string') return f
        folder = f
      }
      const isMember = (id: string) => deps.isMember(member.companyId, id)
      const fields: Record<string, LedgerValue> = {}
      const rawFields = (b.fields ?? {}) as Record<string, unknown>
      if (typeof rawFields !== 'object' || rawFields === null || Array.isArray(rawFields)) return bad('fields must be an object')
      for (const [name, value] of Object.entries(rawFields)) {
        const f = def.fields[name]
        if (!f || f.source !== 'server') return bad(`${name} is not a server field of ${def.name}`)
        // Who accepted is the engine's to write (records.md "Acceptance"), never a create's.
        if (name === acceptanceOf(def.name)?.acceptedBy) return bad(`${name} is set by accepting`, 'BAD_VALUE')
        // Money (`money: true`) is written only through an approval request (plugins.md "Money"), never by a create.
        if (f.money) return bad(`「${f.label}」はお金の欄です。承認のお願いを通してだけ書けます`, 'MONEY_NEEDS_APPROVAL')
        const v = checkValue(f.kind, value, f.options, isMember)
        if (v !== null && typeof v === 'object') return bad(`${name}: ${v.error}`, 'BAD_VALUE')
        fields[name] = v
      }
      const place = { id: '', type: def.name, scopeId: null, path: null, folder, personalOwner }
      if (typeof fields.assignee === 'string' && !canRead(member.companyId, fields.assignee, place)) {
        return bad(ASSIGNEE_CANNOT_READ, 'ASSIGNEE_CANNOT_READ')
      }
      if (typeof fields.reviewer === 'string' && !canRead(member.companyId, fields.reviewer, place)) {
        return bad(REVIEWER_CANNOT_READ, 'REVIEWER_CANNOT_READ')
      }
      // The state it starts in: `initial`, or one the type lists in `create_states` (task: `preparing`, the AI's turn).
      let initial = def.initial
      if (b.state !== undefined && b.state !== null && b.state !== def.initial) {
        if (typeof b.state !== 'string' || !(def.createStates ?? []).includes(b.state)) {
          return bad(`state: ${[def.initial, ...(def.createStates ?? [])].filter(Boolean).join(' / ')}`, 'BAD_STATE')
        }
        initial = b.state
      }
      if (def.implements.includes('request')) {
        fields.requested_by ??= member.userId
        fields.next_actor ??= fields.assignee ?? null
      }
      const links: RecordLinkRow[] = []
      const rawLinks = (b.links ?? {}) as Record<string, unknown>
      if (typeof rawLinks !== 'object' || rawLinks === null || Array.isArray(rawLinks)) return bad('links must be an object')
      let id = newRecordId(def.name, deps.ids.newToken().slice(0, 16))
      for (const [name, value] of Object.entries(rawLinks)) {
        const l = def.links[name]
        if (!l) return bad(`${name} is not a link of ${def.name}`)
        const targets = Array.isArray(value) ? value : [value]
        if (targets.length > 50) return bad('At most 50 targets per link')
        for (const t of targets) {
          if (l.target === 'file') {
            const p = typeof t === 'string' ? fileLinkPath(t) : null
            if (!p) return bad(`${name}: a company path`)
            // As linking later: a file the member reads, never inside a private folder (the record is outside every one).
            if (!reader.file(p) || findPrivateScope(companyData.forCompany(member.companyId).scopes.listWithRules(), p)) {
              return bad(FILE_NOT_LINKABLE.error, FILE_NOT_LINKABLE.code)
            }
            links.push({ sourceId: id, name, position: links.length, targetId: null, targetPath: p, createdBy: member.userId })
          } else {
            if (typeof t !== 'string' || !RECORD_ID_RE.test(t)) return bad(`${name}: a record id`)
            // A live record the member reads: someone else's owner-only record, a private one and a
            // missing one get the same answer (none of them is named or confirmed). An interface link
            // is answered by its own check below (BAD_LINK, also one answer for missing / unreadable /
            // of another kind), so each link has exactly one refusal for an unseen target.
            if (!l.targetIsInterface && !records.byIds([t]).some(r => reader.record(r))) {
              return bad(LINK_TARGET_NOT_FOUND.error, LINK_TARGET_NOT_FOUND.code)
            }
            links.push({ sourceId: id, name, position: links.length, targetId: t, targetPath: null })
          }
        }
        if (interfaceLinkMisses(records, l, targets as string[], r => reader.record(r)).length > 0) {
          const r = interfaceLinkRefusal(name, l)
          return refuse('bad-request', r.error, { code: r.code })
        }
      }
      // What a meeting's reading makes, made once: the same item of the same meeting is the answer.
      const meetingId = def.links.meeting?.target === 'meeting' ? links.find(l => l.name === 'meeting' && l.targetId)?.targetId ?? null : null
      if (itemKey !== null && !meetingId) return bad('key: only for a record linked to its meeting (links.meeting)', 'KEY_NEEDS_MEETING')
      if (meetingId) {
        const keyed = itemKey !== null && deps.tokenDigest ? meetingOutputId(deps.tokenDigest, def.name, meetingId, itemKey) : null
        const keyTaken = keyed !== null && records.byIds([keyed]).some(r => r.removedAt === null)
        const same = findMeetingOutput(records, r => reader.record(r), { type: def.name, meetingId, title: b.title as string, byId: keyed })
        if (same) return ok({ record: summaryOf(records, same.id), entry: null, reused: true as const, note: MEETING_OUTPUT_REUSED_NOTE })
        // The key's record exists but the member does not read it: never a second one, never named.
        if (keyTaken) return refuse('conflict', 'この目印の記録は、すでにほかの場所にあります', { code: 'KEY_TAKEN' })
        if (keyed) {
          id = keyed
          for (const l of links) l.sourceId = keyed
        }
      }
      // A proposal (案, task version 11): the AI's homework of a meeting, as the company says.
      const proposal = proposalOf(def.name)
      if (proposal && actor.kind === 'ai' && deps.proposesFromMeeting && (def.proposalStates ?? []).includes(proposal.state)
        && links.some(l => l.name === proposal.origin && l.targetId !== null) && (initial === def.initial || initial === proposal.state)) {
        initial = deps.proposesFromMeeting(member.companyId) ? proposal.state : def.initial
      }
      // Acceptance (records.md "Acceptance"): asked of someone else → 引き受け待ち unless the setting accepts it.
      const origin = acceptanceOf(def.name)?.origin
      initial = applyAcceptance(deps, {
        companyId: member.companyId, type: def.name, typeVersion: def.version, personal: personalOwner !== null, state: initial, fields,
        // The creator is the one asking (a `requested_by` in the body never makes it the assignee's own).
        assigneeChanged: true, memberId: member.userId, actorKind: actor.kind, onBehalfOf: null,
        originIds: links.filter(l => l.name === origin && l.targetId !== null).map(l => l.targetId as string), records,
      })
      const at = clock.now()
      const changes: LedgerChange[] = [
        { field: 'state', before: null, after: initial },
        ...Object.entries(fields).filter(([, v]) => v !== null).map(([field, after]) => ({ field, before: null, after })),
      ]
      const entry: LedgerEntry = {
        recordId: id, version: 1, action: 'create', fromState: null, toState: initial, actorId: member.userId, actorKind: actor.kind,
        actorSource: actor.source ?? null, at, note: '', changes, attachments: [], decision: null, isDecision: false,
        typeVersion: def.version, reversesVersion: null, ...provenance(actor),
      }
      transactions.run(() => {
        records.upsert({
          id, type: def.name, typeVersion: def.version, scopeId: null, path: null, folder, personalOwner,
          title: b.title as string, summary: typeof b.summary === 'string' ? b.summary : '', createdAt: at, updatedAt: at, removedAt: null,
        })
        records.replaceLinks(id, links)
        if (!records.writeState({ recordId: id, state: initial, fields: JSON.stringify(fields), version: 1, updatedAt: at }, 0)) throw new Error('record id taken')
        records.appendLedger(entry)
      })
      // While it is the AI's turn nobody is told: the person hears when the AI hands it over. A proposal (案) tells nobody either.
      if (initial === null || !noTurnStates(def).has(initial)) tell(member, [fields.next_actor, fields.assignee], { type: def.name, entry, fields })
      else changed(member.companyId, id)
      return ok({ record: summaryOf(records, id), entry, placed: { personal: personalOwner !== null, folder } })
    },
  }
  return api
}
