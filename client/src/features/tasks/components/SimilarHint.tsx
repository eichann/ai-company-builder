// 「似ているやることがあります」 (出どころの枠 §10 step 4, tasks-ui.md "Similar items"): after the member made a
// task from a meeting or showed one of theirs to others, and the server named a live item of the same
// meeting with a close title. One quiet line, never a dialog: ［まとめる］ puts the new one away (the
// screen's press; 取り消す brings it back) and opens the earlier one; ［このまま］ keeps both.
import type { SimilarItem } from '../../../../shared/tasks'

const QUIET = 'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11.5px] text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-100 dark:hover:bg-amber-900/40'

export function SimilarHint({ similar, busy, onMerge, onKeep }: {
  similar: SimilarItem
  busy: boolean
  /** null when the new item cannot be put away (already finished): only ［このまま］. */
  onMerge: (() => void) | null
  onKeep: () => void
}) {
  return (
    <div role="note" aria-label="似ているやること" className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
      <span className="min-w-0 flex-1">似ているやることがあります：「{similar.title}」</span>
      {onMerge && <button type="button" disabled={busy} onClick={onMerge} title={`こちらはしまって、「${similar.title}」を開きます`} className={QUIET}>まとめる</button>}
      <button type="button" disabled={busy} onClick={onKeep} className={QUIET}>このまま</button>
    </div>
  )
}
