/**
 * 「決めたこと」 (decision records, milestone 4; `.claude/rules/records.md`
 * "Decisions"): the server writes the record file itself — one commit through
 * the push checker, under the company lock (lib/bare-commit.ts
 * commitFileEdit) — so nothing a member has half-written on their computer is
 * swept in, and creates its index row and state (`unconfirmed`) through the
 * service writer.
 *
 * Rules (design §3-3, §9 q7 / q14):
 * - the place is a department folder the member may write, never a private
 *   folder nor inside one, and never wider than a linked record's folder;
 *   every refusal of a place says the same words and never names it;
 * - title and body name people and customers by id only: a member's display
 *   name, or the title of the linked deal / customer, is refused (Git history
 *   keeps what is written; 13.10);
 * - an optional idempotency `key` (`minutes-…:decision:2`) writes the same item
 *   once: the id is derived from it and it is kept in the `source_key` field.
 */
import { foldAsciiCase, isSameOrAncestorPath, nameKey, normalizeRepoPath } from '../../shared/core/paths'
import { findPrivateScope, resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { newRecordId, RECORD_ID_RE } from '../../shared/core/records'
import type { RecordSummary } from '../../shared/types/records'
import type { IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { RecordFileCreator } from '../ports/record-files'
import type { RecordRow } from '../ports/records'
import { logError } from '../lib/error-log'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'
import { ASSIGNEE_CANNOT_READ, type ActorInput, type ServiceRecordWriter } from './record-engine'
import { RECORDS_DISABLED, recordSummaries } from './records'

export interface DecisionServiceDeps {
  companyData: CompanyDataSource
  writer: ServiceRecordWriter
  files: RecordFileCreator
  /** Display names of the company's members (never stored or logged here; only compared). */
  memberNames: (companyId: string) => string[]
  tokenDigest: TokenDigest
  ids: IdGenerator
}

/** The folder of a department's decisions. */
export const DECISIONS_FOLDER = '意思決定'

/** Says nothing about the place (a private folder's name or existence never leaks). */
export const DECISION_PLACE_REFUSED = {
  error: 'この場所には決めたことを残せません。書き込める部署のフォルダを選んでください。',
  code: 'DECISION_PLACE_REFUSED',
}
export const NAME_IN_DECISION = {
  error: '件名や本文に、人や顧客の名前は書けません。名前ではなく、つながり（案件・議事録）で示してください。',
  code: 'NAME_IN_DECISION',
}

const TITLE_MAX = 120
const WHY_MAX = 1000
const SOURCE_MAX = 300
const KEY_MAX = 200
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** Words around a company's name that are not the name. */
const CORPORATE = /株式会社|有限会社|合同会社|合資会社|\(株\)|（株）|㈱|\binc\.?|\bco\.,?\s*ltd\.?|\bltd\.?|\bllc\b|\bcorp\.?/gi

const bad = (error: string, code = 'BAD_REQUEST') => refuse('bad-request', error, { code })

/** One line of text: whitespace runs (newlines too) folded to one space; null when unusable. */
function line(raw: unknown, max: number, required: boolean): string | null | undefined {
  if (raw === undefined || raw === null) return required ? null : undefined
  if (typeof raw !== 'string') return null
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (CONTROL.test(s) || s.length > max || (required && s === '')) return null
  return s === '' ? undefined : s
}

/** Comparison form: NFC, A–Z folded, no whitespace. */
const squash = (s: string) => foldAsciiCase(s.normalize('NFC')).replace(/\s+/g, '')

/** The forms of a person's name a text must not contain: the whole name and each part of 2+ letters. */
function personNeedles(name: string): string[] {
  const parts = name.normalize('NFC').split(/[\s\u3000・]+/).filter(Boolean)
  return [name, ...(parts.length > 1 ? parts : [])].map(squash).filter(n => n.length >= 2)
}

/** A customer's or deal's title, with and without the corporate words around it. */
function titleNeedles(title: string): string[] {
  return [title, title.replace(CORPORATE, '')].map(squash).filter(n => n.length >= 2)
}

/** The text of a decision file: frontmatter id / type / links only (0.3-8), the title, why / source / who recorded it. */
export function decisionFileText(input: {
  id: string; title: string; why: string; source: string; links: Record<string, string>; recordedBy: string
}): string {
  const links = Object.entries(input.links)
  return [
    '---',
    `id: ${input.id}`,
    'type: decision',
    ...(links.length > 0 ? ['links:', ...links.map(([k, v]) => `  ${k}: ${v}`)] : []),
    '---',
    `# ${input.title}`,
    '',
    `- なぜ：${input.why}`,
    `- 元：${input.source}`,
    `- 記録：${input.recordedBy}`,
    '',
  ].join('\n')
}

export function createDecisionService(deps: DecisionServiceDeps) {
  const { companyData, writer } = deps

  return {
    /**
     * Record a decision: `{ folder, title, why, source, links?: { deal?, minutes?, approval? },
     * important?, key? }`. The person's own call (session) or their AI's (record token, `actor.kind: ai`).
     */
    async record(member: Member, actor: ActorInput, body: unknown): Promise<Outcome<{ record: RecordSummary; created: boolean }>> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      const known = ['folder', 'title', 'why', 'source', 'links', 'important', 'key']
      for (const k of Object.keys(b)) if (!known.includes(k)) return bad(`Unknown key: ${k}`)
      const title = line(b.title, TITLE_MAX, true)
      if (!title) return bad(`title: 1–${TITLE_MAX} characters on one line`)
      if (title.startsWith('#')) return bad('title: plain text')
      const why = line(b.why, WHY_MAX, true)
      if (!why) return bad(`why: 1–${WHY_MAX} characters`)
      const source = line(b.source, SOURCE_MAX, true)
      if (!source) return bad(`source: 1–${SOURCE_MAX} characters`)
      if (b.important !== undefined && typeof b.important !== 'boolean') return bad('important: true or false')
      const key = line(b.key, KEY_MAX, false)
      if (key === null) return bad(`key: up to ${KEY_MAX} characters`)
      if (typeof b.folder !== 'string') return bad('folder: a department folder')

      // Links: readable records of the type the link names.
      const reader = recordReader(member, handle.scopes.listWithRules())
      const rawLinks = (b.links ?? {}) as Record<string, unknown>
      if (typeof rawLinks !== 'object' || rawLinks === null || Array.isArray(rawLinks)) return bad('links: { deal?, minutes?, approval? }')
      const links: Record<string, string> = {}
      const linked: RecordRow[] = []
      for (const [name, value] of Object.entries(rawLinks)) {
        if (!['deal', 'minutes', 'approval'].includes(name)) return bad(`links: ${name} is not a link of a decision`)
        if (value === undefined || value === null) continue
        const row = typeof value === 'string' && RECORD_ID_RE.test(value) ? records.byIds([value]).find(r => r.removedAt === null && reader.record(r)) : undefined
        if (!row || row.type !== name) return bad(`links.${name}: a ${name} record you can read`, 'BAD_LINK')
        links[name] = row.id
        linked.push(row)
      }

      // The place: a department folder the member may write, not private, not wider than a linked record.
      const scopes = handle.scopes.listWithRules()
      const wanted = normalizeRepoPath(b.folder)
      const department = wanted ? handle.departments.folders().find(d => nameKey(d.folder) === nameKey(wanted)) : undefined
      const perms: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => scopes }
      // With a key, the id is the key's: two calls at once still make one file and one record.
      const id = key !== undefined
        ? newRecordId('decision', deps.tokenDigest.digest(`decision-key:${key}`).slice(0, 24))
        : newRecordId('decision', deps.ids.newToken().slice(0, 16))
      const path = department ? `${department.folder}/${DECISIONS_FOLDER}/${id}.md` : null
      const placeOk = path !== null
        && !findPrivateScope(scopes, path)
        && resolveAccess(member.companyId, member.userId, path, perms).write
        && linked.every(r => r.folder === null || isSameOrAncestorPath(r.folder, path))
      if (!placeOk) return bad(DECISION_PLACE_REFUSED.error, DECISION_PLACE_REFUSED.code)

      // Names by id only: no member's name, no linked deal's or customer's title.
      const customers = records.byIds([...new Set(records.linksFrom(linked.map(r => r.id)).flatMap(l => (l.targetId ? [l.targetId] : [])))])
        .filter(r => r.type === 'customer')
      const needles = [
        ...deps.memberNames(member.companyId).flatMap(personNeedles),
        ...[...linked.filter(r => r.type === 'deal'), ...customers].flatMap(r => titleNeedles(r.title)),
      ]
      const text = squash(`${title} ${why} ${source}`)
      if (needles.some(n => text.includes(n))) return bad(NAME_IN_DECISION.error, NAME_IN_DECISION.code)

      // The same item once: an earlier decision with this key is the answer.
      if (key !== undefined) {
        const earlier = records.candidates({ types: ['decision'], fields: [{ name: 'source_key', values: [key] }] }, 1)[0]
          ?? (records.find(id) ? { id } : undefined)
        if (earlier) {
          const row = records.byIds([earlier.id]).find(r => reader.record(r))
          if (!row) return refuse('conflict', 'この目印の決めたことは、すでにほかの場所にあります', { code: 'KEY_TAKEN' })
          return ok({ record: recordSummaries(records, [row]).get(row.id) as RecordSummary, created: false })
        }
      }

      const minutes = linked.find(r => r.type === 'minutes')
      let owner: LedgerValue = member.userId
      if (minutes) {
        try { owner = (JSON.parse(records.states([minutes.id])[0]?.fields ?? '{}') as Record<string, LedgerValue>).assignee ?? member.userId } catch { /* the member */ }
      }
      const recordedBy = actor.kind === 'ai' ? 'ai' : 'human'
      const fileText = decisionFileText({
        id, title, why, source, links, recordedBy: actor.kind === 'ai' ? `AI が記録（${member.userId} の相談から）` : `${member.userId} が記録`,
      })
      const input = {
        // The summary is what the index reads from the file: its body has no plain paragraph.
        type: 'decision', id, title, summary: '', path: path as string,
        fields: {
          recorded_by: recordedBy, important: b.important === true, decided_by: actor.kind === 'ai' ? null : member.userId,
          owner, source_key: key ?? null,
        },
        links: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, [v]])),
        actor: { id: member.userId, kind: actor.kind, source: actor.source ?? null, conversationId: actor.conversationId ?? null, proposedBy: actor.proposedBy ?? null },
      }
      // Everything checked before the commit, so a refused record leaves no file behind.
      const problem = writer.check(member.companyId, input)
      if (problem) {
        if (problem.reason === 'assignee-cannot-read') return bad(ASSIGNEE_CANNOT_READ, 'ASSIGNEE_CANNOT_READ')
        if (problem.reason === 'bad-place') return bad(DECISION_PLACE_REFUSED.error, DECISION_PLACE_REFUSED.code)
        if (problem.reason !== 'exists') return bad('決めたことを記録できませんでした', 'DECISION_REFUSED')
      }
      try {
        await deps.files.createFile(member.companyId, path as string, fileText, '決めたことを記録しました')
      } catch (err) {
        logError('records', 'Writing a decision file failed', err, { company: member.companyId })
        return refuse('unavailable', '決めたことのファイルを書けませんでした。少し待ってからもう一度お試しください', { code: 'DECISION_WRITE_FAILED' })
      }
      const made = writer.create(member.companyId, input)
      if (made.ok) return ok({ record: made.record, created: true })
      // The same key at the same moment: the other call made it.
      const row = records.byIds([id]).find(r => reader.record(r))
      if (made.reason === 'exists' && row) return ok({ record: recordSummaries(records, [row]).get(row.id) as RecordSummary, created: false })
      return bad('決めたことを記録できませんでした', 'DECISION_REFUSED')
    },
  }
}

export type DecisionService = ReturnType<typeof createDecisionService>
