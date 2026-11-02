/** Running an action of a record's type: the engine's five duties (records.md "The state engine"). */
import { FULL_ACCESS_ROLES, findPrivateScope } from '../../../shared/core/permissions'
import { isSameOrAncestorPath } from '../../../shared/core/paths'
import { actionWho, INTERFACES, OK_FIELDS, viaOf, type ActionDef } from '../../../shared/core/record-types'
import { ROLE_WHO_PREFIX } from '../../../shared/core/plugin-roles'
import type { LedgerAttachment, LedgerChange, LedgerDecision, LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import { fileLinkPath, RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordFileRepo } from '../../ports/record-files'
import type { RecordLinkRow } from '../../ports/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import { acceptanceOf } from '../../../shared/core/core-types'
import { applyAcceptance } from './acceptance'
import type { EngineContext } from './context'
import { linkLedgerValue, MAX_LINK_TARGETS, withLinkTargets } from './links'
import { ASSIGNEE_CANNOT_READ, REVIEWER_CANNOT_READ, bad, conflict, OK_BY_CANNOT_READ, serviceStateOnly, STATE_CHANGED_BY_SERVICE } from './refusals'
import { callVia, type ActorInput } from './types'
import { checkValue, NOTE_MAX, OK_REQUIRED, parseMaterials, parseOkStatement, provenance, REF_RE } from './values'

/**
 * May `member` (acting as `actor`) do an action whose `who` is this, on a record with these values?
 * `holdsRole(name)`: whether `member` holds the business role `role:<name>` on this record (plan C3,
 * services/plugin-roles.ts); without it a `role:` entry matches no one (fails closed).
 */
export function mayAct(who: string[], member: Member, actor: ActorInput, values: Record<string, LedgerValue>, managesPlace: boolean,
  holdsRole?: (role: string) => boolean): boolean {
  if (actor.kind === 'ai' && !who.includes('ai')) return false
  const people = who.filter(w => w !== 'ai')
  // `ai` alone: any member's AI may do it.
  if (people.length === 0) return actor.kind === 'ai'
  return people.some(w =>
    w === 'anyone' ||
    (w === 'admin' && FULL_ACCESS_ROLES.has(member.role)) ||
    (w === 'dept_manager' && managesPlace) ||
    (w.startsWith(ROLE_WHO_PREFIX) && holdsRole?.(w.slice(ROLE_WHO_PREFIX.length)) === true) ||
    values[w] === member.userId)
}

/** An action called from where its type's `via` does not list (records.md "Where an action may be called from"). */
export const NOT_VIA = { error: 'この操作はここからはできません。本体の画面から行ってください', code: 'NOT_VIA' } as const

export function acting(ctx: EngineContext) {
  const { deps, companyData, transactions, clock, open, canRead, stateOf, historyLine, tell, summaryOf } = ctx
  return {
    /** Run an action of the record's type. */
    async act(member: Member, actor: ActorInput, recordId: string, actionName: string, body: unknown): Promise<Outcome<{ record: RecordSummary; entry: LedgerEntry }>> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      // Approving / sending run through their services only (a company's definition adding an action changes nothing).
      if (serviceStateOnly(row.type)) return refuse('forbidden', STATE_CHANGED_BY_SERVICE.error, { code: STATE_CHANGED_BY_SERVICE.code })
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const action: ActionDef | undefined = Object.prototype.hasOwnProperty.call(def.actions, actionName) ? def.actions[actionName] : undefined
      if (!action) return refuse('not-found', 'この操作はありません', { code: 'ACTION_NOT_FOUND' })
      // Where it may be called from (`via`, plan 4b §5-13): a plugin's screen only where the type says so,
      // and never an action needing prior approval (approving is the core's card, whatever the definition says).
      const via = callVia(actor)
      if (!viaOf(action).includes(via) || (via === 'plugin' && action.approval === 'prior')) {
        return refuse('forbidden', NOT_VIA.error, { code: NOT_VIA.code })
      }

      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)

      const current = stateOf(records, row, def)
      // Duty 1: from the current state?
      if (action.from && (current.state === null || !action.from.includes(current.state))) {
        return conflict('いまの状態ではこの操作はできません', 'ACTION_NOT_ALLOWED_IN_STATE', { state: current.state })
      }
      // Duty 2: who?
      const place = row.path ?? row.folder ?? ''
      // `who_unless` (task version 9: the assignee does not complete a task to be checked first).
      const who = actionWho(action, current.fields)
      const manages = (userId: string) => who.includes('dept_manager') && deps.managedFolders(member.companyId, userId).some(f => isSameOrAncestorPath(f, place))
      // `role:<name>` (plan C3): held on this record (its plugin, its まとまり), by the one resolution.
      const holds = (userId: string) => (role: string) => ctx.roles()?.holdsOnRecord(member.companyId, row.type, row.id, role, userId) === true
      let byWho = mayAct(who, member, actor, current.fields, manages(member.userId), holds(member.userId))
      // …or as the delegate of an absent member (records.md "Absence and the delegate"): the turn
      // or department they stand in for — never the absentee's role (no admin powers), and every
      // read check above and below stays the delegate's own.
      let onBehalfOf: string | null = null
      if (!byWho) {
        for (const absentee of deps.actsFor?.(member.companyId, member.userId) ?? []) {
          if (mayAct(who, { ...member, userId: absentee, role: 'member' }, actor, current.fields, manages(absentee), holds(absentee))) {
            byWho = true
            onBehalfOf = absentee
            break
          }
        }
      }
      // …or, for a person `ok_from` names (never the AI), with a statement of whose OK it was.
      const withOk = !byWho && actor.kind === 'human' && (action.okFrom ?? []).some(w => current.fields[w] === member.userId)
      if (!byWho && !withOk) {
        return refuse('forbidden', actor.kind === 'ai' && !action.who.includes('ai')
          ? 'この操作は AI からはできません。本人が画面から行ってください'
          : 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
      }
      if (action.note === 'required' && note.trim() === '') return bad('この操作にはひとことのメモが要ります', 'NOTE_REQUIRED')
      let okStatement: { by: string | null; note: string | null } | null = null
      if (withOk) {
        const parsed = parseOkStatement(b.ok)
        if (typeof parsed === 'string') return bad(parsed, parsed === OK_REQUIRED ? 'OK_REQUIRED' : 'BAD_OK')
        if (parsed.by !== null) {
          if (parsed.by === member.userId) return bad('自分の OK では完了にできません。OK をくれた人を選ぶか、OK のいきさつを書いてください', 'OK_BY_SELF')
          // Someone who cannot read the record and anyone who is not a member here (another
          // company's id: `canRead` finds no role) get the same answer.
          if (!canRead(member.companyId, parsed.by, row)) return bad(OK_BY_CANNOT_READ.error, OK_BY_CANNOT_READ.code)
        }
        okStatement = parsed
      } else if (b.ok !== undefined && b.ok !== null) {
        // Only the path that needs it carries an OK statement (the ledger would claim an OK that decided nothing).
        return bad('この操作に OK した人の記入は要りません', 'OK_NOT_EXPECTED')
      }

      const isMember = (id: string) => deps.isMember(member.companyId, id)
      const rawArgs = (b.args ?? {}) as Record<string, unknown>
      if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return bad('args must be an object')
      for (const k of Object.keys(rawArgs)) if (!(k in action.args)) return bad(`Unknown argument ${k}`)
      const args: Record<string, LedgerValue> = {}
      for (const [name, kind] of Object.entries(action.args)) {
        if (rawArgs[name] === undefined || rawArgs[name] === null) return bad(`${name} is required`, 'ARG_REQUIRED')
        const v = checkValue(kind, rawArgs[name], def.fields[name]?.options, isMember)
        if (v !== null && typeof v === 'object') return bad(`${name}: ${v.error}`, 'BAD_VALUE')
        args[name] = v
      }

      if (typeof args.assignee === 'string' && !canRead(member.companyId, args.assignee, row)) {
        return bad(ASSIGNEE_CANNOT_READ, 'ASSIGNEE_CANNOT_READ')
      }
      // 確かめる人 (set_reviewer, request_review): never someone whose turn would be a record they cannot open.
      if (typeof args.reviewer === 'string' && !canRead(member.companyId, args.reviewer, row)) {
        return bad(REVIEWER_CANNOT_READ, 'REVIEWER_CANNOT_READ')
      }

      // Record links the action sets (`links` in its definition): readable live records of the link's type or interface.
      const linkChanges: Array<{ name: string; targets: string[] }> = []
      if (b.links !== undefined && b.links !== null) {
        if (typeof b.links !== 'object' || Array.isArray(b.links)) return bad('links must be an object')
        const types = currentTypes(records)
        for (const [name, value] of Object.entries(b.links as Record<string, unknown>)) {
          if (!(action.links ?? []).includes(name)) return bad(`This action does not set the link ${name}`, 'BAD_LINK')
          const l = def.links[name]
          const targets = value === null ? [] : Array.isArray(value) ? value : [value]
          if (l.cardinality === 'one' && targets.length > 1) return bad(`${name}: one record`, 'BAD_LINK')
          if (targets.length > MAX_LINK_TARGETS || !targets.every(t => typeof t === 'string' && RECORD_ID_RE.test(t))) return bad(`${name}: record ids`, 'BAD_LINK')
          const ids = [...new Set(targets as string[])]
          const fit = new Set(records.byIds(ids)
            .filter(r => (l.targetIsInterface ? types.get(r.type)?.definition.implements.includes(l.target) : r.type === l.target) && reader.record(r))
            .map(r => r.id))
          if (ids.some(t => !fit.has(t))) {
            // One answer for another type, an unreadable record, another company's and a missing id.
            const label = l.targetIsInterface ? (INTERFACES[l.target]?.label ?? l.target) : (types.get(l.target)?.definition.label ?? l.target)
            return refuse('bad-request', `つながり「${l.label}」には、あなたが見られる「${label}」の記録だけをつなげます`, { code: 'BAD_LINK', link: name })
          }
          linkChanges.push({ name, targets: ids })
        }
      }
      if (action.to === null && Object.keys(action.args).length === 0 && linkChanges.length === 0) return bad('links: the records to link', 'LINKS_REQUIRED')

      // Attached files (0.18-1): the versions handed over, checked to exist.
      const attachments: LedgerAttachment[] = []
      if (b.attachments !== undefined) {
        if (!Array.isArray(b.attachments) || b.attachments.length > 20) return bad('attachments: up to 20')
        if (action.attach.length === 0) return bad('This action attaches no files')
        const linked = records.linksFrom([row.id]).filter(l => l.targetPath !== null && action.attach.includes(l.name))
        for (const a of b.attachments as Array<Record<string, unknown>>) {
          const link = linked.find(l => l.name === a?.link && l.targetPath === (typeof a?.path === 'string' ? fileLinkPath(a.path) : null))
          if (!link || typeof a.commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(a.commit)) return bad('attachments: { link, path, commit } of files this record links', 'BAD_ATTACHMENT')
          const path = link.targetPath as string
          if (!reader.file(path)) return bad('attachments: { link, path, commit } of files this record links', 'BAD_ATTACHMENT')
          const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
          const priv = findPrivateScope(scopes, path)
          const repo: RecordFileRepo = priv?.repoId ? { kind: 'scope', repoId: priv.repoId } : { kind: 'company' }
          const inRepo = priv?.repoId ? path.slice(priv.path.length + 1) : path
          if (!await deps.files.fileAtCommit(member.companyId, repo, inRepo, a.commit)) {
            return conflict('添えたファイルの版がサーバーにありません。同期してからもう一度お試しください', 'ATTACHMENT_NOT_SYNCED')
          }
          attachments.push({ link: link.name, path, commit: a.commit })
        }
      }

      // Decision fields (§13.2 案 Y): only on actions marked as decisions.
      let decision: LedgerDecision | null = null
      if (b.decision !== undefined && b.decision !== null) {
        if (!action.decision) return bad('This action is not a decision')
        const d = b.decision as Record<string, unknown>
        const materials = parseMaterials(d.materials)
        if (typeof materials === 'string') return bad(materials)
        for (const m of materials) {
          if (m.kind === 'record') {
            const r = records.byIds([m.id]).find(x => reader.record(x))
            const v = r ? (records.states([r.id])[0]?.version ?? 0) : 0
            if (!r || m.version > v) return bad('materials: a record you can read, at a version it has had', 'BAD_MATERIAL')
          } else if (!reader.file(m.path)) return bad('materials: a file you can read', 'BAD_MATERIAL')
        }
        const precedents = d.precedents === undefined ? [] : d.precedents
        if (!Array.isArray(precedents) || precedents.length > 20 || !precedents.every(p => typeof p === 'string' && REF_RE.test(p))) return bad('precedents: up to 20 `<record id>@<version>`')
        if (d.supersedes !== undefined && d.supersedes !== null && (typeof d.supersedes !== 'string' || !REF_RE.test(d.supersedes))) return bad('supersedes: `<record id>@<version>`')
        if (d.policyVersion !== undefined && d.policyVersion !== null && (typeof d.policyVersion !== 'string' || d.policyVersion.length > 100)) return bad('policyVersion: up to 100 characters')
        decision = {
          reason: note, materials, policyVersion: (d.policyVersion as string | undefined) ?? null,
          precedents: precedents as string[], supersedes: (d.supersedes as string | undefined) ?? null,
        }
      }

      // The new values: the target state, the arguments copied into their fields, hand_to into next_actor.
      const nextFields: Record<string, LedgerValue> = { ...current.fields, ...args }
      if (action.handTo && def.implements.includes('request')) nextFields.next_actor = nextFields[action.handTo] ?? null
      let nextState = action.to ?? current.state
      // Acceptance (records.md "Acceptance"): a new assignee — or the AI handing work over — may
      // leave it 引き受け待ち; the assignee acting (「引き受ける」) accepts.
      const acceptance = acceptanceOf(row.type)
      if (acceptance) {
        const originChange = linkChanges.find(l => l.name === acceptance.origin)
        nextState = applyAcceptance(deps, {
          companyId: member.companyId, type: row.type, typeVersion: row.typeVersion ?? 0, personal: row.personalOwner !== null,
          state: nextState, fromState: current.state, fields: nextFields,
          assigneeChanged: typeof args.assignee === 'string' && args.assignee !== (current.fields.assignee ?? null),
          memberId: member.userId, actorKind: actor.kind, onBehalfOf,
          originIds: originChange ? originChange.targets : records.linksFrom([row.id]).filter(l => l.name === acceptance.origin && l.targetId !== null).map(l => l.targetId as string),
          records,
        })
      }
      // An OK statement belongs to the state change it was given for: written by that action,
      // cleared by any other state change (a reopen) so it never vouches for a later one.
      if (okStatement) {
        nextFields[OK_FIELDS.by] = okStatement.by
        nextFields[OK_FIELDS.note] = okStatement.note
      } else if (nextState !== current.state && Object.values(def.actions).some(a => a.okFrom)) {
        for (const f of Object.values(OK_FIELDS)) if ((nextFields[f] ?? null) !== null) nextFields[f] = null
      }
      const changes: LedgerChange[] = []
      if (nextState !== current.state) changes.push({ field: 'state', before: current.state, after: nextState })
      for (const [field, after] of Object.entries(nextFields)) {
        const before = current.fields[field] ?? null
        if (before !== after) changes.push({ field, before, after })
      }
      let nextLinks: RecordLinkRow[] | null = null
      if (linkChanges.length > 0) {
        const currentLinks = records.linksFrom([row.id])
        nextLinks = currentLinks
        for (const lc of linkChanges) {
          const target = def.links[lc.name].target
          const before = linkLedgerValue(target, currentLinks.filter(x => x.name === lc.name))
          nextLinks = withLinkTargets(row.id, nextLinks, lc.name, target, lc.targets)
          const after = linkLedgerValue(target, nextLinks.filter(x => x.name === lc.name))
          if (before !== after) changes.push({ field: `links.${lc.name}`, before, after })
        }
      }
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: actionName, fromState: current.state, toState: nextState,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note, changes, attachments,
        decision, isDecision: action.decision, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
        ...(onBehalfOf ? { onBehalfOf } : {}),
        ...(via === 'plugin' && actor.via ? { via: { plugin: actor.via.plugin, version: actor.via.version } } : {}),
      }
      // Duty 3: state and ledger together, only if nobody changed the record since `expectedVersion`.
      const expected = b.expectedVersion as number
      if (expected !== current.version) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: current.version })
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: nextState, fields: JSON.stringify(nextFields), version: entry.version, updatedAt: at }, expected)) return false
        if (nextLinks) records.replaceLinks(row.id, nextLinks)
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT')

      // Duty 4: tell whom the action names (and whose turn it now is).
      // Into a proposal (案): nobody's turn, so only whom the action names.
      const intoProposal = nextState !== null && (def.proposalStates ?? []).includes(nextState)
      tell(member, [...action.notify.map(n => nextFields[n]), ...(intoProposal ? [] : [nextFields.next_actor])], { type: row.type, entry, fields: nextFields })
      try { deps.afterAct?.(member.companyId, { type: row.type, entry, fields: nextFields }) } catch { /* the follow-up is the service's; the action stands */ }
      // Duty 5: the milestone line.
      if (action.historyLine) historyLine(member, row, action.label, actor, note, at)
      // A lane's reaction to the action (plan C5), after it was written.
      await ctx.afterAction(member, actor, { recordId: row.id, type: row.type, action: actionName, toState: nextState })
      return ok({ record: summaryOf(records, row.id), entry })
    },
  }
}
