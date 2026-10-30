import { useState, useCallback, useRef } from 'react'
import { FileText, Code, Eye } from '@phosphor-icons/react'
import { CodeEditor } from '../../../shared/ui/CodeEditor'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { MarkdownDiffView } from '../../doc-review/components/MarkdownDiffView'
import { useWriteAccess } from '../../../hooks/useWriteAccess'
import { useAppStore } from '../../../stores/appStore'
import { fileNameOf, isImageFile, isMarkdownFile, isPdfFile } from '../fileKinds'
import { useOpenFiles } from '../hooks/useOpenFiles'
import { useFileSaving } from '../hooks/useFileSaving'
import { useEditorReview } from '../hooks/useEditorReview'
import { useMarkdownViewMode, useScrollMemory, type MdViewMode } from '../hooks/useMarkdownView'
import { commandArea, useCommandHandler } from '../../../shared/commands/commands'
import { EditorTabBar } from './EditorTabBar'
import { EditorError, EditorNotice, ExternalChangeBanner, MissingFileNotice, ReadOnlyNotice } from './EditorNotices'
import { LocalImage, PdfPreview } from './BinaryPreviews'
import { MarkdownPreviewPane } from './MarkdownPreviewPane'

interface TabbedEditorPanelProps {
  openFiles: string[]
  activeFilePath: string | null
  previewFilePath?: string | null
  /** Department label for tabs whose file is outside the selected department. */
  tabLabels?: Record<string, string>
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
  onPinFile?: (path: string) => void
  gotoLine?: number | null
  /** This editor's pane: its shortcuts (⌘S, ⌘⇧M, ⌘F) work only while the focus is inside it. */
  paneId?: string
}

