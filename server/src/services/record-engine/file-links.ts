/** Linking a file to a record after it was made, or removing that link (records.md "Linking files later"). */
import { findPrivateScope } from '../../../shared/core/permissions'
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { fileLinkPath, fileLinkShown, RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordLinkRow } from '../../ports/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { linkAllowed } from '../record-access'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { linkLedgerValue, MAX_LINK_TARGETS } from './links'
import { bad, conflict, FILE_NOT_LINKABLE, serviceStateOnly, STATE_CHANGED_BY_SERVICE } from './refusals'
import type { ActorInput } from './types'
import { NOTE_MAX, provenance } from './values'

export function fileLinking(ctx: EngineContext) {
  const { companyData, transactions, clock, open, stateOf, summaryOf } = ctx
  return {
    /**
     * Link a file to a record after it was made, or remove that link
     * (records.md "Linking files later"). Any type with a `file` link; the
     * caller must read the record and the file, and the link must be one the
     * record may have at all (`linkAllowed`: never into a private folder from
     * outside it). The member's AI only on types that let the AI act at all
     * (an action whose `who` lists `ai`). A ledger entry `link_file` /
     * `unlink_file` with `links.<name>` before / after, so it can be undone.
     */
    fileLink(member: Member, actor: ActorInput, recordId: string, op: 'link' | 'unlink', body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry | null; changed: boolean }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      if (serviceStateOnly(row.type)) return refuse('forbidden', STATE_CHANGED_BY_SERVICE.error, { code: STATE_CHANGED_BY_SERVICE.code })
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      if (actor.kind === 'ai' && !Object.values(def.actions).some(a => a.who.includes('ai'))) {
        return refuse('forbidden', 'この記録のつながりは AI からは変えられません。本人が画面から行ってください', { code: 'NOT_ALLOWED' })
      }
      // A file record's links are its text (the next index of the file would overwrite them).
      if (row.path !== null) return bad('この記録のつながりはファイルに書かれています。ファイルを直してください', 'FILE_RECORD')

      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      const fileLinks = Object.entries(def.links).filter(([, l]) => l.target === 'file').map(([name]) => name)
      if (fileLinks.length === 0) return bad('この種類の記録にはファイルをつなげません', 'NO_FILE_LINK')
      const name = b.link === undefined && fileLinks.length === 1 ? fileLinks[0] : b.link
      if (typeof name !== 'string' || !fileLinks.includes(name)) return bad(`link: one of ${fileLinks.join(', ')}`, 'BAD_LINK')
      const path = typeof b.path === 'string' ? fileLinkPath(b.path) : null
      if (!path) return bad('path: a path inside the company folder', 'BAD_PATH')
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)

      // The member must read the file, and the record may hold a link to it at all: one answer, no place named.
      const priv = findPrivateScope(companyData.forCompany(member.companyId).scopes.listWithRules(), path)
      if (!reader.file(path) || !linkAllowed(row, { scopeId: priv?.id ?? null })) {
        return bad(FILE_NOT_LINKABLE.error, FILE_NOT_LINKABLE.code)
      }

      const current = stateOf(records, row, def)
      const expected = b.expectedVersion as number
      if (expected !== current.version) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: current.version })
      const allLinks = records.linksFrom([row.id])
      const mine = allLinks.filter(l => l.name === name)
      // A `.personal/` link someone else made is not there for this member (records.md "Links into .personal/").
      const shown = mine.filter(l => fileLinkShown(member.userId, row, l))
      let nextLinks: RecordLinkRow[]
      if (op === 'link') {
        if (shown.some(l => l.targetPath === path)) return ok({ record: summaryOf(records, row.id), entry: null, changed: false })
        const added: RecordLinkRow = { sourceId: row.id, name, position: 0, targetId: null, targetPath: path, createdBy: member.userId }
        const kept = def.links[name].cardinality === 'one' ? allLinks.filter(l => l.name !== name) : allLinks
        if (kept.filter(l => l.name === name).length + 1 > MAX_LINK_TARGETS) return bad(`At most ${MAX_LINK_TARGETS} files per link`, 'TOO_MANY_LINKS')
        nextLinks = [...kept, added]
      } else {
        const gone = shown.find(l => l.targetPath === path)
        if (!gone) return refuse('not-found', 'このファイルはこの記録につながっていません', { code: 'LINK_NOT_FOUND' })
        nextLinks = allLinks.filter(l => l !== gone)
      }
      nextLinks = nextLinks.map((l, i) => ({ ...l, position: i }))
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: op === 'link' ? 'link_file' : 'unlink_file', fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [{ field: `links.${name}`, before: linkLedgerValue('file', mine), after: linkLedgerValue('file', nextLinks.filter(l => l.name === name)) }],
        attachments: [], decision: null, isDecision: false, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
      }
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) return false
        records.replaceLinks(row.id, nextLinks)
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT')
      return ok({ record: summaryOf(records, row.id), entry, changed: true })
    },
  }
}
