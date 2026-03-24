import { useEffect, useState } from 'react'
import { CaretDown, CaretRight, Plus, PencilSimple, Minus, X, SpinnerGap, Sparkle } from '@phosphor-icons/react'

interface SyncPreviewDialogProps {
  isOpen: boolean
  onClose: () => void
  changes: { added: string[]; modified: string[]; deleted: string[] }
  totalCount: number
  summary?: string | null
  isLoadingSummary?: boolean
  onRequestSummary?: () => void
  rootPath: string
}

const COLLAPSE_THRESHOLD = 20

function FileSection({
  label,
  files,
  icon: Icon,
  colorClass,
  rootPath,
}: {
  label: string
  files: string[]
  icon: typeof Plus
  colorClass: string
  rootPath: string
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
          {files.map((file) => (
            <div
              key={file}
              className="flex items-center gap-1.5 py-0.5 px-2 text-xs text-text-secondary"
            >
              <Icon size={10} weight="bold" className={colorClass} />
              <span className="truncate" title={file}>
                {file.startsWith(prefix) ? file.slice(prefix.length) : file}
              </span>
            </div>
          ))}
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
}: SyncPreviewDialogProps) {
  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg p-4 bg-sidebar-bg border border-border rounded-lg shadow-xl">
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
          />
          <FileSection
            label="変更"
            files={changes.modified}
            icon={PencilSimple}
            colorClass="text-amber-500"
            rootPath={rootPath}
          />
          <FileSection
            label="削除"
            files={changes.deleted}
            icon={Minus}
            colorClass="text-red-500"
            rootPath={rootPath}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end mt-4">
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
