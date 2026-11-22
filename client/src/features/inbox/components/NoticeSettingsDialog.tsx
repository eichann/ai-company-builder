import { useId } from 'react'
import { NOTIFICATION_KIND_LABELS, NOTIFICATION_KINDS } from '../../../../../shared/types/notifications'
import { noticeKindsShown, type CompanyFeatures } from '../../../../../shared/core/features'
import { Dialog, DialogCloseButton, DialogTitle } from '../../../shared/ui/Dialog'
import { noticeKindsForRole } from '../model'

interface Props {
  /** The member's switches as the server keeps them (shared by their PCs); null while they are read. */
  kinds: Record<string, boolean> | null
  error: string | null
  /** The company's 「使う機能」: no switch for a kind of a feature that is off. */
  features: CompanyFeatures
  /** The member is an owner / admin (null: not known): only then are the owner / admin-only kinds offered. */
  fullAccess?: boolean | null
  onSwitch: (kind: string, on: boolean) => void
  onClose: () => void
}

/** 「知らせの設定」 (one switch per kind, as the bell had it), opened from the inbox's heading since I2. */
export function NoticeSettingsDialog({ kinds, error, features, fullAccess = null, onSwitch, onClose }: Props) {
  const titleId = useId()
  const noteId = useId()
  return (
    <Dialog onClose={onClose} labelledBy={titleId} describedBy={noteId} size="md" padded={false} className="flex max-h-full flex-col">
      <div className="flex flex-shrink-0 items-start gap-2 border-b border-[color:var(--color-border)] p-dialog pb-3">
        <div className="min-w-0 flex-1">
          <DialogTitle id={titleId}>知らせの設定</DialogTitle>
          <p id={noteId} className="mt-1 text-small text-text-muted">どの知らせを受け箱に出すかを選べます。ほかのパソコンでも同じ設定になります。</p>
        </div>
        <DialogCloseButton onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-2">
        {error && <p role="alert" className="px-dialog py-2 text-small text-danger-text">{error}</p>}
        {kinds === null && !error && <p className="px-dialog py-2 text-small text-text-muted">読み込んでいます…</p>}
        {kinds && noticeKindsForRole(noticeKindsShown(NOTIFICATION_KINDS, features), fullAccess).map(kind => (
          <label key={kind} className="flex cursor-pointer items-start gap-2 px-dialog py-1.5 text-body text-text hover:bg-surface-sunken">
            <input type="checkbox" className="mt-0.5" checked={kinds[kind] === true} onChange={e => onSwitch(kind, e.target.checked)} />
            <span>{NOTIFICATION_KIND_LABELS[kind]}</span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}
