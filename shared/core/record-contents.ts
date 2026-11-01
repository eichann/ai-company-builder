/**
 * The content store (中身の箱, owner decision 2026-11-01, `.claude/rules/records.md`
 * "The content store"): text that easily holds personal data — a record's
 * title and summary, `long_text` fields (why, summaries, reasons), a few named
 * text fields, action notes and decision reasons — is kept in its own row
 * (`record_contents`) so an operator can erase it without touching the
 * append-only ledger. The record's current values and every ledger entry hold
 * only a reference: the content's id and the hash of its text.
 *
 * Pure (shared/core): which values are content, the reference's shape, the
 * retention class of a record type, and how an erased piece reads.
 */
import { OK_FIELDS } from './record-types'

/** `acb-content:<32 hex id>:sha256:<64 hex>` — what the ledger and the record's rows hold instead of the text. */
export const CONTENT_REF_PREFIX = 'acb-content:'
export const CONTENT_REF_RE = /^acb-content:([0-9a-f]{32}):(sha256:[0-9a-f]{64})$/

export function contentRef(id: string, hash: string): string {
  return `${CONTENT_REF_PREFIX}${id}:${hash}`
}

export function parseContentRef(value: unknown): { id: string; hash: string } | null {
  if (typeof value !== 'string') return null
  const m = CONTENT_REF_RE.exec(value)
  return m ? { id: m[1], hash: m[2] } : null
}

/**
 * Text fields that are not `long_text` but are free text people write (owner
 * list): the OK statement's note (any type with the OK fields), a decision's
 * source, and a mail's subject (the record's title is the same words).
 */
export const EXTRA_CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  decision: ['source'],
  outbound_message: ['subject'],
}

/** The server fields of a type whose values go to the content store. */
export function contentFieldNames(typeName: string, fields: Record<string, { kind: string }>): Set<string> {
  const out = new Set<string>()
  for (const [name, f] of Object.entries(fields)) if (f.kind === 'long_text') out.add(name)
  if (Object.prototype.hasOwnProperty.call(fields, OK_FIELDS.note)) out.add(OK_FIELDS.note)
  for (const name of EXTRA_CONTENT_FIELDS[typeName] ?? []) if (Object.prototype.hasOwnProperty.call(fields, name)) out.add(name)
  return out
}

/**
 * Retention classes: `standard` is kept until an operator erases it;
 * `incoming_3y` (owner decision G-33: summaries of what came in from outside,
 * やりとり) is erased 3 years after it was stored. A copy of such a text (the
 * same text stored for another record of the company) inherits the original's
 * expiry.
 */
export type RetentionClass = 'standard' | 'incoming_3y'

export const RETENTION_YEARS: Readonly<Record<RetentionClass, number | null>> = { standard: null, incoming_3y: 3 }

const RETENTION_BY_TYPE: Readonly<Record<string, RetentionClass>> = { interaction: 'incoming_3y' }

export function retentionClassOf(recordType: string): RetentionClass {
  return Object.prototype.hasOwnProperty.call(RETENTION_BY_TYPE, recordType) ? RETENTION_BY_TYPE[recordType] : 'standard'
}

/** When content of this class stored at `createdAt` expires (ISO), or null for never. */
export function contentExpiry(cls: RetentionClass, createdAt: string): string | null {
  const years = RETENTION_YEARS[cls]
  if (years === null) return null
  const d = new Date(createdAt)
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.toISOString()
}

/** How an erased piece reads everywhere (screens, AI tools, history, replay): never the text. */
export const ERASED_PREFIX = '消去済み'
export function erasedText(erasedAt: string): string {
  return `${ERASED_PREFIX}（${erasedAt.slice(0, 10)}）`
}
