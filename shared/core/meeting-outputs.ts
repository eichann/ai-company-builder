/**
 * What a meeting's reading makes (tasks, decisions, mail drafts) is made **once** per meeting
 * and item (owner FB 29, `.claude/rules/minutes.md` "Outputs made once"): reading the minutes
 * again (「もう一度読む」, a retry, a rerun) finds what the first reading made instead of making
 * it again. An output is the same item as an earlier one of the same meeting when it carries the
 * same item key, or when its title is the same after `outputTitleKey`.
 */

/** Longest item key (the AI's own item number or name, e.g. `task:3`). */
export const MEETING_OUTPUT_KEY_MAX = 200

/**
 * A title compared for 「the same item」: NFKC (full-width digits and letters, 「１５０万円」 =
 * 「150万円」), A–Z folded, without spaces, brackets and punctuation. 「修正見積（150万円）を鈴木様へ送付」
 * and 「修正見積 (150万円) を 鈴木様へ送付。」 are one item.
 */
export function outputTitleKey(title: string): string {
  return title.normalize('NFKC').replace(/[A-Z]/g, c => c.toLowerCase())
    .replace(/[\s()（）「」『』【】[\]{}<>〈〉《》・、。,.:;：；!?！？'"“”‘’`~〜\-—_/|＿]+/g, '')
}

/** What the AI and the person are told when a create found the item already made. */
export const MEETING_OUTPUT_REUSED_NOTE =
  '同じ会議からすでに作られていたので、新しくは作らず、それを返しました。もう一度作らないでください。 / Already created from this meeting: the existing record was reused, nothing new was made. Do not create it again.'
