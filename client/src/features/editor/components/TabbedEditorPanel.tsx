// Over ~300 lines: it only composes the editor's hooks and parts (files-and-editor.md); splitting its JSX would scatter one screen.
import { useState, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { FileText, Code, Eye } from '@phosphor-icons/react'
import { CodeEditor } from '../../../shared/ui/CodeEditor'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { MarkdownDiffView } from '../../doc-review/components/MarkdownDiffView'
import { useWriteAccess } from '../../../shared/hooks/useWriteAccess'
import { useAppStore } from '../../../stores/appStore'
import { fileNameOf, isHtmlFile, isImageFile, isMarkdownFile, isPdfFile } from '../fileKinds'
import { useOpenFiles } from '../hooks/useOpenFiles'
import { useFileSaving } from '../hooks/useFileSaving'
import { useEditorReview } from '../hooks/useEditorReview'
import { useMarkdownViewMode, useScrollMemory, type MdViewMode } from '../hooks/useMarkdownView'
import { commandArea, runCommand, useCommandHandler } from '../../../shared/commands/commands'
import { EditorTabBar } from './EditorTabBar'
import type { TabArrangement } from '../hooks/useTabArrangement'
import { fileTabsOf, recordIdOfTab, viewOfTab, type RecordTabLook, type ViewTabLook } from '../editorTabs'
import { EditorError, EditorNotice, ExternalChangeBanner, MissingFileNotice, ReadOnlyNotice } from './EditorNotices'
import { LocalImage, PdfPreview } from './BinaryPreviews'
import { MarkdownPreviewPane } from './MarkdownPreviewPane'
import { HtmlDocumentPane } from './HtmlDocumentPane'
import { HtmlSourceBar } from './HtmlViewToggle'

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
  /** This editor's pane: its shortcuts (⌘S, ⌘⇧V, ⌘F) work only while the focus is inside it. */
  paneId?: string
  /** In front of the tabs (← →). */
  navigation?: ReactNode
  /** Record tabs' titles and kinds, by record id (`editorTabs.ts`). */
  recordLooks?: Readonly<Record<string, RecordTabLook>>
  /** The card of the record whose tab is active (drawn by the screen: the task card, a record's card). */
  renderRecord?: (recordId: string) => ReactNode
  /** Screen tabs (`viewTabKey`): their tab's title and icon, and the page the screen draws. */
  viewLooks?: Readonly<Record<string, ViewTabLook>>
  renderView?: (name: string) => ReactNode
  /** Beside the active file (「つながっているもの」, 「前の版」). */
  aside?: ReactNode
  /** Pinned (固定) tabs and their toggle (「タブを片づける」 leaves them open). */
  pinnedTabs?: ReadonlySet<string>
  onTogglePinned?: (key: string) => void
  /** How the tabs stand: order by drag, named groups, by kind (`useTabArrangement`). */
  arrangement?: TabArrangement
  /** At the tabs' right end (the 「…」 menu), also shown with no tab open. */
  tabsEnd?: ReactNode
  /** One line above the tabs (what a tidy did). */
  notice?: ReactNode
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
  navigation,
  recordLooks,
  renderRecord,
  viewLooks,
  renderView,
  aside,
  pinnedTabs,
  onTogglePinned,
  arrangement,
  tabsEnd,
  notice: topNotice,
}: TabbedEditorPanelProps) {
  // Records share the tabs; only the file tabs load text, save and keep scroll positions.
  const activeRecordId = recordIdOfTab(activeFilePath)
  const activeView = viewOfTab(activeFilePath)
  const tabs = openFiles
  const fileTabs = useMemo(() => fileTabsOf(tabs), [tabs])
  const shownFile = activeRecordId || activeView ? null : activeFilePath
  const { isReadOnly } = useWriteAccess()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The tab whose 「差分を見る」 view (disk version vs. the tab's edits) is open.
  const [externalDiffPath, setExternalDiffPath] = useState<string | null>(null)
  const rootPath = useAppStore(s => s.currentCompany?.rootPath ?? null)
  const { mdViewMode, setMdViewModePersisted } = useMarkdownViewMode()
  const scroll = useScrollMemory(fileTabs, shownFile, mdViewMode)
  const { saveCurrentScrollPosition } = scroll
  const isActivePreviewTab = shownFile === previewFilePath
  const rootRef = useRef<HTMLDivElement>(null)
  // The button just pressed may be gone after the switch: keep the focus (and so ⌘S, ⌘F) in this editor.
  const keepFocusInEditor = () => requestAnimationFrame(() => {
    if (!document.activeElement || document.activeElement === document.body) rootRef.current?.focus({ preventScroll: true })
  })
  const [showDiff, setShowDiff] = useState(false)

  // The review reloads when a sidecar of the active file changes (the watcher in useOpenFiles).
  const reviewReloadRef = useRef<() => void>(() => {})
  const files = useOpenFiles(fileTabs, shownFile, reviewReloadRef, setError)
  const { fileContents, setContent } = files
  const activeFile = shownFile ? fileContents.get(shownFile) : null
  const { review, textSelection } = useEditorReview(shownFile, activeFile?.content || '')
  reviewReloadRef.current = review.reload

  const saving = useFileSaving({
    activeFilePath: shownFile,
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
  const activeIsMarkdown = !!shownFile && isMarkdownFile(shownFile)
  // HTML opens as 見る (the proposal); the tabs showing 中身 instead, for this run of the app.
  const [htmlSources, setHtmlSources] = useState<ReadonlySet<string>>(() => new Set())
  const activeIsHtml = !!shownFile && isHtmlFile(shownFile)
  // Each HTML tab's document zoom, kept while its viewer comes and goes (another tab, 中身).
  const htmlZooms = useRef(new Map<string, number>())
  // The same choice, read as the document view closes (before React shows 中身): left for 中身 →
  // main keeps where the document was scrolled for 見る again.
  const htmlSourcesNow = useRef(new Set<string>())
  const showHtmlSource = (path: string, source: boolean) => {
    saveCurrentScrollPosition()
    if (source) htmlSourcesNow.current.add(path)
    else htmlSourcesNow.current.delete(path)
    setHtmlSources(prev => {
      const next = new Set(prev)
      if (source) next.add(path)
      else next.delete(path)
      return next
    })
    keepFocusInEditor()
  }
  useCommandHandler('editor.togglePreview', () => {
    if (activeIsMarkdown) handleSetMdViewMode(mdViewMode === 'preview' ? 'editor' : 'preview')
    else if (activeIsHtml && shownFile) showHtmlSource(shownFile, !htmlSources.has(shownFile))
  }, { target: paneId, acceptsKey: () => activeIsMarkdown || activeIsHtml })
  useCommandHandler('editor.save', () => saving.handleSave(), { target: paneId })
  // The chat's ［見る］ (doc-frame.md "The chat's ［見る］"): the document's tab, shown as 見る.
  useCommandHandler('editor.viewDocument', ({ path }) => {
    if (!isHtmlFile(path)) return
    if (htmlSources.has(path)) showHtmlSource(path, false)
    return runCommand('file.open', { path })
  }, { target: paneId })

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
    if (recordIdOfTab(path) || viewOfTab(path) || await saving.saveBeforeClose(path)) {
      onCloseFile(path)
      keepFocusInEditor()
    }
  }

  if (tabs.length === 0) {
    return (
      <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/30">
        {topNotice}
        {(navigation || tabsEnd) && <div className="flex-shrink-0 flex items-center border-b border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50">{navigation}<div className="flex-1" />{tabsEnd && <div className="flex items-center px-1">{tabsEnd}</div>}</div>}
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-600">
          <FileText size={44} className="mb-3 opacity-50" />
          <p className="text-small">左のやることやファイルを押すと、ここにタブで開きます</p>
        </div>
      </div>
    )
  }

  const { confirmRequest } = saving
  return (
    // tabIndex: a click on the preview (nothing focusable) still puts the focus in this editor's area.
    <div ref={rootRef} {...commandArea('editor', paneId)} tabIndex={-1} className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/30 outline-none">
      {topNotice}
      <div className="flex-shrink-0 flex min-w-0 bg-gray-100 dark:bg-zinc-900/50">
      {navigation}
      <div className="flex-1 min-w-0">
      <EditorTabBar
        openFiles={tabs}
        fileContents={fileContents}
        activeFilePath={activeFilePath}
        recordLooks={recordLooks}
        viewLooks={viewLooks}
        previewFilePath={previewFilePath}
        tabLabels={tabLabels}
        onSelect={handleSelectFile}
        onPin={onPinFile}
        onClose={handleCloseTab}
        pinnedTabs={pinnedTabs}
        onTogglePinned={onTogglePinned}
        arrangement={arrangement}
        end={tabsEnd}
      />
      </div>
      </div>

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

      {activeView ? <div className="flex-1 min-h-0 min-w-0 flex flex-col" data-testid="view-tab">{renderView?.(activeView)}</div>
        : activeRecordId ? <div className="flex-1 overflow-auto min-w-0" data-testid="record-tab">{renderRecord?.(activeRecordId)}</div> : <>

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


      {error && <EditorError error={error} onDismiss={() => setError(null)} />}

      {/* Editor / Image Preview, and beside it the file's links and earlier versions */}
      <div className="flex-1 min-h-0 flex min-w-0">
      <div className="flex-1 overflow-hidden min-w-0">
        {activeFile && activeFilePath && externalDiffPath === activeFilePath && activeFile.external?.kind === 'changed' ? (
          <div className="h-full flex flex-col">
            <div className="flex-shrink-0 px-4 py-1.5 border-b border-gray-200 dark:border-zinc-800/50 text-caption font-normal text-gray-500 dark:text-zinc-400">
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
        ) : activeFile && activeFilePath && isHtmlFile(activeFilePath) && !htmlSources.has(activeFilePath) ? (
          // One view per file and per showing: another tab or 中身 closes it (its scripts stop).
          <HtmlDocumentPane
            key={activeFilePath}
            filePath={activeFilePath}
            onShowSource={() => showHtmlSource(activeFilePath, true)}
            leavingForSource={() => htmlSourcesNow.current.has(activeFilePath)}
            zoom={htmlZooms.current.get(activeFilePath)}
            onZoom={zoom => htmlZooms.current.set(activeFilePath, zoom)}
          />
        ) : activeFile?.isLoading ? (
          <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500">
            読み込んでいます
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
            // One preview per file: it restores that file's scroll position when mounted.
            key={activeFilePath}
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
          <div className={activeFilePath && isHtmlFile(activeFilePath) ? 'h-full flex flex-col' : 'h-full relative'}>
            {/* 中身 of an .html tab: its ［見る｜中身］ stays where the document's toolbar had it. */}
            {activeFilePath && isHtmlFile(activeFilePath) && <HtmlSourceBar onShowDocument={() => showHtmlSource(activeFilePath, false)} />}
            <div className={activeFilePath && isHtmlFile(activeFilePath) ? 'flex-1 min-h-0' : 'h-full'}>
            <CodeEditor
              key={`${activeFilePath}:${gotoLine || 0}`}
              value={activeFile.content}
              onChange={handleContentChange}
              fileName={fileNameOf(activeFilePath || '')}
              initialLine={gotoLine || undefined}
              initialScrollRatio={activeFilePath ? scroll.ratioOf(activeFilePath) : undefined}
              onViewReady={(view) => { scroll.editorViewRef.current = view }}
            />
            </div>
            {/* Floating view mode toggle for markdown files in editor mode */}
            {activeFilePath && isMarkdownFile(activeFilePath) && (
              <div className="absolute top-3 right-3 flex rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm overflow-hidden opacity-60 hover:opacity-100 transition-opacity">
                <button
                  className="flex items-center gap-1 px-2 py-1 text-caption font-normal transition-colors bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-zinc-200"
                  title="エディタ"
                >
                  <Code size={12} />
                </button>
                <button
                  onClick={() => handleSetMdViewMode('preview')}
                  className="flex items-center gap-1 px-2 py-1 text-caption font-normal transition-colors text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300"
                  title="プレビュー"
                >
                  <Eye size={12} />
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {activeFile && aside}
      </div>

      </>}
    </div>
  )
}