export function TabbedEditorPanel({
  openFiles,
  activeFilePath,
  previewFilePath,
  tabLabels,
  onSelectFile,
  onCloseFile,
  onPinFile,
  gotoLine,
  paneId = 'editor',
}: TabbedEditorPanelProps) {
  const { isReadOnly } = useWriteAccess()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The tab whose 「差分を見る」 view (disk version vs. the tab's edits) is open.
  const [externalDiffPath, setExternalDiffPath] = useState<string | null>(null)
  const rootPath = useAppStore(s => s.currentCompany?.rootPath ?? null)
  const { mdViewMode, setMdViewModePersisted } = useMarkdownViewMode()
  const scroll = useScrollMemory(openFiles, activeFilePath, mdViewMode)
  const { saveCurrentScrollPosition } = scroll
  const isActivePreviewTab = activeFilePath === previewFilePath
  const rootRef = useRef<HTMLDivElement>(null)
  // The button just pressed may be gone after the switch: keep the focus (and so ⌘S, ⌘F) in this editor.
  const keepFocusInEditor = () => requestAnimationFrame(() => {
    if (!document.activeElement || document.activeElement === document.body) rootRef.current?.focus({ preventScroll: true })
  })
  const [showDiff, setShowDiff] = useState(false)

  // The review reloads when a sidecar of the active file changes (the watcher in useOpenFiles).
  const reviewReloadRef = useRef<() => void>(() => {})
  const files = useOpenFiles(openFiles, activeFilePath, reviewReloadRef, setError)
  const { fileContents, setContent } = files
  const activeFile = activeFilePath ? fileContents.get(activeFilePath) : null
  const { review, textSelection } = useEditorReview(activeFilePath, activeFile?.content || '')
  reviewReloadRef.current = review.reload

  const saving = useFileSaving({
    activeFilePath,
    fileContents,
    fileContentsRef: files.fileContentsRef,
    updateFile: files.updateFile,
    rootPath,
    setError,
    setNotice,
  })

  // Wrap onSelectFile to save scroll before switching
  const handleSelectFile = useCallback((path: string) => {
    saveCurrentScrollPosition()
    onSelectFile(path)
  }, [saveCurrentScrollPosition, onSelectFile])

  // Wrap mdViewMode toggle to save scroll before switching
  const handleSetMdViewMode = useCallback((mode: MdViewMode) => {
    // Warn when switching to editor while other users have in-progress reviews
    if (mode === 'editor' && review.otherInProgressReviews.length > 0) {
      const names = review.otherInProgressReviews.map(r => r.reviewerName).join('、')
      const ok = window.confirm(`${names} がレビュー中です。編集するとレビューコメントが無効になる可能性がありますが、続けますか？`)
      if (!ok) return
    }
    saveCurrentScrollPosition()
    setMdViewModePersisted(mode)
    keepFocusInEditor()
  }, [saveCurrentScrollPosition, review.otherInProgressReviews, setMdViewModePersisted])
  const activeIsMarkdown = !!activeFilePath && isMarkdownFile(activeFilePath)
  useCommandHandler('editor.togglePreview', () => {
    if (activeIsMarkdown) handleSetMdViewMode(mdViewMode === 'preview' ? 'editor' : 'preview')
  }, { target: paneId, acceptsKey: () => activeIsMarkdown })
  useCommandHandler('editor.save', () => saving.handleSave(), { target: paneId })

  const handleContentChange = useCallback((newContent: string) => {
    if (!activeFilePath) return
    // Pin the file on first edit
    if (activeFilePath === previewFilePath && onPinFile) {
      onPinFile(activeFilePath)
    }
    setContent(activeFilePath, newContent)
  }, [activeFilePath, previewFilePath, onPinFile, setContent])

  const handleCloseTab = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    if (await saving.saveBeforeClose(path)) {
      onCloseFile(path)
      keepFocusInEditor()
    }
  }

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-gray-50 dark:bg-zinc-900/30 text-gray-400 dark:text-zinc-600">
        <FileText size={48} className="mb-4 opacity-50" />
        <p className="text-sm">ファイルを選択してください</p>
      </div>
    )
  }

  const { confirmRequest } = saving
  return (
    // tabIndex: a click on the preview (nothing focusable) still puts the focus in this editor's area.
    <div ref={rootRef} {...commandArea('editor', paneId)} tabIndex={-1} className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/30 outline-none">
      <EditorTabBar
        openFiles={openFiles}
        fileContents={fileContents}
        activeFilePath={activeFilePath}
        previewFilePath={previewFilePath}
        tabLabels={tabLabels}
        onSelect={handleSelectFile}
        onPin={onPinFile}
        onClose={handleCloseTab}
      />

      {activeFilePath && isReadOnly(activeFilePath) && <ReadOnlyNotice />}

      {activeFile?.missing && !activeFile.external && <MissingFileNotice />}

      {activeFile && activeFilePath && activeFile.external && (
        <ExternalChangeBanner
          file={{ ...activeFile, external: activeFile.external }}
          diffOpen={externalDiffPath === activeFilePath}
          onSave={() => { void saving.handleSave() }}
          onLoadDisk={() => { void saving.loadDiskVersion(activeFilePath).then(loaded => { if (loaded) setExternalDiffPath(null) }) }}
          onToggleDiff={() => setExternalDiffPath(p => (p === activeFilePath ? null : activeFilePath))}
          onKeepMine={() => { setExternalDiffPath(null); files.updateFile(activeFilePath, f => ({ ...f, keepMine: true })) }}
        />
      )}

      {notice && <EditorNotice notice={notice} onDismiss={() => setNotice(null)} />}

      <ConfirmDialog
        isOpen={confirmRequest !== null}
        title={confirmRequest?.title ?? ''}
        message={confirmRequest?.message ?? ''}
        confirmText={confirmRequest?.confirmText}
        cancelText="キャンセル"
        danger={confirmRequest?.danger}
        confirmOnEnter={false}
        onConfirm={() => saving.answerConfirm(true)}
        onCancel={() => saving.answerConfirm(false)}
      />

      {error && <EditorError error={error} onDismiss={() => setError(null)} />}

      {/* Editor / Image Preview */}
      <div className="flex-1 overflow-hidden min-w-0">
        {activeFile && activeFilePath && externalDiffPath === activeFilePath && activeFile.external?.kind === 'changed' ? (
          <div className="h-full flex flex-col">
            <div className="flex-shrink-0 px-4 py-1.5 border-b border-gray-200 dark:border-zinc-800/50 text-[11px] text-gray-500 dark:text-zinc-400">
              <span className="text-red-600 dark:text-red-400">−</span> ディスクの内容（外部の変更）／
              <span className="text-green-700 dark:text-green-400">＋</span> あなたの編集（未保存）
            </div>
            <div className="flex-1 overflow-hidden">
              <MarkdownDiffView
                snapshot={activeFile.external.diskContent}
                current={activeFile.content}
                noChangesMessage="ディスクの内容とあなたの編集に違いはありません"
              />
            </div>
          </div>
        ) : activeFile?.isLoading ? (
          <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500">
            読み込み中...
          </div>
        ) : activeFile && activeFilePath && isImageFile(activeFilePath) ? (
          <div className="h-full flex items-center justify-center overflow-auto p-4 bg-[repeating-conic-gradient(#e5e5e5_0%_25%,#fff_0%_50%)] dark:bg-[repeating-conic-gradient(#333_0%_25%,#222_0%_50%)] bg-[length:16px_16px]">
            <LocalImage
              filePath={activeFilePath}
              alt={fileNameOf(activeFilePath)}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : activeFile && activeFilePath && isPdfFile(activeFilePath) ? (
          <PdfPreview filePath={activeFilePath} />
        ) : activeFile && activeFilePath && isMarkdownFile(activeFilePath) && mdViewMode === 'preview' ? (
          <MarkdownPreviewPane
            paneId={paneId}
            filePath={activeFilePath}
            content={activeFile.content}
            review={review}
            textSelection={textSelection}
            showDiff={showDiff}
            setShowDiff={setShowDiff}
            previewRef={scroll.mdPreviewRef}
            initialScrollRatio={scroll.ratioOf(activeFilePath)}
            onShowEditor={() => handleSetMdViewMode('editor')}
            onEdit={() => {
              handleSetMdViewMode('editor')
              if (isActivePreviewTab && onPinFile && activeFilePath) {
                onPinFile(activeFilePath)
              }
            }}
          />
        ) : activeFile ? (
          <div className="h-full relative">
            <CodeEditor
              key={`${activeFilePath}:${gotoLine || 0}`}
              value={activeFile.content}
              onChange={handleContentChange}
              fileName={fileNameOf(activeFilePath || '')}
              initialLine={gotoLine || undefined}
              initialScrollRatio={activeFilePath ? scroll.ratioOf(activeFilePath) : undefined}
              onViewReady={(view) => { scroll.editorViewRef.current = view }}
            />
            {/* Floating view mode toggle for markdown files in editor mode */}
            {activeFilePath && isMarkdownFile(activeFilePath) && (
              <div className="absolute top-3 right-3 flex rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm overflow-hidden opacity-60 hover:opacity-100 transition-opacity">
                <button
                  className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-zinc-200"
                  title="エディタ"
                >
                  <Code size={12} />
                </button>
                <button
                  onClick={() => handleSetMdViewMode('preview')}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300"
                  title="プレビュー"
                >
                  <Eye size={12} />
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Footer hint */}
      <div className="flex-shrink-0 px-4 py-1.5 border-t border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50">
        <span className="text-[10px] text-gray-400 dark:text-zinc-600">
          {activeFile?.external
            ? '自動保存を止めています（外部の変更あり・未保存の変更あり）'
            : `自動保存 ${saving.hasChanges ? '(未保存の変更あり)' : ''}`}
        </span>
      </div>
    </div>
  )
}
