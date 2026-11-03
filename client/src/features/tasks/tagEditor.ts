// The card's tag editor (tasks-ui.md "Tags on the card"): which tags in use to offer while typing,
// what Enter adds, and when the typed word is a bundle's name. Pure; the server still decides.
import { normalizeTag, TAG_MAX_LENGTH, TAGS_MAX_COUNT } from '../../../../shared/core/record-types'
import type { BundleChoice } from '../../../shared/tasks'
import { tagKey } from '../../../shared/tag-suggest'

/**
 * Tags in use (most used first) the member may mean: those containing what is typed, spelled
 * loosely (width, case, katakana / hiragana); nothing typed → the most used. The task's own
 * tags are left out.
 */
export function tagCandidates(typed: string, current: readonly string[], inUse: readonly string[], limit = 8): string[] {
  const key = tagKey(typed.trim())
  const own = new Set(current.map(tagKey))
  return inUse.filter(t => !own.has(tagKey(t)) && (!key || tagKey(t).includes(key))).slice(0, limit)
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
