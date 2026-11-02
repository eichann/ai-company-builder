// 探す's kind chips (言葉の決まり 5.: 「探す」の種類の札): one chip per kind that has something in the
// results — never an empty one — named and drawn like everywhere else. Pure.
import type { RecordViewSummary } from '../../../shared/record-views'
import { bundleWords, THING_NAMES, type ThingKind } from '../../../shared/thing-words'

export interface FindChip {
  id: string
  label: string
  /** The icon it shows (`ThingIcon`). */
  kind: ThingKind
  /** A bundle chip's picture follows its kinds' label. */
  typeLabel?: string
  count: number
}

// Kinds that read as one in the chips: everything the member does is やること; drafts with what was sent.
const CHIP_OF: Partial<Record<ThingKind, string>> = { minutes_check: 'task', reply_request: 'task', outbound: 'sent' }
const ORDER = ['task', 'meeting', 'decision', 'bundle', 'counterpart', 'incoming', 'sent', 'approval', 'other', 'file']

export const chipOf = (r: Pick<RecordViewSummary, 'thing'>): string => CHIP_OF[r.thing] ?? r.thing

/** The chips for these results: only kinds with something in them, in a fixed order, with counts. */
export function findChips(records: readonly RecordViewSummary[], fileCount: number): FindChip[] {
  const groups = new Map<string, RecordViewSummary[]>()
  for (const r of records) groups.set(chipOf(r), [...(groups.get(chipOf(r)) ?? []), r])
  const chips: FindChip[] = []
  for (const id of ORDER) {
    if (id === 'file') {
      if (fileCount > 0) chips.push({ id, label: THING_NAMES.file, kind: 'file', count: fileCount })
      continue
    }
    const list = groups.get(id)
    if (!list) continue
    if (id === 'bundle') {
      // Kinds mix across departments here: 「案件・プロジェクト」, the kinds actually found.
      const label = bundleWords(list.map(r => r.typeLabel))
      chips.push({ id, label, kind: 'bundle', typeLabel: list[0].typeLabel, count: list.length })
    } else if (id === 'other') {
      chips.push({ id, label: bundleWords(list.map(r => r.typeLabel), '記録'), kind: 'other', count: list.length })
    } else {
      chips.push({ id, label: id === 'sent' && list.every(r => r.thing === 'outbound') ? THING_NAMES.outbound : THING_NAMES[id as keyof typeof THING_NAMES], kind: id as ThingKind, count: list.length })
    }
  }
  return chips
}
