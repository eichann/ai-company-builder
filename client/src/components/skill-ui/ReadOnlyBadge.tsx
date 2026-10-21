import { Lock } from '@phosphor-icons/react'

const TITLE = 'このフォルダは閲覧のみです。編集が必要な場合はフォルダの管理者に依頼してください（AIもここは編集しません）。'

/** 閲覧のみ marker for folders / files the member may not write (per-folder write rules). */
export function ReadOnlyBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`flex-shrink-0 inline-flex items-center gap-0.5 rounded bg-gray-500/10 dark:bg-zinc-500/15 text-gray-500 dark:text-zinc-400 ${compact ? 'ml-auto text-[9px] px-1' : 'text-[11px] px-1.5 py-0.5'}`}
      title={TITLE}
    >
      <Lock size={compact ? 9 : 11} weight="bold" />
      閲覧のみ
    </span>
  )
}
