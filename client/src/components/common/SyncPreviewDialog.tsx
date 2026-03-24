import { useEffect, useState } from 'react'
import { CaretDown, CaretRight, Plus, PencilSimple, Minus, X, SpinnerGap, Sparkle, ArrowCounterClockwise, CloudArrowUp } from '@phosphor-icons/react'

interface SyncPreviewDialogProps {
  isOpen: boolean
  onClose: () => void
  changes: { added: string[]; modified: string[]; deleted: string[] }
  totalCount: number
  summary?: string | null
  isLoadingSummary?: boolean
  onRequestSummary?: () => void
  rootPath: string
  onRevertFile?: (filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => Promise<void>
  onSync?: (commitMessage?: string) => void
  isSyncing?: boolean
}

const COLLAPSE_THRESHOLD = 20

function FileSection({
  label,
  files,
  icon: Icon,
  colorClass,
  rootPath,
  fileStatus,
  onRevert,
  revertingFiles,
}: {
  label: string
  files: string[]
  icon: typeof Plus
  colorClass: string
  rootPath: string
  fileStatus: 'added' | 'modified' | 'deleted'
  onRevert?: (filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => void
  revertingFiles: Set<string>
}) {
  const [expanded, setExpanded] = useState(files.length <= COLLAPSE_THRESHOLD)

  if (files.length === 0) return null

  const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/'

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 py-1.5 px-2 text-xs font-medium text-text-secondary hover:bg-activitybar-bg rounded transition-colors"
      >
        {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span className={colorClass}>{label}</span>
        <span className="text-text-secondary">({files.length}件)</span>
      </button>
      {expanded && (
        <div className="ml-2 pl-2 border-l border-border">
          {files.map((file) => {
            const displayPath = file.startsWith(prefix) ? file.slice(prefix.length) : file
            const isReverting = revertingFiles.has(file)
            return (
              <div
                key={file}
                className="flex items-center gap-1.5 py-0.5 px-2 text-xs text-text-secondary hover:bg-activitybar-bg/50 rounded"
              >
                <Icon size={10} weight="bold" className={colorClass} />
                <span className="truncate flex-1" title={file}>
                  {displayPath}
                </span>
                {onRevert && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onRevert(file, fileStatus)
                    }}
                    disabled={isReverting}
                    className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-text-secondary/50 hover:text-red-500 transition-colors flex-shrink-0"
                    title="変更を元に戻す"
                  >
                    {isReverting ? (
                      <SpinnerGap size={12} className="animate-spin" />
                    ) : (
                      <ArrowCounterClockwise size={12} />
                    )}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function SyncPreviewDialog({
  isOpen,
  onClose,
  changes,
  totalCount,
  summary,
  isLoadingSummary,
  onRequestSummary,
  rootPath,
  onRevertFile,
  onSync,
  isSyncing,
}: SyncPreviewDialogProps) {
  const [revertingFiles, setRevertingFiles] = useState<Set<string>>(new Set())
  const [commitMessage, setCommitMessage] = useState('')
  const [commitBoxExpanded, setCommitBoxExpanded] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Note: commit message is intentionally preserved across dialog open/close

  if (!isOpen) return null

  const handleRevert = async (filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => {
    if (!onRevertFile) return
    const displayName = filePath.split('/').pop() || filePath
    const confirmed = window.confirm(`「${displayName}」の変更を元に戻しますか？この操作は取り消せません。`)
    if (!confirmed) return

    setRevertingFiles(prev => new Set(prev).add(filePath))
    try {
      await onRevertFile(filePath, fileStatus)
    } finally {
      setRevertingFiles(prev => {
        const next = new Set(prev)
        next.delete(filePath)
        return next
      })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg p-4 bg-sidebar-bg border border-border rounded-lg shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">
            変更されたファイル ({totalCount}件)
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-activitybar-bg text-text-secondary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Summary */}
        {summary ? (
          <div className="mb-3 px-3 py-2 rounded-md bg-activitybar-bg text-xs text-text-secondary whitespace-pre-wrap">
            {summary}
          </div>
        ) : isLoadingSummary ? (
          <div className="mb-3 px-3 py-2 rounded-md bg-activitybar-bg flex items-center gap-2 text-xs text-text-secondary">
            <SpinnerGap size={12} className="animate-spin" />
            <span>サマリーを生成中...</span>
          </div>
        ) : onRequestSummary ? (
          <button
            onClick={onRequestSummary}
            className="mb-3 px-3 py-2 rounded-md border border-border flex items-center justify-center gap-2 text-xs text-text-secondary hover:text-text-primary hover:bg-activitybar-bg hover:border-text-secondary transition-colors w-full cursor-pointer"
          >
            <Sparkle size={12} />
            <span>変更差分のサマリーを作成</span>
          </button>
        ) : null}

        {/* File list */}
        <div className="max-h-[50vh] overflow-auto space-y-1">
          <FileSection
            label="追加"
            files={changes.added}
            icon={Plus}
            colorClass="text-green-500"
            rootPath={rootPath}
            fileStatus="added"
            onRevert={onRevertFile ? handleRevert : undefined}
            revertingFiles={revertingFiles}
          />
          <FileSection
            label="変更"
            files={changes.modified}
            icon={PencilSimple}
            colorClass="text-amber-500"
            rootPath={rootPath}
            fileStatus="modified"
            onRevert={onRevertFile ? handleRevert : undefined}
            revertingFiles={revertingFiles}
          />
          <FileSection
            label="削除"
            files={changes.deleted}
            icon={Minus}
            colorClass="text-red-500"
            rootPath={rootPath}
            fileStatus="deleted"
            onRevert={onRevertFile ? handleRevert : undefined}
            revertingFiles={revertingFiles}
          />
        </div>

        {/* Commit message & Sync */}
        {onSync && totalCount > 0 && (
          <div className="mt-3 space-y-2">
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isSyncing) {
                  e.preventDefault()
                  onSync(commitMessage.trim() || undefined)
                  setCommitMessage('')
                  setCommitBoxExpanded(false)
                }
              }}
              placeholder="作業メモを入力（空欄ならAIが自動生成）"
              rows={1}
              onFocus={() => setCommitBoxExpanded(true)}
              onBlur={() => { if (!commitMessage.trim()) setCommitBoxExpanded(false) }}
              className={`w-full px-3 py-2 text-xs rounded-md border border-border bg-activitybar-bg text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent resize-none transition-[height] duration-200 ${commitBoxExpanded ? 'h-20 overflow-auto' : 'h-8 overflow-hidden'}`}
              disabled={isSyncing}
            />
            <p className="text-[10px] text-text-secondary/50 text-left">Enter で改行・⌘+Enterで同期</p>
            <button
              onClick={() => { onSync(commitMessage.trim() || undefined); setCommitMessage(''); setCommitBoxExpanded(false) }}
              disabled={isSyncing}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {isSyncing ? (
                <>
                  <SpinnerGap size={14} className="animate-spin" />
                  同期中...
                </>
              ) : (
                <>
                  <CloudArrowUp size={14} />
                  この内容で同期
                </>
              )}
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end mt-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-activitybar-bg rounded-md transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
