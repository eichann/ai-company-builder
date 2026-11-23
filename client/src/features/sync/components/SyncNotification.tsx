import { ClockCounterClockwise, FolderOpen, X } from '@phosphor-icons/react'
import type { SyncNotice } from '../model'
import { openBackupFolder, type BackupOutbound } from '../api'

interface Props {
  notice: SyncNotice
  onDismiss: () => void
  /** 「履歴を見る」: the backup history (the notice closes). */
  onShowBackups: () => void
  /** Shows the backup folder in Finder / Explorer: the backup history's port (main opens only a backup folder). */
  outbound?: BackupOutbound
}

/** Bottom-right notice after a sync or a preview; points at the backup when sync set something aside. */
export function SyncNotification({ notice, onDismiss, onShowBackups, outbound }: Props) {
  // A folder main will not open (gone, or not a backup folder) is still reachable in the backup history.
  const openFolder = async (backupPath: string) => {
    const opened = await openBackupFolder(backupPath, outbound).catch(() => null)
    if (!opened?.success) onShowBackups()
  }
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-md animate-in slide-in-from-bottom-2">
      <div className={`
        rounded-control shadow-lg border p-4
        ${notice.type === 'success'
          ? 'bg-success-bg border-success-border text-success-text'
          : notice.type === 'warning'
          ? 'bg-warning-bg border-warning-border text-warning-text'
          : 'bg-danger-bg border-danger-border text-danger-text'
        }
      `}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm font-medium whitespace-pre-line">{notice.message}</p>
            {notice.backupPath && (
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => { void openFolder(notice.backupPath!) }}
                  className="flex items-center gap-1 text-xs hover:underline"
                >
                  <FolderOpen size={14} />
                  フォルダを開く
                </button>
                <button
                  onClick={onShowBackups}
                  className="flex items-center gap-1 text-xs hover:underline"
                >
                  <ClockCounterClockwise size={14} />
                  履歴を見る
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onDismiss}
            className="text-current opacity-70 hover:opacity-100"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
