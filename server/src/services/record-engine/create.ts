/** Creating a record that lives on the server (records.md "The state engine"). */
import { SERVICE_OWNED_TYPES } from '../../../shared/core/core-types'
import { canReadPrivateScope, findPrivateScope, FULL_ACCESS_ROLES } from '../../../shared/core/permissions'
import { noTurnStates } from '../../../shared/core/record-types'
import type { LedgerChange, LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import { fileLinkPath, newRecordId, RECORD_ID_RE } from '../../../shared/core/records'
import { isSameOrAncestorPath, normalizeRepoPath, pathKey } from '../../../shared/core/paths'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordLinkRow, RecordMemberSet } from '../../ports/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { currentTypes } from '../record-index'
import { RECORDS_DISABLED } from '../records'
import { acceptanceOf, messageOriginLinks, proposalOf, SLOT_FIELDS } from '../../../shared/core/core-types'
import { DEFAULT_TASK_SETTINGS, replyTarget } from '../../../shared/core/task-settings'
import { applyAcceptance } from './acceptance'
import type { EngineContext } from './context'
import { interfaceLinkMisses, interfaceLinkRefusal } from './links'
import { ASSIGNEE_CANNOT_READ, REVIEWER_CANNOT_READ, bad, FILE_NOT_LINKABLE, fileLinksUnavailable, FOLDER_NOT_PLACEABLE, featureOffRefusal, LINK_TARGET_NOT_FOUND, TYPE_CREATED_BY_SERVICE } from './refusals'
import type { ActorInput } from './types'
import { checkValue, provenance } from './values'
import { MEETING_OUTPUT_KEY_MAX } from '../../../shared/core/meeting-outputs'
import { slotQuote } from '../../../shared/core/source-slot-candidates'
import { decideSlot, similarInSlot, slotScope } from '../source-slot-candidates'
import { meetingMembers, membersList, withNamedPeople } from './members'
import { placeOfRow } from './service-writer'
import { coreStepCreateTypes } from '../../../shared/core/ai-runs'
import { defaultBundleFolder } from '../../../shared/core/bundle-place'
import { BUNDLE_PLACED_TYPES, bundleLinkName, linkedBundle, placeWithin, WIDER_THAN_BUNDLE } from './bundle-place'
import { notInStep } from '../not-in-step'

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
    // A list of members says where it goes (records.md "Members-only records"): no defaults added.
    if (rest.members !== undefined && rest.members !== null) return rest
    const opened = open(member)
    const def = opened && typeof rest.type === 'string' ? currentTypes(opened.records).get(rest.type)?.definition : undefined
    // A new まとまり (案件・プロジェクト) belongs to the member's own department (所属) unless the AI names
    // one (records.md "A task and its 案件・プロジェクト"): the one on screen when it is theirs, else their first.
    if (opened && def && def.implements.includes('bundle') && (rest.folder === undefined || rest.folder === null) && rest.personal !== true) {
      const handle = companyData.forCompany(member.companyId)
      const folder = defaultBundleFolder({
        departments: handle.departments.list().map(d => ({ id: d.id, folder: d.folder })),
        mine: handle.tasks.departmentIdsOf(member.userId),
        onScreen: typeof defaultFolder === 'string' && defaultFolder.trim() !== '' ? defaultFolder : null,
      })
      return folder !== null ? { ...rest, folder } : rest
    }
    if (!opened || !def || !def.implements.includes('request') || def.fields.assignee?.source !== 'server') return rest
    const links = rest.links
    if (typeof links === 'object' && links !== null && (links as Record<string, unknown>).meeting !== undefined) return rest
    // Made for a まとまり: it takes the まとまり's place (create), never the consultation's department.
    const bundleLink = bundleLinkName(def)
    const forBundle = bundleLink !== null && typeof links === 'object' && links !== null && (links as Record<string, unknown>)[bundleLink] != null
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
    const folder = folderSaid ? rest.folder : !forBundle && typeof defaultFolder === 'string' && defaultFolder.trim() !== '' ? defaultFolder : undefined
    return { ...rest, fields, ...(folder !== undefined ? { folder } : {}) }
  }

  /**
   * A built-in 「AI の番」 step's run creates only what its job needs (`CORE_STEP_CREATE_TYPES`,
   * ai-turns.md): text from outside starts it, so an AI whose token is bound to such a run gets
   * 403 `NOT_IN_STEP` for any other type, before anything is checked or written. A business
   * plugin's step has its own gate (C4); a consultation's token is not bound to a run.
   */
  function builtInStepRefusal(member: Member, actor: ActorInput, body: unknown) {
    if (actor.kind !== 'ai' || !actor.runId) return null
    const run = companyData.forCompany(member.companyId).aiRuns.byId(actor.runId)
    const types = run ? coreStepCreateTypes(run.step) : undefined
    if (types === undefined) return null
    const type = typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined
    return typeof type === 'string' && types.includes(type) ? null : notInStep()
  }

  /**
   * A request the AI makes from a message that came in (an origin link to an interaction: a task's
   * もとの連絡; inbox.md "A task from a message", owner FB #13) never lands without a due: the
   * deadline the AI read in the message (`fields.due`, kept), else the company's reply 目安 from
   * when the message came — the rule a 返事のお願い uses (`replyTarget`: 翌営業日 / 当日中, weekends,
   * public and company holidays). A person may change or remove it afterwards.
   */
  function messageDue(member: Member, body: unknown): unknown {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
    const b = body as Record<string, unknown>
    const opened = open(member)
    const def = opened && typeof b.type === 'string' ? currentTypes(opened.records).get(b.type)?.definition : undefined
    if (!opened || !def || !def.implements.includes('request') || def.fields.due?.source !== 'server' || def.fields.due.kind !== 'date') return body
    if (b.fields !== undefined && (typeof b.fields !== 'object' || b.fields === null || Array.isArray(b.fields))) return body
    const fields = (b.fields ?? {}) as Record<string, unknown>
    if (fields.due !== undefined && fields.due !== null) return body
    const links = b.links
    if (typeof links !== 'object' || links === null || Array.isArray(links)) return body
    const said = messageOriginLinks(def).map(name => (links as Record<string, unknown>)[name]).find(v => v !== undefined)
    const target = Array.isArray(said) ? said[0] : said
    if (typeof target !== 'string' || !RECORD_ID_RE.test(target)) return body
    // Only a message the member reads (else `create` refuses the link with its usual answer).
    const row = opened.records.byIds([target]).find(r => r.removedAt === null && opened.reader.record(r))
    if (!row) return body
    let occurred: string | null = null
    try {
      const v = (JSON.parse(opened.records.states([row.id])[0]?.fields ?? '{}') as Record<string, unknown>).occurred_at
      occurred = typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null
    } catch { occurred = null }
    const at = occurred ?? clock.now()
    const due = deps.replyGuideline?.(member.companyId, at) ?? replyTarget(at, DEFAULT_TASK_SETTINGS.reply).date
    return { ...b, fields: { ...fields, due } }
  }

  const api = {
    /**
     * Before a create, an AI's create (`byAi`: after its defaults) or a share that names a folder
     * (the routes call it first; the engine itself is synchronous): a folder that is not in the
     * company folder gets the same answer as one inside a private folder (`FOLDER_NOT_PLACEABLE`),
     * so an answer never tells whether a private folder of that name exists (audit B-M1). Not
     * known (no repository, git failed, no `folderExists`) → left to `create` / `share`.
     */
    async checkPlace(member: Member, body: unknown, byAi = false): Promise<Outcome<null>> {
      if (!deps.folderExists) return ok(null)
      const placed = byAi ? aiPlacement(member, body) : body
      if (typeof placed !== 'object' || placed === null || Array.isArray(placed)) return ok(null)
      const raw = (placed as Record<string, unknown>).folder
      const f = typeof raw === 'string' ? normalizeRepoPath(raw) : null
      if (!f) return ok(null)
      // A private folder the member reads is not in the company repository: the engine alone decides
      // there (`placeFolder` allows only a まとまり's own one). An unreadable one still gets the answer below.
      const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
      const priv = findPrivateScope(scopes, f)
      if (priv && canReadPrivateScope(priv, member.userId, member.role)) return ok(null)
      let exists: boolean | null
      try { exists = await deps.folderExists(member.companyId, f) } catch { exists = null }
      return exists === false ? bad(FOLDER_NOT_PLACEABLE.error, FOLDER_NOT_PLACEABLE.code) : ok(null)
    },

    /**
     * The member's AI (`POST /api/records-ai/item`, tool records_create): `create` after the
     * AI's defaults (`aiPlacement`, and a due for what comes from a message: `messageDue`). The
     * answer says where it went (`placed`), for the AI to tell.
     */
    createByAi(member: Member, actor: ActorInput, body: unknown) {
      const outsideStep = builtInStepRefusal(member, actor, body)
      if (outsideStep) return outsideStep
      return api.create(member, actor, messageDue(member, aiPlacement(member, body)))
    },

    /**
     * A record that lives on the server (types with storage `server` or
     * `either`; a company's own file-backed type is created by writing its file).
     */
    create(member: Member, actor: ActorInput, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry | null; reused?: true; note?: string; similar?: { id: string; title: string }; placed?: { personal: boolean; folder: string | null; membersOnly?: true } }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      if (typeof b.type !== 'string') return bad('type is required')
      const def = currentTypes(records).get(b.type)?.definition
      if (!def) return bad('Unknown type', 'TYPE_UNKNOWN')
      if (SERVICE_OWNED_TYPES.includes(def.name)) return bad(TYPE_CREATED_BY_SERVICE.error, TYPE_CREATED_BY_SERVICE.code)
      // A feature turned off makes nothing new (「使う機能」: a `project` while プロジェクト is off).
      const off = featureOffRefusal(deps.featureOff, member.companyId, def.name)
      if (off) return off
      if (def.storage === 'file') return bad('Records of this type are files: create the file', 'FILE_RECORD')
      if (typeof b.title !== 'string' || b.title.trim() === '' || b.title.length > 200) return bad('title: 1–200 characters')
      if (b.summary !== undefined && (typeof b.summary !== 'string' || b.summary.length > 300)) return bad('summary: up to 300 characters')
      // The item key of a meeting's output (minutes.md "Outputs made once"): one line, with a meeting link.
      if (b.key !== undefined && b.key !== null && (typeof b.key !== 'string' || b.key.trim() === '' || b.key.length > MEETING_OUTPUT_KEY_MAX || /[\r\n]/.test(b.key))) {
        return bad(`key: 1–${MEETING_OUTPUT_KEY_MAX} characters on one line`)
      }
      const itemKey = typeof b.key === 'string' ? b.key.normalize('NFC').trim() : null
      // The basis quote of a meeting's output (task version 13, the source's slot): its identity there.
      const quote = b.quote === undefined || b.quote === null ? null : slotQuote(b.quote)
      if (b.quote !== undefined && b.quote !== null && quote === null) return bad('quote: the minutes text the output rests on, copied as is (6–300 characters)', 'BAD_QUOTE')
      // `personal: true` = owner-only (「持ち主だけ」): the creator alone sees it, never with a folder.
      if (b.personal !== undefined && typeof b.personal !== 'boolean') return bad('personal must be true or false')
      let personalOwner = b.personal === true ? member.userId : null
      // A business plugin's types (deal, customer) are the place other records take their readers
      // from (approvals, minutes, sent mail): never owner-only — also when a company extends one.
      if (personalOwner !== null && records.typeVersions().some(t => t.name === def.name && t.source === 'plugin')) {
        return bad('この種類の記録は自分用にはできません', 'PERSONAL_NOT_FOR_TYPE')
      }
      if (personalOwner !== null && b.folder !== undefined && b.folder !== null) {
        return bad('自分用の記録には部署を指定できません。部署に出すときは「部署に出す」を使ってください', 'PERSONAL_WITH_FOLDER')
      }
      // `members` = members-only (「この人たちだけ」, records.md "Members-only records"): the creator and these.
      const isPluginType = records.typeVersions().some(t => t.name === def.name && t.source === 'plugin')
      let members: string[] | null = null
      // Groups / departments on the list: only ever inherited here (a meeting's, a まとまり's); a person adds them by 招待する.
      let memberSets: RecordMemberSet[] = []
      if (b.members !== undefined && b.members !== null) {
        if (personalOwner !== null || (b.folder !== undefined && b.folder !== null)) {
          return bad('見る人を選んだ記録には、自分用や部署を一緒に指定できません', 'MEMBERS_WITH_PLACE')
        }
        if (isPluginType) return bad('この種類の記録は見る人を選んで作れません', 'MEMBERS_NOT_FOR_TYPE')
        const list = membersList(b.members, id => deps.isMember(member.companyId, id))
        if (!Array.isArray(list)) return bad(list.error, list.code)
        members = [...new Set([member.userId, ...list])]
      }
      let folder: string | null = null
      if (b.folder !== undefined && b.folder !== null) {
        // A 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"): a まとまり made by a person in its own
        // private folder — exactly that folder, by someone who may manage it (owner/admin, the
        // department's manager: who may create a private folder there). Anything else stays refused.
        const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
        const ownPrivate = (f: string) => actor.kind === 'human' && def.implements.includes('bundle')
          && scopes.some(s => s.repoId !== null && pathKey(s.path) === pathKey(f))
          && (FULL_ACCESS_ROLES.has(member.role) || deps.managedFolders(member.companyId, member.userId).some(d => isSameOrAncestorPath(d, f) && pathKey(d) !== pathKey(f)))
        const f = placeFolder(member, def.name, b.folder, reader, ownPrivate)
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
        // 「似ている案」 and 「別のもの」 are the slot's and the person's (task version 13), never a create's.
        if (name === SLOT_FIELDS.similarTo || name === SLOT_FIELDS.apartBy) return bad(`${name} is set by the server`, 'BAD_VALUE')
        // Money (`money: true`) is written only through an approval request (plugins.md "Money"), never by a create.
        if (f.money) return bad(`「${f.label}」はお金の欄です。承認のお願いを通してだけ書けます`, 'MONEY_NEEDS_APPROVAL')
        const v = checkValue(f.kind, value, f.options, isMember)
        if (v !== null && typeof v === 'object') return bad(`${name}: ${v.error}`, 'BAD_VALUE')
        fields[name] = v
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
            const noFolder = fileLinksUnavailable(deps.hasCompanyFolder, member.companyId)
            if (noFolder) return noFolder
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
      // Made from a members-only meeting: members-only too — the meeting's list and the people named
      // here (records.md "Members-only records"); never placed wider by the system.
      const meetingList = personalOwner === null ? meetingMembers(records, links) : null
      // The AI may narrow a meeting's list but not widen it: showing it to others is a person's act.
      if (meetingList !== null && members !== null && actor.kind === 'ai') {
        const allowed = new Set(withNamedPeople([member.userId, ...meetingList.readers], def, fields))
        if (members.some(u => !allowed.has(u))) return bad('会議に出ていない人を、AI が見る人に足すことはできません', 'MEMBERS_NOT_IN_MEETING')
      }
      const inherited = members === null ? meetingList : null
      if (inherited !== null) {
        if (folder !== null) return bad('見る人が決まった会議からできた記録には、部署を指定できません', 'MEMBERS_WITH_PLACE')
        if (isPluginType) return bad('この種類の記録は見る人を選んで作れません', 'MEMBERS_NOT_FOR_TYPE')
        members = withNamedPeople([member.userId, ...inherited.users], def, fields)
        memberSets = inherited.sets
      }
      // A task that belongs to a まとまり is never seen by more people than the まとまり (records.md "A task
      // and its 案件・プロジェクト"): with no place of its own it takes the まとまり's (`placeOfRow`'s three
      // kinds); a place given is kept only when it is within. Owner-only stays owner-only.
      if (BUNDLE_PLACED_TYPES.includes(def.name) && personalOwner === null) {
        const bundle = linkedBundle(records, def, links, r => reader.record(r))
        if (bundle && folder === null && members === null) {
          const from = placeOfRow(bundle)
          if ('personalOwner' in from) personalOwner = from.personalOwner
          else if ('members' in from) { members = [...from.members]; memberSets = [...(from.memberSets ?? [])] }
          else folder = from.folder
        } else if (bundle) {
          const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
          const task = { id: '', type: def.name, scopeId: null, path: null, folder, personalOwner, members, memberSets }
          if (!placeWithin(member.companyId, scopes, id => deps.roleOf(member.companyId, id), task, bundle)) {
            return bad(WIDER_THAN_BUNDLE.error, WIDER_THAN_BUNDLE.code)
          }
        }
      }
      const place = { id: '', type: def.name, scopeId: null, path: null, folder, personalOwner, members, memberSets }
      if (typeof fields.assignee === 'string' && !canRead(member.companyId, fields.assignee, place)) {
        return bad(ASSIGNEE_CANNOT_READ, 'ASSIGNEE_CANNOT_READ')
      }
      if (typeof fields.reviewer === 'string' && !canRead(member.companyId, fields.reviewer, place)) {
        return bad(REVIEWER_CANNOT_READ, 'REVIEWER_CANNOT_READ')
      }
      // What an AI makes from a meeting is a candidate in the meeting's slot (出どころの枠, minutes.md
      // "Outputs made once"): the one place that decides new or already there is source-slot-candidates.
      // A person's create is free (only a hint in the answer), and so is an owner-only one (「あなただけ」
      // is never compared).
      const meetingId = def.links.meeting?.target === 'meeting' ? links.find(l => l.name === 'meeting' && l.targetId)?.targetId ?? null : null
      if (itemKey !== null && !meetingId) return bad('key: only for a record linked to its meeting (links.meeting)', 'KEY_NEEDS_MEETING')
      if (quote !== null && !meetingId) return bad('quote: only for a record linked to its meeting (links.meeting)', 'QUOTE_NEEDS_MEETING')
      if (quote !== null && def.fields[SLOT_FIELDS.basis]?.source === 'server' && fields[SLOT_FIELDS.basis] === undefined) fields[SLOT_FIELDS.basis] = quote
      let similar: { id: string; title: string } | null = null
      let slotNote: string | null = null
      if (meetingId && actor.kind === 'ai' && personalOwner === null) {
        const slot = decideSlot(records, r => reader.record(r), deps.tokenDigest, {
          slot: { sourceId: meetingId, linkName: 'meeting', kind: def.name }, title: b.title as string, quote, serialKey: itemKey, scope: slotScope(actor),
        })
        if (slot.kind === 'existing') return ok({ record: summaryOf(records, slot.row.id), entry: null, reused: true as const, note: slot.note })
        if (slot.id !== null) {
          id = slot.id
          for (const l of links) l.sourceId = slot.id
        }
        if (slot.similarTo && def.fields[SLOT_FIELDS.similarTo]?.source === 'server') {
          similar = slot.similarTo
          fields[SLOT_FIELDS.similarTo] = slot.similarTo.id
        }
        slotNote = slot.note
      } else if (meetingId && actor.kind === 'human' && personalOwner === null) {
        // A person's create stays free (§10): never refused or merged, only told 「似ているやることがあります」.
        similar = similarInSlot(records, r => reader.record(r), { slot: { sourceId: meetingId, linkName: 'meeting', kind: def.name }, title: b.title as string })
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
          id, type: def.name, typeVersion: def.version, scopeId: null, path: null, folder, personalOwner, members,
          title: b.title as string, summary: typeof b.summary === 'string' ? b.summary : '', createdAt: at, updatedAt: at, removedAt: null,
        })
        if (members !== null) records.addMembers(id, members, member.userId, at)
        if (members !== null && memberSets.length > 0) records.addMemberSets(id, memberSets, member.userId, at)
        records.replaceLinks(id, links)
        if (!records.writeState({ recordId: id, state: initial, fields: JSON.stringify(fields), version: 1, updatedAt: at }, 0)) throw new Error('record id taken')
        records.appendLedger(entry)
      })
      // While it is the AI's turn nobody is told: the person hears when the AI hands it over. A proposal (案) tells nobody either.
      if (initial === null || !noTurnStates(def).has(initial)) tell(member, [fields.next_actor, fields.assignee], { type: def.name, entry, fields })
      else changed(member.companyId, id)
      return ok({
        record: summaryOf(records, id), entry, placed: { personal: personalOwner !== null, folder, ...(members !== null ? { membersOnly: true as const } : {}) },
        ...(similar ? { similar, ...(slotNote ? { note: slotNote } : {}) } : {}),
      })
    },
  }
  return api
}
