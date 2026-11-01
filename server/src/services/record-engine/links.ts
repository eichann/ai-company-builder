/**
 * Links as the engine writes them: which targets an interface link may hold,
 * a link's targets as one ledger value (`links.<name>` before / after) and back,
 * and a record's link rows with one link replaced.
 */
import { INTERFACES, type LinkDef } from '../../../shared/core/record-types'
import type { LedgerValue } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordAccessRow, RecordLinkRow, RecordRepository } from '../../ports/records'
import { currentTypes } from '../record-index'

/**
 * A link whose target is an interface (`interface: bundle`) holds only live
 * records of this company whose type implements it — and, when `readable` is
 * given, that the caller may read. The targets it may not hold (empty for a
 * link to a type or file: those targets are labels, records.md).
 */
export function interfaceLinkMisses(records: RecordRepository, link: LinkDef, targets: string[], readable?: (r: RecordAccessRow) => boolean): string[] {
  if (!link.targetIsInterface || targets.length === 0) return []
  const types = currentTypes(records)
  const fit = new Set(records.byIds(targets)
    .filter(r => types.get(r.type)?.definition.implements.includes(link.target) && (!readable || readable(r)))
    .map(r => r.id))
  return targets.filter(t => !fit.has(t))
}

/** One answer whether the record does not exist, cannot be read or is of another kind (nothing about it leaks). */
export const interfaceLinkRefusal = (name: string, link: LinkDef) => ({
  error: `つながり「${link.label}」には、あなたが見られる「${INTERFACES[link.target]?.label ?? link.target}」の記録だけをつなげます`,
  code: 'BAD_LINK',
  link: name,
})

/** Most targets one link holds (as on create). */
export const MAX_LINK_TARGETS = 50

/**
 * Ledger changes that describe the record's place and links, not a server
 * field: `links.<name>` (restored to the link rows) and `place.<what>` (an
 * owner-only record shared to a folder; never undone). A replay shows them;
 * they never land in the server fields.
 */
export const isPlaceOrLinkChange = (field: string) => field.startsWith('links.') || field.startsWith('place.')

/**
 * A link's targets as one ledger value (`links.<name>` before / after):
 * file links as a JSON array of company paths (a path may hold a comma),
 * record links as ids joined with commas (the service writer's form); null = none.
 */
export function linkLedgerValue(target: string, rows: RecordLinkRow[]): LedgerValue {
  const values = rows.map(r => (target === 'file' ? r.targetPath : r.targetId)).filter((v): v is string => typeof v === 'string')
  if (values.length === 0) return null
  return target === 'file' ? JSON.stringify(values) : values.join(',')
}

export function linkTargetsOf(target: string, value: LedgerValue): string[] | null {
  if (value === null) return []
  if (typeof value !== 'string') return null
  if (target !== 'file') return value.split(',').filter(v => RECORD_ID_RE.test(v))
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(p => typeof p === 'string') ? parsed as string[] : null
  } catch {
    return null
  }
}

/** Every link row of a record with `name` replaced by these targets (positions renumbered). */
export function withLinkTargets(sourceId: string, current: RecordLinkRow[], name: string, target: string, targets: string[]): RecordLinkRow[] {
  const others = current.filter(l => l.name !== name)
  const mine = targets.map(t => ({ sourceId, name, position: 0, targetId: target === 'file' ? null : t, targetPath: target === 'file' ? t : null }))
  return [...others, ...mine].map((l, i) => ({ ...l, position: i }))
}
