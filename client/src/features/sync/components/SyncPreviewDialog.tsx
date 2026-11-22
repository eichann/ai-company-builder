import { useId, useState } from 'react'
import { CaretDown, CaretRight, Plus, PencilSimple, Minus, SpinnerGap, Sparkle, ArrowCounterClockwise, CloudArrowUp } from '@phosphor-icons/react'
import { DiffModal } from '../../../shared/ui/DiffViewer'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { Dialog, DialogCloseButton, DialogTitle } from '../../../shared/ui/Dialog'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

interface SyncPreviewDialogProps {
  isOpen: boolean
  onClose: () => void
  changes: { added: string[]; modified: string[]; deleted: string[] }
  totalCount: number
  summary?: string | null
  isLoadingSummary?: boolean
  onRequestSummary?: () => void
  rootPath: string
  /** Undo one change; answers why it was not undone (shown in the dialog), or null. */
  onRevertFile?: (filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => Promise<string | null>
  onSync?: (commitMessage?: string) => void
  isSyncing?: boolean
  /** The 作業メモ: kept by the caller until a sync succeeds, so a failed sync does not lose it. */
  commitMessage: string
  onCommitMessageChange: (message: string) => void
}

type FileStatus = 'added' | 'modified' | 'deleted'

/** What 「元に戻す」 will do to this file, in the member's words. */
function revertConfirmMessage(displayName: string, status: FileStatus): string {
  if (status === 'added') return `「${displayName}」は追加したファイルです。元に戻すと、このファイルは削除されます。\n今の内容は .backups に保存します。`
  if (status === 'modified') return `「${displayName}」を最後に同期したときの内容に戻します。\n今の内容は .backups に保存します。`
  return `削除した「${displayName}」を、最後に同期したときの内容で戻します。`
}

const COLLAPSE_THRESHOLD = 20

// A change's mark by what it does to the file (design-system.md, P2d): added the success set,
// deleted the danger set, changed the neutral info set (amber is for warnings only). The same
// colours as the before / after of the diff (DiffViewer).
const CHANGE_MARK: Record<FileStatus, string> = {
  added: 'text-success-text',
  modified: 'text-info-text',
  deleted: 'text-danger-text',
}

function FileSection({
  label,
  files,
  icon: Icon,
  rootPath,
  fileStatus,
  onRevert,
  revertingFiles,
}: {
  label: string
  files: string[]
  icon: typeof Plus
  rootPath: string
  fileStatus: 'added' | 'modified' | 'deleted'
  onRevert?: (filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => void
  revertingFiles: Set<string>
}) {
  const [expanded, setExpanded] = useState(files.length <= COLLAPSE_THRESHOLD)
  const [diffFile, setDiffFile] = useState<string | null>(null)

  if (files.length === 0) return null

  const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/'
  const colorClass = CHANGE_MARK[fileStatus]

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 py-1.5 px-2 text-xs font-medium text-text-muted hover:bg-surface-sunken rounded-small transition-colors"
      >
        {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span className={colorClass}>{label}</span>
        <span className="text-text-muted">({files.length}件)</span>
      </button>
      {expanded && (
        <div className="ml-2 pl-2 border-l border-[color:var(--color-border)]">
          {files.map((file) => {
            const displayPath = file.startsWith(prefix) ? file.slice(prefix.length) : file
            const isReverting = revertingFiles.has(file)
            return (
              <div key={file}>
                <div
                  className="flex items-center gap-1.5 py-0.5 px-2 text-xs text-text-muted hover:bg-surface-sunken rounded-small cursor-pointer"
                  onClick={() => setDiffFile(file)}
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
                      className="p-0.5 rounded-small hover:bg-danger-bg text-text-subtle hover:text-danger-text transition-colors flex-shrink-0"
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
              </div>
            )
          })}
        </div>
      )}

      {diffFile && (
        <DiffModal
          isOpen={true}
          onClose={() => setDiffFile(null)}
          title={diffFile.startsWith(prefix) ? diffFile.slice(prefix.length) : diffFile}
          diffProps={{ mode: 'staged', rootPath, filePath: diffFile, fileStatus }}
        />
      )}
    </div>
  )
}

export function SyncPreviewDialog({
  isOpen,
  onClose,
  changes,
  summary,
  isLoadingSummary,
  onRequestSummary,
  rootPath,
  onRevertFile,
  onSync,
  isSyncing,
  commitMessage,
  onCommitMessageChange: setCommitMessage,
}: SyncPreviewDialogProps) {
  const [revertingFiles, setRevertingFiles] = useState<Set<string>>(new Set())
  const [revertAsk, setRevertAsk] = useState<{ filePath: string; fileStatus: FileStatus } | null>(null)
  const [revertError, setRevertError] = useState<string | null>(null)
  const [commitBoxExpanded, setCommitBoxExpanded] = useState(!!commitMessage.trim())
  const titleId = useId()

  // The commit message is kept by the caller across open/close and a failed sync.

  if (!isOpen) return null

  // Filter out review sidecar files from the displayed changes
  const isReviewFile = (f: string) => /\.review\.[^/]+\.json$/.test(f) || /\.review-request\.json$/.test(f) || /\.reply\.[^/]+\.json$/.test(f)
  const reviewFileCount =
    changes.added.filter(isReviewFile).length +
    changes.modified.filter(isReviewFile).length +
    changes.deleted.filter(isReviewFile).length
  const filteredChanges = {
    added: changes.added.filter(f => !isReviewFile(f)),
    modified: changes.modified.filter(f => !isReviewFile(f)),
    deleted: changes.deleted.filter(f => !isReviewFile(f)),
  }
  const filteredTotalCount = filteredChanges.added.length + filteredChanges.modified.length + filteredChanges.deleted.length

  const handleRevert = (filePath: string, fileStatus: FileStatus) => {
    if (!onRevertFile) return
    setRevertError(null)
    setRevertAsk({ filePath, fileStatus })
  }

  const runRevert = async () => {
    if (!onRevertFile || !revertAsk) return
    const { filePath, fileStatus } = revertAsk
    setRevertAsk(null)
    setRevertingFiles(prev => new Set(prev).add(filePath))
    try {
      setRevertError(await onRevertFile(filePath, fileStatus))
    } catch {
      setRevertError('元に戻せませんでした。もう一度試してください。')
    } finally {
      setRevertingFiles(prev => {
        const next = new Set(prev)
        next.delete(filePath)
        return next
      })
    }
  }

  return (
    // The shared frame (design-system.md, P2d): scrim, surface, Esc / Tab and focus return. The
    // before / after (DiffModal) and the undo confirm open on top of it and answer keys first.
    <Dialog onClose={onClose} labelledBy={titleId}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <DialogTitle id={titleId}>
            変更されたファイル ({filteredTotalCount}件)
          </DialogTitle>
          <DialogCloseButton onClick={onClose} />
        </div>

        {/* Summary */}
        {summary ? (
          <div className="mb-3 px-3 py-2 rounded-control bg-surface-sunken text-xs text-text-muted whitespace-pre-wrap">
            {summary}
          </div>
        ) : isLoadingSummary ? (
          <div className="mb-3 px-3 py-2 rounded-control bg-surface-sunken flex items-center gap-2 text-xs text-text-muted">
            <SpinnerGap size={12} className="animate-spin" />
            <span>サマリーを生成中...</span>
          </div>
        ) : onRequestSummary ? (
          <button
            onClick={onRequestSummary}
            className="mb-3 px-3 py-2 rounded-control border border-border-control flex items-center justify-center gap-2 text-xs text-text-muted hover:text-text hover:bg-surface-sunken hover:border-border-strong transition-colors w-full cursor-pointer"
          >
            <Sparkle size={12} />
            <span>変更差分のサマリーを作成</span>
          </button>
        ) : null}

        {/* Review file summary */}
        {reviewFileCount > 0 && (
          <div className="mb-2 px-3 py-1.5 rounded-control bg-surface-sunken text-[11px] text-text-muted">
            レビュー関連ファイル: {reviewFileCount}件（自動同期）
          </div>
        )}

        {revertError && (
          <p role="alert" className="mb-2 px-3 py-2 rounded-control bg-danger-bg border border-danger-border text-xs text-danger-text">
            {revertError}
          </p>
        )}

        {/* File list */}
        <div className="max-h-[50vh] overflow-auto space-y-1">
          <FileSection
            label="追加"
            files={filteredChanges.added}
            icon={Plus}
            rootPath={rootPath}
            fileStatus="added"
            onRevert={onRevertFile ? handleRevert : undefined}
            revertingFiles={revertingFiles}
          />
          <FileSection
            label="変更"
            files={filteredChanges.modified}
            icon={PencilSimple}
            rootPath={rootPath}
            fileStatus="modified"
            onRevert={onRevertFile ? handleRevert : undefined}
            revertingFiles={revertingFiles}
          />
          <FileSection
            label="削除"
            files={filteredChanges.deleted}
            icon={Minus}
            rootPath={rootPath}
            fileStatus="deleted"
            onRevert={onRevertFile ? handleRevert : undefined}
            revertingFiles={revertingFiles}
          />
        </div>

        {/* Commit message & Sync */}
        {onSync && (filteredTotalCount > 0 || reviewFileCount > 0) && (
          <div className="mt-3 space-y-2">
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isSyncing) {
                  e.preventDefault()
                  onSync(commitMessage.trim() || undefined)
                  setCommitBoxExpanded(false)
                }
              }}
              placeholder="作業メモを入力（空欄ならAIが自動生成）"
              rows={1}
              onFocus={() => setCommitBoxExpanded(true)}
              onBlur={() => { if (!commitMessage.trim()) setCommitBoxExpanded(false) }}
              className={`w-full px-3 py-2 text-xs rounded-control border border-border-control bg-bg text-text placeholder:text-text-subtle focus:outline-none focus:border-focus-border resize-none transition-[height] duration-200 ${commitBoxExpanded ? 'h-20 overflow-auto' : 'h-8 overflow-hidden'}`}
              disabled={isSyncing}
            />
            <p className="text-[10px] text-text-subtle text-left">Enter で改行・⌘+Enterで同期</p>
            <button
              onClick={() => { onSync(commitMessage.trim() || undefined); setCommitBoxExpanded(false) }}
              disabled={isSyncing}
              className={`w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-control transition-colors ${PRIMARY_ACTION}`}
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
            className="px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-surface-sunken rounded-control transition-colors"
          >
            閉じる
          </button>
        </div>

        <ConfirmDialog
          isOpen={revertAsk !== null}
          title="変更を元に戻しますか？"
          message={revertAsk ? revertConfirmMessage(revertAsk.filePath.split('/').pop() || revertAsk.filePath, revertAsk.fileStatus) : ''}
          confirmText="元に戻す"
          danger={revertAsk?.fileStatus === 'added'}
          confirmOnEnter={false}
          onConfirm={() => { void runRevert() }}
          onCancel={() => setRevertAsk(null)}
        />
    </Dialog>
  )
}
