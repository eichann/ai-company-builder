/**
 * Linking a file to a record after it was made, or removing that link (records.md "Linking files
 * later", "File links without the shared folder").
 */
import { FILE_LINK_KIND_NOT_HERE, TYPED_LINK_PERSON_ONLY } from '../../../shared/core/company-folder'
import { findPrivateScope } from '../../../shared/core/permissions'
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { driveLinkTarget, fileLinkKind, fileLinkPath, fileLinkShown, localLinkTarget, RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordLinkRow } from '../../ports/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { linkAllowed } from '../record-access'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { linkLedgerValue, MAX_LINK_TARGETS } from './links'
import { bad, conflict, FILE_NOT_LINKABLE, fileLinksUnavailable, featureOffRefusal, serviceStateOnly, STATE_CHANGED_BY_SERVICE } from './refusals'
import { personalPathsSeen, scrubLedger } from './personal-links'
import type { ActorInput, VerifiedDriveFile } from './types'
import { NOTE_MAX, provenance } from './values'

/** A Drive link needs the connector's check of the linker's own pick (the route's, never a body). */
const DRIVE_NOT_CHECKED = {
  code: 'DRIVE_NOT_PICKED',
  error: 'Google Drive で選んだファイルだけをつなげます。もう一度選んでください。',
} as const

type FileLinkAnswer = { record: RecordSummary; entry: LedgerEntry | null; changed: boolean }

/** The 経緯 line of a link that followed a Drive file's new revision (the put updated the file). */
const FOLLOWED_NOTE = 'Google Drive のファイルを上書きしたので、新しい版につなぎ直しました'

