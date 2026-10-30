import { ClockCounterClockwise, FolderOpen, X } from '@phosphor-icons/react'
import type { SyncNotice } from '../model'

interface Props {
  notice: SyncNotice
  onDismiss: () => void
  /** 「履歴を見る」: the backup history (the notice closes). */
  onShowBackups: () => void
}

function copyBackupPath(backupPath: string) {
  // Use shell.openPath equivalent - for now just copy path
  navigator.clipboard.writeText(backupPath)
  alert(`バックアップパスをコピーしました:\n${backupPath}`)
}

/** Bottom-right notice after a sync or a preview; points at the backup when sync set something aside. */
export function SyncNotification({ notice, onDismiss, onShowBackups }: Props) {
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-md animate-in slide-in-from-bottom-2">
      <div className={`
        rounded-lg shadow-lg border p-4
        ${notice.type === 'success'
          ? 'bg-green-500/10 border-green-500/30 text-green-400'
          : notice.type === 'warning'
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
          : 'bg-red-500/10 border-red-500/30 text-red-400'
        }
      `}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm font-medium">{notice.message}</p>
            {notice.backupPath && (
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => copyBackupPath(notice.backupPath!)}
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
