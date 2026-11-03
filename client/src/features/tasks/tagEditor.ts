// The card's tag editor (tasks-ui.md "Tags on the card"): which tags in use to offer while typing,
// what Enter adds, and when the typed word is a bundle's name. Pure; the server still decides.
import { normalizeTag, TAG_MAX_LENGTH, TAGS_MAX_COUNT } from '../../../../shared/core/record-types'
import type { BundleChoice } from '../../../shared/tasks'
import { tagKey } from '../../../shared/tag-suggest'

/** One row of the tag popover: a tag, and whether the task has it (a check mark; picking it takes it off). */
export interface TagOption { tag: string; selected: boolean }

/**
 * The rows of the tag popover (owner 2026-11-03, 使い心地のメモ #6): the task's tags and the tags in
 * use (most used first) that contain what is typed, spelled loosely (width, case, katakana /
 * hiragana), each once. Nothing typed → the task's tags first, then the most used. A tag spelled
 * exactly like the typed word (loosely) comes first, so Enter picks it rather than a near one.
 */
export function tagOptions(typed: string, current: readonly string[], inUse: readonly string[], limit = 12): TagOption[] {
  const key = tagKey(typed.trim())
  const own = new Set(current.map(tagKey))
  const seen = new Set<string>()
  const all: TagOption[] = []
  for (const tag of [...current, ...inUse]) {
    const k = tagKey(tag)
    if (seen.has(k) || (key && !k.includes(key))) continue
    seen.add(k)
    all.push({ tag, selected: own.has(k) })
  }
  const exact = all.filter(o => key && tagKey(o.tag) === key)
  return [...exact, ...all.filter(o => !exact.includes(o))].slice(0, limit)
}

/** 「『〇〇』を作る」: the typed word as a new tag, when no row is that word already (loosely). */
export function newTagOffer(typed: string, options: readonly TagOption[]): string | null {
  const tag = normalizeTag(typed)
  if (tag === null) return null
  return options.some(o => tagKey(o.tag) === tagKey(tag)) ? null : tag
}

export type TagAdd =
  | { kind: 'add'; tags: string[]; tag: string }
  | { kind: 'refused'; reason: string }

/**
 * What adding `typed` does: a tag in use spelled the same way (loosely) is added as that tag, so
 * 「ｴｲｷﾞｮｳ」 never becomes a second 「エイギョウ」; otherwise the new word, normalized like the
 * server (`normalizeTag`). null: nothing to add.
 */
export function tagToAdd(typed: string, current: readonly string[], inUse: readonly string[]): TagAdd | null {
  if (!typed.trim()) return null
  const tag = normalizeTag(typed)
  if (tag === null) return { kind: 'refused', reason: `タグは ${TAG_MAX_LENGTH} 文字までの言葉にしてください` }
  const key = tagKey(tag)
  if (current.some(t => tagKey(t) === key)) return { kind: 'refused', reason: `#${current.find(t => tagKey(t) === key)} はもう付いています` }
  if (current.length >= TAGS_MAX_COUNT) return { kind: 'refused', reason: `タグは ${TAGS_MAX_COUNT} 個までです` }
  const same = inUse.find(t => tagKey(t) === key) ?? tag
  return { kind: 'add', tags: [...current, same], tag: same }
}

/** The bundle (案件・プロジェクト) whose name is exactly the typed word, among those offered. */
export function bundleNamed(typed: string, bundles: readonly BundleChoice[]): BundleChoice | null {
  const t = normalizeTag(typed)
  if (t === null) return null
  return bundles.find(b => b.title.normalize('NFC').replace(/\s+/g, ' ').trim() === t) ?? null
}