export function fileLinking(ctx: EngineContext) {
  const { deps, companyData, transactions, clock, open, stateOf, summaryOf, changed } = ctx

  /**
   * The one sequence of checks (who → body → rules) and the write. A Drive link stops right before it
   * needs the connector's answer when `drive` is `'ask'`: every record check (records on, the record
   * readable, the body, the version, not linked already) has passed, so the route asks Google only then.
   */
  function run(member: Member, actor: ActorInput, recordId: string, op: 'link' | 'unlink', body: unknown, drive: VerifiedDriveFile | 'ask' | undefined, put = false): Outcome<FileLinkAnswer | 'ask-drive'> {
    const opened = open(member)
    if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
    const { records, reader } = opened
    const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
    if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
    if (serviceStateOnly(row.type)) return refuse('forbidden', STATE_CHANGED_BY_SERVICE.error, { code: STATE_CHANGED_BY_SERVICE.code })
    const off = featureOffRefusal(ctx.deps.featureOff, member.companyId, row.type)
    if (off) return off
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
    let path: string
    if (b.target !== undefined) {
      // A Drive file or a file of the member's PC: only where there is no shared folder, only a person.
      if (!fileLinksUnavailable(deps.hasCompanyFolder, member.companyId)) return conflict(FILE_LINK_KIND_NOT_HERE.error, FILE_LINK_KIND_NOT_HERE.code)
      // The one exception: the file the member's own put just made (`put`, built by the server from the receipt).
      if (actor.kind !== 'human' && !put) return refuse('forbidden', TYPED_LINK_PERSON_ONLY.error, { code: TYPED_LINK_PERSON_ONLY.code })
      const t = b.target as Record<string, unknown> | null
      const typed = t?.kind === 'local' ? localLinkTarget(member.userId, t.path) : t?.kind === 'drive' ? driveLinkTarget(t.fileId) : null
      if (!typed) return bad('target: { kind: local, path } (inside your working folder) or { kind: drive, fileId }', 'BAD_TARGET')
      path = typed
    } else {
      // Linking needs the shared folder; removing a link never does.
      if (op === 'link') {
        const noFolder = fileLinksUnavailable(deps.hasCompanyFolder, member.companyId)
        if (noFolder) return noFolder
      }
      const companyPath = typeof b.path === 'string' ? fileLinkPath(b.path) : null
      if (!companyPath) return bad('path: a path inside the company folder', 'BAD_PATH')
      // The member must read the file, and the record may hold a link to it at all: one answer, no place named.
      const priv = findPrivateScope(companyData.forCompany(member.companyId).scopes.listWithRules(), companyPath)
      if (!reader.file(companyPath) || !linkAllowed(row, { scopeId: priv?.id ?? null })) {
        return bad(FILE_NOT_LINKABLE.error, FILE_NOT_LINKABLE.code)
      }
      path = companyPath
    }
    if (!put && (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0)) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
    const note = b.note === undefined ? '' : b.note
    if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)

    const current = stateOf(records, row, def)
    // A put's link is made by the server right after the put, at the version it reads now.
    const expected = put ? current.version : b.expectedVersion as number
    if (expected !== current.version) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: current.version })
    const allLinks = records.linksFrom([row.id])
    const mine = allLinks.filter(l => l.name === name)
    // A `.personal/` link someone else made is not there for this member (records.md "Links into .personal/").
    const shown = mine.filter(l => fileLinkShown(member.userId, row, l))
    let nextLinks: RecordLinkRow[]
    let followed = false
    if (op === 'link') {
      const already = shown.find(l => l.targetPath === path)
      // A put that gave a new revision to a Drive file this member linked (google-drive.md "Overwriting"): the link
      // follows the latest revision — its kept facts change, nothing else. Anything else already linked: no change.
      const follows = already !== undefined && put && drive !== undefined && drive !== 'ask' && driveLinkTarget(drive.fileId) === path
        && already.createdBy === member.userId && (already.drive?.revisionId !== drive.revisionId || already.drive?.sha256 !== drive.sha256)
      if (already && !follows) return ok({ record: summaryOf(records, row.id), entry: null, changed: false })
      followed = follows
      const added: RecordLinkRow = { sourceId: row.id, name, position: 0, targetId: null, targetPath: path, createdBy: member.userId }
      const kept = def.links[name].cardinality === 'one' ? allLinks.filter(l => l.name !== name) : allLinks
      if (!followed && kept.filter(l => l.name === name).length + 1 > MAX_LINK_TARGETS) return bad(`At most ${MAX_LINK_TARGETS} files per link`, 'TOO_MANY_LINKS')
      // A Drive file: only now, every record check passed, is the connector's answer needed.
      if (fileLinkKind(path) === 'drive') {
        if (drive === 'ask') return ok('ask-drive')
        if (!drive || driveLinkTarget(drive.fileId) !== path) return refuse('forbidden', DRIVE_NOT_CHECKED.error, { code: DRIVE_NOT_CHECKED.code })
        added.drive = { revisionId: drive.revisionId, name: drive.name, sha256: drive.sha256, mimeType: drive.mimeType, linkedAt: clock.now() }
      }
      // Following a new revision keeps the link where it is (same row, its kept facts replaced).
      nextLinks = followed && already ? allLinks.map(l => (l === already ? { ...l, drive: added.drive } : l)) : [...kept, added]
    } else {
      const gone = shown.find(l => l.targetPath === path)
      if (!gone) return refuse('not-found', 'このファイルはこの記録につながっていません', { code: 'LINK_NOT_FOUND' })
      nextLinks = allLinks.filter(l => l !== gone)
    }
    nextLinks = nextLinks.map((l, i) => ({ ...l, position: i }))
    const at = clock.now()
    const entry: LedgerEntry = {
      recordId: row.id, version: current.version + 1, action: op === 'link' ? 'link_file' : 'unlink_file', fromState: current.state, toState: current.state,
      actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note: followed && note === '' ? FOLLOWED_NOTE : note,
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
    changed(member.companyId, row.id)
    // The answer's entry as this member may see it: others' own-only targets left out of before / after.
    const seen = personalPathsSeen(member.userId, row, [entry], [...allLinks, ...nextLinks])
    return ok({ record: summaryOf(records, row.id), entry: scrubLedger([entry], seen)[0] ?? null, changed: true })
}

  return {
    /**
     * Link a file to a record after it was made, or remove that link
     * (records.md "Linking files later"). Any type with a `file` link; the
     * caller must read the record and the file, and the link must be one the
     * record may have at all (`linkAllowed`: never into a private folder from
     * outside it). The member's AI only on types that let the AI act at all
     * (an action whose `who` lists `ai`). A ledger entry `link_file` /
     * `unlink_file` with `links.<name>` before / after, so it can be undone.
     *
     * A company without the shared folder links `target` instead of `path` (records.md "File links
     * without the shared folder"): `{ kind: 'local', path }` — a file of the member's own working
     * folder, shown to them alone — or `{ kind: 'drive', fileId }` — a Drive file the connector
     * checked as the member's own pick (`drive`, from the route). People only; a company with the
     * shared folder refuses both.
     */
    fileLink(member: Member, actor: ActorInput, recordId: string, op: 'link' | 'unlink', body: unknown, drive?: VerifiedDriveFile): Outcome<FileLinkAnswer> {
      const r = run(member, actor, recordId, op, body, drive)
      if (!r.ok) return r
      return r.value === 'ask-drive' ? refuse('forbidden', DRIVE_NOT_CHECKED.error, { code: DRIVE_NOT_CHECKED.code }) : ok(r.value)
    },

    /**
     * Before the route asks Google about a Drive file to link: every record check of `fileLink`, nothing
     * written. `ask-drive` = all passed, ask the connector now; an answer (`changed: false`, already
     * linked) or a refusal = answer it as it is, Google never asked.
     */
    fileLinkBeforeDrive(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<FileLinkAnswer | 'ask-drive'> {
      return run(member, actor, recordId, 'link', body, 'ask')
    },

    /**
     * The file the member's own Drive put just made, linked to the record the consultation is about
     * (google-drive.md "Linked to a record"; records.md "File links without the shared folder"). Only
     * the Google connector's put route calls it, with `file` built from the put's receipt (never a
     * body). Every record check of `fileLink` applies — records on, the record readable, a type the AI
     * may act on, a company without the shared folder, not linked already — except that the member's AI
     * may make this one Drive link, at the version current now (tried twice if someone wrote between).
     */
    linkDrivePut(member: Member, actor: ActorInput, recordId: string, file: VerifiedDriveFile): Outcome<FileLinkAnswer> {
      const body = { target: { kind: 'drive', fileId: file.fileId } }
      let r = run(member, actor, recordId, 'link', body, file, true)
      if (!r.ok && r.body.code === 'VERSION_CONFLICT') r = run(member, actor, recordId, 'link', body, file, true)
      if (!r.ok) return r
      return r.value === 'ask-drive' ? refuse('forbidden', DRIVE_NOT_CHECKED.error, { code: DRIVE_NOT_CHECKED.code }) : ok(r.value)
    },
  }
}
