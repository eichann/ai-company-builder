import { StatusBadge } from './primitives'

const TITLE = 'このフォルダは閲覧のみです。編集が必要な場合はフォルダの管理者に依頼してください（AIもここは編集しません）。'

/** 閲覧のみ marker for folders / files the member may not write (per-folder write rules). */
export function ReadOnlyBadge({ compact = false }: { compact?: boolean }) {
  return (
    <StatusBadge variant="readonly" compact={compact} title={TITLE} className={compact ? 'ml-auto' : ''}>
      閲覧のみ
    </StatusBadge>
  )
}
