import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightning, FolderSimple, GitCommit, MagnifyingGlass, ChatCircle, CaretLeft } from '@phosphor-icons/react'
import { SkillGrid } from '../components/skill-ui/SkillGrid'
import { SkillDetailPanel } from '../components/skill-ui/SkillDetailPanel'
import { NewSkillWizard } from '../components/skill-ui/NewSkillWizard'
import { CopySkillModal } from '../components/skill-ui/CopySkillModal'
import { FileTreePanel } from '../components/skill-ui/FileTreePanel'
import { TabbedEditorPanel } from '../components/skill-ui/TabbedEditorPanel'
import { ToolViewer } from '../components/skill-ui/ToolViewer'
import { ChatPanel } from '../components/chat/ChatPanel'
import { SettingsPanel } from '../components/settings'
import { BackupHistorySlideOver } from '../components/skill-ui/BackupHistorySlideOver'
import { CommitHistoryPanel, invalidateCommitCache, prefetchCommits } from '../components/skill-ui/CommitHistoryPanel'
import { SearchPanel } from '../components/skill-ui/SearchPanel'
import { FileSearchModal } from '../components/skill-ui/FileSearchModal'
import { SyncPreviewDialog } from '../components/common/SyncPreviewDialog'
import type { SkillTool } from '../types'
import { useAppStore } from '../stores/appStore'
import { useSkills } from '../hooks/useSkills'
import { useSparseCheckout } from '../hooks/useSparseCheckout'
import { useDepartments } from '../hooks/useDepartments'
import { usePrivateFolderStore } from '../hooks/usePrivateFolders'
import { isChatInputRecentlyActive } from '../lib/chatInputActivity'
import { tabDepartmentLabels } from '../lib/editorTabs'
import { COMPANY_TAB_ID } from '../shared/lib/departments'
import { TitleBar } from './TitleBar'
import { SplitView } from '../features/workspace/components/SplitView'
import { DepartmentBar } from '../features/workspace/components/DepartmentBar'
import { useSplitLayout } from '../features/workspace/hooks/useSplitLayout'
import { useDepartmentSelection } from '../features/workspace/hooks/useDepartmentSelection'
import { useDepartmentAvailability } from '../features/workspace/hooks/useDepartmentAvailability'
import { PANE_LIMITS } from '../features/workspace/layoutTree'
import { useEditorPersistence } from '../features/editor/hooks/useEditorPersistence'
import { useEditorTabs } from '../features/editor/hooks/useEditorTabs'
import { useCompanyWatcher } from '../features/files/hooks/useCompanyWatcher'
import { useSkillActions } from '../features/skills/hooks/useSkillActions'
import { useSkillsAutoRefresh } from '../features/skills/hooks/useSkillsAutoRefresh'
import { skillCommands, type NewSkillInput } from '../features/skills/model'
import { useDepartmentDownload } from '../features/sync/hooks/useDepartmentDownload'
import { useSync } from '../features/sync/hooks/useSync'
import { DepartmentDownloadPrompt } from '../features/sync/components/DepartmentDownloadPrompt'
import { SyncNotification } from '../features/sync/components/SyncNotification'

// The main screen: composes the features (state lives in their hooks) and lays them out.

type LeftPanelTab = 'skills' | 'files' | 'search' | 'history'

// Classes of each pane of the split tree besides its size (SplitView adds that).
const PANE_CLASSES: Record<string, string> = {
  side: 'relative flex flex-col border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900',
  fileTree: 'overflow-hidden',
  editor: 'min-w-0',
}
const paneClassName = (paneId: string) => PANE_CLASSES[paneId] ?? ''
const dividerLabel = (splitId: string) => splitId === 'files' ? 'ファイルツリーとエディタの境目' : '左の欄とチャットの境目'

const VALID_LEFT_TABS: ReadonlyArray<LeftPanelTab> = ['skills', 'files', 'search', 'history']
const LEFT_TABS = { valid: VALID_LEFT_TABS, fallback: 'skills' } as const

