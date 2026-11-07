/**
 * Checking what a request brings: a field value by its kind, an OK statement,
 * a decision's materials, and the provenance a person's app reports.
 */
import { isDateValue, normalizeTagsValue, type FieldKind } from '../../../shared/core/record-types'
import type { DecisionMaterial, LedgerValue } from '../../../shared/core/record-ledger'
import { driveLinkTarget, fileLinkPath, RECORD_ID_RE } from '../../../shared/core/records'
import type { ActorInput } from './types'

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * A person's self-reported provenance from a request body (`proposedBy:
 * 'ai'` = they confirmed what their AI suggested; `conversationId`).
 * Informational only: the client can report anything, so nothing may
 * depend on it — it is shown in the history and nowhere decides.
 */
export function selfReportedProvenance(body: unknown): Pick<ActorInput, 'conversationId' | 'proposedBy'> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const conversationId = typeof b.conversationId === 'string' && b.conversationId.length > 0 && b.conversationId.length <= 200 && !CONTROL.test(b.conversationId)
    ? b.conversationId : null
  return { proposedBy: b.proposedBy === 'ai' ? 'ai' : null, conversationId }
}

/** The ledger's provenance columns for this actor (AI: never proposed_by — its actor kind already says ai). */
export const provenance = (actor: ActorInput) => ({
  proposedBy: actor.kind === 'human' && actor.proposedBy === 'ai' ? 'ai' as const : null,
  conversationId: actor.conversationId ?? null,
  // Only the AI acts in a run (a person's body never sets it: routes build the actor from the credential).
  runId: actor.kind === 'ai' ? actor.runId ?? null : null,
})

export const NOTE_MAX = 2000
export const TEXT_MAX = 500
export const LONG_TEXT_MAX = 5000

/** A value for a field of `kind`, or an error text. */
export function checkValue(kind: FieldKind, value: unknown, options: string[] | undefined, isMember: (id: string) => boolean): LedgerValue | { error: string } {
  if (value === null) return null
  switch (kind) {
    case 'text':
    case 'long_text': {
      const max = kind === 'text' ? TEXT_MAX : LONG_TEXT_MAX
      return typeof value === 'string' && value.length <= max ? value.normalize('NFC') : { error: `${max} 文字までの文字で入れてください` }
    }
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? value : { error: '数で入れてください' }
    case 'boolean': return typeof value === 'boolean' ? value : { error: 'true か false で入れてください' }
    case 'date': return isDateValue(value) ? value : { error: 'YYYY-MM-DD の日付か、YYYY-MM-DDTHH:MM の日時で入れてください' }
    case 'datetime': return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : { error: '日時で入れてください' }
    case 'choice': return typeof value === 'string' && (options ?? []).includes(value) ? value : { error: `${(options ?? []).join(' / ')} のどれかです` }
    case 'person': return typeof value === 'string' && value.length <= 200 && isMember(value) ? value : { error: 'この会社のメンバーの id で入れてください' }
    case 'record': return typeof value === 'string' && RECORD_ID_RE.test(value) ? value : { error: '記録の id で入れてください' }
    case 'tags': return normalizeTagsValue(value)
  }
}

export function parseMaterials(raw: unknown): DecisionMaterial[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 20) return 'materials: up to 20'
  const out: DecisionMaterial[] = []
  for (const m of raw as Array<Record<string, unknown>>) {
    if (m?.kind === 'file' && typeof m.path === 'string' && typeof m.commit === 'string' && /^[0-9a-f]{40,64}$/.test(m.commit) && fileLinkPath(m.path)) {
      out.push({ kind: 'file', path: fileLinkPath(m.path) as string, commit: m.commit })
    } else if (m?.kind === 'record' && typeof m.id === 'string' && RECORD_ID_RE.test(m.id) && Number.isInteger(m.version) && (m.version as number) >= 1) {
      out.push({ kind: 'record', id: m.id, version: m.version as number })
    } else if (m?.kind === 'drive' && driveLinkTarget(m.fileId) !== null) {
      // The revision and fingerprint come from the record's link (act.ts), never from the body.
      out.push({ kind: 'drive', fileId: m.fileId as string, revisionId: '', sha256: '' })
    } else return 'materials: { kind: file, path, commit }, { kind: record, id, version } or { kind: drive, fileId }'
  }
  return out
}

export const OK_REQUIRED = '誰の OK で完了にするのかが要ります。OK をくれた人を選ぶか、ACB の外でもらった OK ならそのいきさつ（例: 先方からメールで了承）を書いてください'

/**
 * `ok: { by?, note? }` of an action done through `ok_from`: whose OK it was
 * (a member id) and/or how it came (an OK from outside ACB) — at least one.
 */
export function parseOkStatement(raw: unknown): { by: string | null; note: string | null } | string {
  if (raw === undefined || raw === null) return OK_REQUIRED
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'ok: { by?: member id, note?: text }'
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'by' && k !== 'note') return 'ok: { by?: member id, note?: text }'
  if (o.by !== undefined && o.by !== null && (typeof o.by !== 'string' || o.by.length > 200)) return 'ok.by: a member id'
  if (o.note !== undefined && o.note !== null && (typeof o.note !== 'string' || o.note.length > TEXT_MAX || CONTROL.test(o.note))) return `ok.note: up to ${TEXT_MAX} characters`
  const by = typeof o.by === 'string' && o.by !== '' ? o.by : null
  const note = typeof o.note === 'string' && o.note.trim() !== '' ? o.note.trim().normalize('NFC') : null
  if (by === null && note === null) return OK_REQUIRED
  return { by, note }
}

export const REF_RE = /^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}@[1-9]\d{0,9}$/
