// Records shown in the app: how lists are grouped (pure).
import { RECORD_KIND_LABELS, RECORD_KIND_ORDER, type RecordKind } from '../../../shared/record-views'

/** Records by kind (案件・やること・決めたこと・やりとり), in that order. */
export function groupByKind<T extends { kind: RecordKind }>(items: T[]): Array<{ kind: RecordKind; items: T[] }> {
  return RECORD_KIND_ORDER.map(kind => ({ kind, items: items.filter(i => i.kind === kind) })).filter(g => g.items.length > 0)
}

export const kindTitle = (kind: RecordKind): string => RECORD_KIND_LABELS[kind]