export function AppShell() {
  const { t } = useTranslation()
  const currentCompany = useAppStore((s) => s.currentCompany)
  const setPendingChatInput = useAppStore((s) => s.setPendingChatInput)
  const rootPath = currentCompany?.rootPath

  const { departments, isLoading: isLoadingDepartments, refresh: refreshDepartments } = useDepartments(currentCompany?.id)
  const sparseCheckout = useSparseCheckout({ rootPath: rootPath || '' })

  // The department tab, saved per company; 全社 when the saved one is gone.
  const { selectedDeptId, selectDepartment } = useDepartmentSelection(currentCompany?.id, departments)
  const isCompanyWide = selectedDeptId === COMPANY_TAB_ID
  const selectedDept = useMemo(() => departments.find((d) => d.id === selectedDeptId), [departments, selectedDeptId])
  const effectiveDeptFolder = isCompanyWide ? '' : (selectedDept?.folder || '')
  // Which departments are not on this computer, and whether the selected one shows the download prompt.
  const { unsyncedFolders, isSelectedDeptUnsynced, markDownloaded } =
    useDepartmentAvailability(rootPath, departments, selectedDept, isCompanyWide, sparseCheckout)

  // Open file tabs, the active one and the left tab, saved per company.
  const { openFiles, setOpenFiles, activeFilePath, setActiveFilePath, leftTab, setLeftTab } =
    useEditorPersistence<LeftPanelTab>(currentCompany?.id, LEFT_TABS)
  const { previewFilePath, openFile: handleOpenFile, pinFile: handlePinFile, selectFile: handleSelectOpenFile, closeFile: handleCloseFile } =
    useEditorTabs({ openFiles, setOpenFiles, activeFilePath, setActiveFilePath })
  const tabLabels = useMemo(() => tabDepartmentLabels(openFiles, {
    rootPath: rootPath || '',
    departments,
    selectedDeptId: isCompanyWide ? null : selectedDeptId,
  }), [openFiles, rootPath, departments, isCompanyWide, selectedDeptId])

  // Pane sizes as a split tree, saved per company; the chat is one leaf and can be hidden.
  const { layout, collapsed: collapsedPane, toggleCollapsed, startResize, resize } = useSplitLayout(currentCompany?.id)
  const toggleChat = useCallback(() => toggleCollapsed('chat'), [toggleCollapsed])

  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showFileSearch, setShowFileSearch] = useState(false)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [showNewSkillWizard, setShowNewSkillWizard] = useState(false)
  const [showCopySkillModal, setShowCopySkillModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showBackupHistory, setShowBackupHistory] = useState(false)
  const [activeTool, setActiveTool] = useState<{ tool: SkillTool; port: number } | null>(null)

  // Left tabs opened at least once stay mounted (hidden when not shown).
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<LeftPanelTab>>(() => new Set([leftTab]))
  if (!visitedTabs.has(leftTab)) setVisitedTabs(new Set([...visitedTabs, leftTab]))
  // The history panel follows the department only while shown (it runs git log).
  const [historyDeptFolder, setHistoryDeptFolder] = useState(effectiveDeptFolder)
  if (leftTab === 'history' && historyDeptFolder !== effectiveDeptFolder) setHistoryDeptFolder(effectiveDeptFolder)

  // The shown department's skills (none while it is not downloaded), and the company-wide ones for slash commands.
  const { skills, isLoading: isLoadingSkills, refresh: refreshSkills } = useSkills({
    rootPath: rootPath || '',
    departmentFolder: isSelectedDeptUnsynced ? '' : effectiveDeptFolder,
    departmentId: isSelectedDeptUnsynced ? '' : (isCompanyWide ? COMPANY_TAB_ID : selectedDeptId),
    departmentName: isCompanyWide ? '全社' : selectedDept?.name,
  })
  const { skills: companySkills, refresh: refreshCompanySkills } = useSkills({
    rootPath: rootPath || '',
    departmentFolder: '',
    departmentId: isCompanyWide ? '' : COMPANY_TAB_ID, // Skip when already viewing company tab (avoid duplicate)
    departmentName: '全社',
  })
  const selectedSkill = useMemo(() => skills.find((s) => s.id === selectedSkillId), [skills, selectedSkillId])
  const slashCommands = useMemo(() => skillCommands(skills, companySkills, departments, isCompanyWide), [skills, companySkills, departments, isCompanyWide])
  const { createSkill, copySkillHere, shareSkill: handlePublishSkill, toggleNurturing: handleToggleNurturing } = useSkillActions({
    rootPath, departments, departmentFolder: effectiveDeptFolder, departmentId: selectedDeptId, refreshSkills,
  })

  useCompanyWatcher(rootPath)
  useSkillsAutoRefresh({
    rootPath,
    shownFolder: isSelectedDeptUnsynced ? null : effectiveDeptFolder,
    shownIsCompany: isCompanyWide,
    refreshSkills,
    refreshCompanySkills,
  })

  const handleDepartmentDownloaded = useCallback((folder: string) => {
    markDownloaded(folder)
    refreshSkills()
  }, [markDownloaded, refreshSkills])
  const { isDownloading, downloadError, download: handleDownloadDepartment } = useDepartmentDownload({
    folder: selectedDept?.folder,
    excludedPaths: sparseCheckout.excludedPaths,
    apply: sparseCheckout.apply,
    onDownloaded: handleDepartmentDownloaded,
  })

  // After a sync: private folders, departments, teammates' skills (shown and slash commands) and history.
  const handleSynced = useCallback(async () => {
    if (currentCompany?.id) void usePrivateFolderStore.getState().load(currentCompany.id)
    await refreshDepartments()
    void refreshSkills()
    if (!isCompanyWide) void refreshCompanySkills()
    invalidateCommitCache()
  }, [currentCompany?.id, refreshDepartments, refreshSkills, refreshCompanySkills, isCompanyWide])
  const {
    isSyncing, syncNotification, setSyncNotification, handleSync,
    showPreview, setShowPreview, isLoadingPreview, isLoadingSummary, previewData,
    handlePreview, handleRequestSummary, handleRevertFile,
  } = useSync({ rootPath, companyId: currentCompany?.id, onSynced: handleSynced })
  const handlePrivateFolderCreated = useCallback(() => { void handleSync() }, [handleSync])

  // Keyboard shortcuts: Cmd+Shift+F → search tab, Cmd+P → file search modal, Cmd+Shift+C → toggle chat
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault()
        setLeftTab('search')
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'p') {
        e.preventDefault()
        setShowFileSearch(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        if (isChatInputRecentlyActive()) return
        e.preventDefault()
        toggleChat()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setLeftTab, toggleChat])

  const handleSelectDept = (id: string) => {
    selectDepartment(id)
    setSelectedSkillId(null)
    // Open file tabs stay: one strip for the whole company, labelled with their department.
    const dept = departments.find(d => d.id === id)
    if (dept && rootPath) prefetchCommits(rootPath, dept.folder)
  }

  const handleSelectSkill = (id: string) => setSelectedSkillId(id)
  const handleExecuteSkill = useCallback((id: string) => {
    const skill = skills.find((s) => s.id === id)
    // The skill's folder name is its slash command.
    const folderName = skill?.skillPath?.split('/').pop()
    if (folderName) setPendingChatInput(`/${folderName} `, true)
  }, [skills, setPendingChatInput])
  const handleAddSkill = () => setShowNewSkillWizard(true)
  const handleCreateSkill = useCallback(async (data: NewSkillInput) => {
    const id = await createSkill(data)
    if (!id) return
    setShowNewSkillWizard(false)
    setSelectedSkillId(id)
  }, [createSkill])
  const handleCopySkill = useCallback(async (sourceSkillPath: string, name: string, folderName: string) => {
    const id = await copySkillHere(sourceSkillPath, name, folderName)
    if (!id) return
    setShowCopySkillModal(false)
    setSelectedSkillId(id)
  }, [copySkillHere])

  const handleEditFile = (filePath: string) => {
    setLeftTab('files')
    handleOpenFile(filePath)
  }
  const handleFileSearchSelect = useCallback((filePath: string) => {
    setLeftTab('files')
    handleOpenFile(filePath)
    handlePinFile(filePath)
  }, [handleOpenFile, handlePinFile, setLeftTab])

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-zinc-950">
      <TitleBar
        companyName={currentCompany?.name}
        isLoadingPreview={isLoadingPreview}
        isSyncing={isSyncing}
        onPreview={handlePreview}
        onSync={() => handleSync()}
        onShowBackups={() => setShowBackupHistory(true)}
        onShowSettings={() => setShowSettings(true)}
      />
      <DepartmentBar
        departments={departments}
        isLoading={isLoadingDepartments}
        selectedId={selectedDeptId}
        onSelect={handleSelectDept}
        unsyncedFolders={unsyncedFolders}
        showNotDownloadedNote={isCompanyWide && sparseCheckout.enabled && !!unsyncedFolders && unsyncedFolders.size > 0}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Main Content: the split tree (features/workspace/layoutTree.ts); the chat is one pane */}
      <SplitView
        split={layout.screen}
        limits={PANE_LIMITS}
        collapsed={collapsedPane}
        className="flex-1 overflow-hidden"
        paneClassName={paneClassName}
        dividerLabel={dividerLabel}
        onResizeStart={startResize}
        onResize={resize}
        renderCollapsed={() => (
          <button
            onClick={toggleChat}
            className="flex-shrink-0 w-6 flex flex-col items-center justify-center gap-1 bg-gray-100 dark:bg-zinc-800 border-l border-gray-200 dark:border-zinc-700 hover:bg-gray-200 dark:hover:bg-zinc-700 transition-colors cursor-pointer group"
            title="AIチャットを表示 (⌘⇧C)"
          >
            <CaretLeft size={14} className="text-gray-400 dark:text-zinc-500 group-hover:text-gray-600 dark:group-hover:text-zinc-300 transition-colors" />
            <ChatCircle size={16} className="text-gray-400 dark:text-zinc-500 group-hover:text-gray-600 dark:group-hover:text-zinc-300 transition-colors" />
          </button>
        )}
        renderPane={(paneId) => paneId === 'chat' ? (
          // Always mounted to keep its state while hidden.
          <ChatPanel
            departmentPath={rootPath}
            activeDepartment={isCompanyWide ? undefined : selectedDept ? { name: selectedDept.name, folder: selectedDept.folder } : undefined}
            slashCommands={slashCommands}
            onOpenFile={handleFileSearchSelect}
          />
        ) : (
        <>
        {/* Left side. The not-downloaded prompt is an overlay: the file tree
            and the other tabs stay mounted underneath (no cold re-read on a
            department switch), hidden while it shows. */}
          <div
            className={`flex-1 min-h-0 flex flex-col ${isSelectedDeptUnsynced ? 'invisible' : ''}`}
            aria-hidden={isSelectedDeptUnsynced || undefined}
          >
            {/* Tab Switcher */}
            <div className="flex-shrink-0 flex border-b border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900">
              <button
                onClick={() => setLeftTab('skills')}
                className={`
                  flex items-center gap-2 px-4 py-2.5 text-sm font-medium
                  border-b-2 transition-colors
                  ${leftTab === 'skills'
                    ? 'border-accent text-gray-900 dark:text-zinc-100'
                    : 'border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200'
                  }
                `}
              >
                <Lightning size={16} weight={leftTab === 'skills' ? 'fill' : 'regular'} />
                {t('tabs.skills')}
              </button>
              <button
                onClick={() => setLeftTab('files')}
                className={`
                  flex items-center gap-2 px-4 py-2.5 text-sm font-medium
                  border-b-2 transition-colors
                  ${leftTab === 'files'
                    ? 'border-accent text-gray-900 dark:text-zinc-100'
                    : 'border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200'
                  }
                `}
              >
                <FolderSimple size={16} weight={leftTab === 'files' ? 'fill' : 'regular'} />
                {t('tabs.files')}
              </button>
              <button
                onClick={() => { setLeftTab('search'); requestAnimationFrame(() => searchInputRef.current?.focus()) }}
                className={`
                  flex items-center gap-2 px-4 py-2.5 text-sm font-medium
                  border-b-2 transition-colors
                  ${leftTab === 'search'
                    ? 'border-accent text-gray-900 dark:text-zinc-100'
                    : 'border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200'
                  }
                `}
              >
                <MagnifyingGlass size={16} weight={leftTab === 'search' ? 'fill' : 'regular'} />
                検索
              </button>
              <button
                onClick={() => setLeftTab('history')}
                className={`
                  flex items-center gap-2 px-4 py-2.5 text-sm font-medium
                  border-b-2 transition-colors
                  ${leftTab === 'history'
                    ? 'border-accent text-gray-900 dark:text-zinc-100'
                    : 'border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200'
                  }
                `}
              >
                <GitCommit size={16} weight={leftTab === 'history' ? 'fill' : 'regular'} />
                履歴
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden min-w-0">
              {/* Tabs stay mounted once opened (hidden via CSS), so switching
                  tabs keeps their state instead of remounting. History only
                  follows the department while it is shown: it runs git log. */}
              {/* History Tab */}
              {visitedTabs.has('history') && (
                <div className={`h-full ${leftTab !== 'history' ? 'hidden' : ''}`}>
                  <CommitHistoryPanel
                    rootPath={rootPath || ''}
                    departmentFolder={historyDeptFolder}
                  />
                </div>
              )}

              {/* Search Tab */}
              {visitedTabs.has('search') && (
                <div className={`h-full ${leftTab !== 'search' ? 'hidden' : ''}`}>
                  <SearchPanel
                    rootPath={rootPath || ''}
                    departmentFolder={effectiveDeptFolder}
                    inputRef={searchInputRef}
                  />
                </div>
              )}

              {/* Skills Tab */}
              {visitedTabs.has('skills') && (
                <div className={`h-full flex ${leftTab !== 'skills' ? 'hidden' : ''}`}>
                  <div className={`${selectedSkillId ? 'w-1/2' : 'w-full'} transition-all overflow-hidden`}>
                    <SkillGrid
                      skills={skills}
                      color={selectedDept?.color || '#6366f1'}
                      selectedSkillId={selectedSkillId}
                      onSelectSkill={handleSelectSkill}
                      onExecuteSkill={handleExecuteSkill}
                      onAddSkill={handleAddSkill}
                      onCopySkill={!isCompanyWide ? () => setShowCopySkillModal(true) : undefined}
                      isLoading={isLoadingSkills}
                    />
                  </div>
                  {selectedSkillId && selectedSkill && (
                    <div className="w-1/2 border-l border-gray-200 dark:border-zinc-800 overflow-hidden">
                      <SkillDetailPanel
                        skill={selectedSkill}
                        color={selectedDept?.color || '#6366f1'}
                        onClose={() => setSelectedSkillId(null)}
                        onExecute={() => handleExecuteSkill(selectedSkillId)}
                        onEditFile={handleEditFile}
                        onOpenTool={(tool, port) => setActiveTool({ tool, port })}
                        onPublish={handlePublishSkill}
                        onToggleNurturing={handleToggleNurturing}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Files Tab - always mounted, hidden via CSS to preserve state */}
              <SplitView
                split={layout.files}
                limits={PANE_LIMITS}
                className={`h-full min-w-0 ${leftTab !== 'files' ? 'hidden' : ''}`}
                paneClassName={paneClassName}
                dividerLabel={dividerLabel}
                onResizeStart={startResize}
                onResize={resize}
                renderPane={(filesPaneId) => filesPaneId === 'fileTree' ? (
                  <FileTreePanel
                    rootPath={rootPath || ''}
                    departmentFolder={effectiveDeptFolder}
                    selectedFilePath={activeFilePath}
                    onSelectFile={handleOpenFile}
                    onDoubleClickFile={handlePinFile}
                    onPrivateFolderCreated={handlePrivateFolderCreated}
                  />
                ) : (
                  <TabbedEditorPanel
                    openFiles={openFiles}
                    activeFilePath={activeFilePath}
                    previewFilePath={previewFilePath}
                    tabLabels={tabLabels}
                    onSelectFile={handleSelectOpenFile}
                    onCloseFile={handleCloseFile}
                    onPinFile={handlePinFile}
                  />
                )}
              />
            </div>
          </div>
          {isSelectedDeptUnsynced && (
            <DepartmentDownloadPrompt
              departmentName={selectedDept?.name}
              color={selectedDept?.color}
              isDownloading={isDownloading}
              error={downloadError}
              onDownload={handleDownloadDepartment}
            />
          )}
        </>
        )}
      />

      {/* New Skill Wizard Modal */}
      {showNewSkillWizard && selectedDept && (
        <NewSkillWizard
          departmentName={selectedDept.name}
          color={selectedDept.color}
          onClose={() => setShowNewSkillWizard(false)}
          onComplete={handleCreateSkill}
        />
      )}

      {/* Copy Skill Modal */}
      {showCopySkillModal && currentCompany && (
        <CopySkillModal
          rootPath={currentCompany.rootPath}
          currentDepartmentId={selectedDeptId}
          departments={departments}
          color={selectedDept?.color || '#6366f1'}
          onClose={() => setShowCopySkillModal(false)}
          onCopy={handleCopySkill}
          unsyncedFolders={unsyncedFolders}
        />
      )}

      {/* File Search Modal (Cmd+P) */}
      <FileSearchModal
        isOpen={showFileSearch}
        onClose={() => setShowFileSearch(false)}
        rootPath={rootPath || ''}
        departmentFolder={effectiveDeptFolder}
        onSelectFile={handleFileSearchSelect}
      />

      {/* Settings Panel Modal */}
      {showSettings && (
        <SettingsPanel onClose={() => {
          setShowSettings(false)
          sparseCheckout.refresh()
        }} />
      )}

      {/* Backup History Slide Over */}
      <BackupHistorySlideOver
        isOpen={showBackupHistory}
        onClose={() => setShowBackupHistory(false)}
        rootPath={rootPath || ''}
      />

      {/* Tool Viewer */}
      {activeTool && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8">
          <div className="w-full h-full max-w-6xl max-h-[90vh] rounded-xl overflow-hidden shadow-2xl">
            <ToolViewer
              tool={activeTool.tool}
              port={activeTool.port}
              color={selectedDept?.color || '#6366f1'}
              onClose={() => setActiveTool(null)}
            />
          </div>
        </div>
      )}

      {/* Sync Preview Dialog */}
      {previewData && (
        <SyncPreviewDialog
          isOpen={showPreview}
          onClose={() => setShowPreview(false)}
          changes={previewData.changes}
          totalCount={previewData.totalCount}
          summary={previewData.summary}
          isLoadingSummary={isLoadingSummary}
          onRequestSummary={handleRequestSummary}
          rootPath={rootPath || ''}
          onSync={(commitMessage) => { setShowPreview(false); handleSync(commitMessage) }}
          isSyncing={isSyncing}
          onRevertFile={handleRevertFile}
        />
      )}

      {syncNotification && (
        <SyncNotification
          notice={syncNotification}
          onDismiss={() => setSyncNotification(null)}
          onShowBackups={() => { setShowBackupHistory(true); setSyncNotification(null) }}
        />
      )}
    </div>
  )
}
