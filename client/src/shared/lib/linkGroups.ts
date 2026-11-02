// ACB foundation: 「つながっているもの」's grouping, used by the records and tasks features (every
// record's right column), which may not import each other.
import type { ThingKind } from '../../../shared/thing-words'

/** The order of 「つながっているもの」: what a thing belongs to first, then work, then what was said. */
const LINK_ORDER: ThingKind[] = ['bundle', 'task', 'minutes_check', 'meeting', 'decision', 'approval', 'incoming', 'reply_request', 'outbound', 'sent', 'counterpart', 'other', 'file', 'consultation', 'skill']

export interface LinkGroup<T> {
  /** The kind's name (「会議の記録」「案件」): one group per name, so 案件 and プロジェクト stay apart. */
  title: string
  kind: ThingKind
  items: T[]
}

/**
 * 「つながっているもの」 as a table of contents: one group per kind of thing, in a fixed order;
 * `first` puts one kind at the top (a 案件's own やること). Items keep their order.
 */
export function groupLinks<T extends { name: string; kind: ThingKind }>(items: T[], first?: ThingKind): Array<LinkGroup<T>> {
  const groups = new Map<string, LinkGroup<T>>()
  for (const item of items) {
    const g = groups.get(item.name) ?? { title: item.name, kind: item.kind, items: [] }
    g.items.push(item)
    groups.set(item.name, g)
  }
  const rank = (kind: ThingKind) => (kind === first ? -1 : LINK_ORDER.indexOf(kind))
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind))
}

/** Each kind shows this many; the rest fold into 「ほか n 件」. */
export const LINKS_SHOWN = 3

export function foldLinks<T>(items: T[], open: boolean): { shown: T[]; more: number } {
  if (open || items.length <= LINKS_SHOWN) return { shown: items, more: 0 }
  return { shown: items.slice(0, LINKS_SHOWN), more: items.length - LINKS_SHOWN }
}
