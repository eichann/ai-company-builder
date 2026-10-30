import { useState, useEffect, useCallback } from 'react'
import { X, FolderOpen, ArrowCounterClockwise, Clock, File, Warning } from '@phosphor-icons/react'
import { listBackups, openBackupFolder, restoreBackupFile } from '../../features/sync/api'
import type { BackupInfo } from '../../../shared/ipc-contract'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'

interface BackupHistorySlideOverProps {
  isOpen: boolean
  onClose: () => void
  rootPath: string
}

export function BackupHistorySlideOver({ isOpen, onClose, rootPath }: BackupHistorySlideOverProps) {
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedBackup, setExpandedBackup] = useState<string | null>(null)
  const [restoringFile, setRestoringFile] = useState<string | null>(null)
  // Restoring replaces the file in the company folder: asked first (main keeps the current version).
  const [restoreAsk, setRestoreAsk] = useState<{ backupId: string; filePath: string } | null>(null)
  const [restoreNotice, setRestoreNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const loadBackups = useCallback(async () => {
    if (!rootPath) return

    setLoading(true)
    setError(null)

    try {
      const result = await listBackups(rootPath)
      if (result.success) {
        setBackups(result.backups)
      } else {
        setError(result.error || 'Failed to load backups')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backups')
    } finally {
      setLoading(false)
    }
  }, [rootPath])

  useEffect(() => {
    if (isOpen) {
      loadBackups()
    }
  }, [isOpen, loadBackups])

  const handleOpenFolder = async (backupPath: string) => {
    await openBackupFolder(backupPath)
  }

  const handleRestoreFile = async (backupId: string, filePath: string) => {
    setRestoreAsk(null)
    setRestoringFile(`${backupId}:${filePath}`)
    setRestoreNotice(null)
    try {
      const result = await restoreBackupFile(rootPath, backupId, filePath)
      if (result.success) {
        setRestoreNotice({
          ok: true,
          text: result.keptPath
            ? `「${filePath}」を復元しました。それまでの内容は .backups に保存しました。`
            : `「${filePath}」を復元しました。`,
        })
        void loadBackups()
      } else {
        setRestoreNotice({ ok: false, text: restoreFailureText(result.error) })
      }
    } catch {
      setRestoreNotice({ ok: false, text: restoreFailureText() })
    } finally {
      setRestoringFile(null)
    }
  }

  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp)
      return date.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {
      return timestamp
    }
  }

  const getReasonLabel = (reason: string) => {
    switch (reason) {
      case 'conflict':
        return '競合'
      case 'editor_overwrite':
        return '上書き保存の前の内容'
      case 'before_restore':
        return '復元の前の内容'
      case 'before_revert':
        return '「元に戻す」の前の内容'
      default:
        return reason
    }
  }

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Slide Over Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md">
        <div className="h-full flex flex-col bg-white dark:bg-zinc-900 shadow-2xl animate-in slide-in-from-right duration-300">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-zinc-800">
            <div className="flex items-center gap-3">
              <Clock size={24} className="text-amber-500" />
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                バックアップ履歴
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {restoreNotice && (
            <p
              role={restoreNotice.ok ? 'status' : 'alert'}
              className={`mx-6 mt-3 px-3 py-2 rounded-lg text-xs ${restoreNotice.ok
                ? 'bg-green-50 text-green-800 dark:bg-green-500/10 dark:text-green-300'
                : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'}`}
            >
              {restoreNotice.text}
            </p>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-32 text-gray-500 dark:text-zinc-400">
                読み込み中...
              </div>
            ) : error ? (
              <div className="p-6 text-red-500">
                {error}
              </div>
            ) : backups.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-zinc-400">
                <Clock size={48} className="mb-4 opacity-30" />
                <p>バックアップはありません</p>
                <p className="text-sm mt-2 text-gray-400 dark:text-zinc-500">
                  同期時に競合が発生すると、ここに保存されます
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-200 dark:divide-zinc-800">
                {backups.map((backup) => (
                  <div key={backup.id} className="p-4">
                    {/* Backup Header */}
                    <div className="flex items-start justify-between">
                      <div
                        className="flex-1 cursor-pointer"
                        onClick={() => setExpandedBackup(
                          expandedBackup === backup.id ? null : backup.id
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Warning size={16} className="text-amber-500" />
                          <span className="text-sm font-medium text-gray-900 dark:text-white">
                            {getReasonLabel(backup.reason)}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-zinc-400 bg-gray-100 dark:bg-zinc-800 px-2 py-0.5 rounded">
                            {backup.files.length}ファイル
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-zinc-400 mt-1">
                          {formatTimestamp(backup.timestamp)}
                        </p>
                      </div>
                      <button
                        onClick={() => handleOpenFolder(backup.path)}
                        className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 transition-colors"
                        title="フォルダを開く"
                      >
                        <FolderOpen size={18} />
                      </button>
                    </div>

                    {/* Expanded File List */}
                    {expandedBackup === backup.id && (
                      <div className="mt-3 space-y-1 animate-in fade-in duration-200">
                        {backup.files.map((file) => (
                          <div
                            key={file}
                            className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 dark:bg-zinc-800/50"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <File size={14} className="text-gray-400 dark:text-zinc-500 flex-shrink-0" />
                              <span className="text-sm text-gray-700 dark:text-zinc-300 truncate">
                                {file}
                              </span>
                            </div>
                            <button
                              onClick={() => setRestoreAsk({ backupId: backup.id, filePath: file })}
                              disabled={restoringFile === `${backup.id}:${file}`}
                              className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded transition-colors disabled:opacity-50"
                            >
                              <ArrowCounterClockwise size={12} />
                              復元
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900">
            <p className="text-xs text-gray-500 dark:text-zinc-400">
              バックアップは .backups フォルダに保存されています。
              30日経過したバックアップは自動削除されます。
            </p>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={restoreAsk !== null}
        title="バックアップから復元しますか？"
        message={restoreAsk ? `「${restoreAsk.filePath}」を、このバックアップの内容に置き換えます。\n今の内容は .backups に保存してから置き換えます。` : ''}
        confirmText="復元する"
        confirmOnEnter={false}
        onConfirm={() => { if (restoreAsk) void handleRestoreFile(restoreAsk.backupId, restoreAsk.filePath) }}
        onCancel={() => setRestoreAsk(null)}
      />
    </>
  )
}

/** Main's refusals (not downloaded, a reserved name, could not keep the current version) are already sentences. */
function restoreFailureText(error?: string): string {
  if (error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(error)) return error
  return '復元できませんでした。もう一度試してください。'
}
