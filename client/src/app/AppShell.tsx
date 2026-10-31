import { useState, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightning, FolderSimple, GitCommit, MagnifyingGlass, ChatCircle, CaretLeft } from '@phosphor-icons/react'
import { ChatPanel } from '../features/chat/components/ChatPanel'
import { CommitHistoryPanel, invalidateCommitCache, prefetchCommits } from '../components/skill-ui/CommitHistoryPanel'
import { SearchPanel } from '../components/skill-ui/SearchPanel'
import { useAppStore } from '../stores/appStore'
import { useSkills } from '../features/skills/hooks/useSkills'
import { useSparseCheckout } from '../shared/hooks/useSparseCheckout'
import { useDepartments } from '../shared/hooks/useDepartments'
import { usePrivateFolderStore } from '../features/files/hooks/usePrivateFolders'
import { isChatInputRecentlyActive } from '../lib/chatInputActivity'
import { tabDepartmentLabels } from '../features/editor/editorTabs'
import { COMPANY_TAB_ID } from '../shared/lib/departments'
import { TitleBar } from './TitleBar'
import { FilesPanel } from './FilesPanel'
import { AppDialogs } from './AppDialogs'
import { LeftPanelTabs } from '../features/workspace/components/LeftPanelTabs'
import type { LeftPanel } from '../features/workspace/leftPanels'
import { SkillsPanel } from '../features/skills/components/SkillsPanel'
import { SplitView } from '../features/workspace/components/SplitView'
import { DepartmentBar } from '../features/workspace/components/DepartmentBar'
import { useSplitLayout } from '../features/workspace/hooks/useSplitLayout'
import { useDepartmentSelection } from '../features/workspace/hooks/useDepartmentSelection'
import { useDepartmentAvailability } from '../features/workspace/hooks/useDepartmentAvailability'
import { PANE_LIMITS } from '../features/workspace/layoutTree'
import { useEditorPersistence } from '../features/editor/hooks/useEditorPersistence'
import { useEditorTabs } from '../features/editor/hooks/useEditorTabs'
import { useCompanyWatcher } from '../features/files/hooks/useCompanyWatcher'
import { useSkillsTab } from '../features/skills/hooks/useSkillsTab'
import { useSkillsAutoRefresh } from '../features/skills/hooks/useSkillsAutoRefresh'
import { skillCommands } from '../features/skills/model'
import { useDepartmentDownload } from '../features/sync/hooks/useDepartmentDownload'
import { useSync } from '../features/sync/hooks/useSync'
import { useAutoSync } from '../features/sync/hooks/useAutoSync'
import { DepartmentDownloadPrompt } from '../features/sync/components/DepartmentDownloadPrompt'
import { useCommandHandler, useKeybindings } from '../shared/commands/commands'
import { useFilesFromChatWindows } from '../features/chat/hooks/useFilesFromChatWindows'
import { useSaveBeforeLeaving } from '../features/editor/hooks/useSaveBeforeLeaving'
import { LeaveConfirmDialog } from '../features/editor/components/LeaveConfirmDialog'
import { useAuthStore } from '../stores/authStore'

// The main screen: composes the features (state lives in their hooks) and lays them out.

// Classes of each pane of the split tree besides its size (SplitView adds that).
const PANE_CLASSES: Record<string, string> = {
  side: 'relative flex flex-col border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900',
  fileTree: 'overflow-hidden',
}
const paneClassName = (paneId: string) => PANE_CLASSES[paneId] ?? ''
const dividerLabel = (splitId: string) => splitId === 'files' ? 'ファイルツリーとエディタの境目' : '左の欄とチャットの境目'

// The first registered panel opens when nothing (or an id no panel has) is remembered.
const DEFAULT_LEFT_PANEL = 'skills'

export function AppShell() {
  const { t } = useTranslation()
  const currentCompany = useAppStore((s) => s.currentCompany)
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
    useEditorPersistence(currentCompany?.id, DEFAULT_LEFT_PANEL)
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
  const [showSettings, setShowSettings] = useState(false)
  // Settings opened on 「自分の鍵」 for one service (the chat's "no key" card); null = the usual first page.
  const [settingsFocus, setSettingsFocus] = useState<{ service?: string; at: number } | null>(null)
  const [showBackupHistory, setShowBackupHistory] = useState(false)

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
  const slashCommands = useMemo(() => skillCommands(skills, companySkills, departments, isCompanyWide), [skills, companySkills, departments, isCompanyWide])
  const skillsTab = useSkillsTab({
    rootPath, departments, departmentFolder: effectiveDeptFolder, departmentId: selectedDeptId, skills, refreshSkills,
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
    change: sparseCheckout.change,
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
  const sync = useSync({ rootPath, companyId: currentCompany?.id, onSynced: handleSynced })

  // Signing out closes this screen: every open tab is saved first (useSaveBeforeLeaving).
  const leaving = useSaveBeforeLeaving()
  const signOut = useAuthStore(s => s.signOut)
  const handleLogout = useCallback(async () => {
    if (!await leaving.confirmLeave()) return
    try {
      await signOut()
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }, [leaving, signOut])
  const { handleSync } = sync
  // 「自動で受け取る」 / 「自動で送る」 while the app is open (Settings → 自動同期).
  const autoSync = useAutoSync({
    rootPath,
    companyId: currentCompany?.id,
    isSyncing: sync.isSyncing,
    setIsSyncing: sync.setIsSyncing,
    showNotice: sync.setSyncNotification,
    onSynced: handleSynced,
  })
  const handlePrivateFolderCreated = useCallback(() => { void handleSync() }, [handleSync])

  // The app's shortcuts are commands (shared/commands/catalog.ts), delivered to the focused area only.
  useKeybindings()
  useCommandHandler('search.show', () => {
    setLeftTab('search')
    requestAnimationFrame(() => searchInputRef.current?.focus())
  })
  useCommandHandler('file.search', () => setShowFileSearch(true))
  // Just typed in the chat: ⌘⇧C stays with the chat input instead of hiding it.
  useCommandHandler('layout.toggleChat', toggleChat, { acceptsKey: () => !isChatInputRecentlyActive() })
  useCommandHandler('settings.openOwnKey', ({ service }) => {
    setSettingsFocus({ service, at: Date.now() })
    setShowSettings(true)
  })

  const handleSelectDept = (id: string) => {
    selectDepartment(id)
    skillsTab.selectSkill(null)
    // Open file tabs stay: one strip for the whole company, labelled with their department.
    const dept = departments.find(d => d.id === id)
    if (dept && rootPath) prefetchCommits(rootPath, dept.folder)
  }

  const handleEditFile = (filePath: string) => {
    setLeftTab('files')
    handleOpenFile(filePath)
  }
  const handleFileSearchSelect = useCallback((filePath: string) => {
    setLeftTab('files')
    handleOpenFile(filePath)
    handlePinFile(filePath)
  }, [handleOpenFile, handlePinFile, setLeftTab])
  useCommandHandler('file.open', ({ path }) => handleFileSearchSelect(path))
  // A file link in a consultation's own window opens here (that window has no editor).
  useFilesFromChatWindows()

  // The left panel's tabs, registered like an extension's tab will be (features/workspace/leftPanels.ts).
  const leftPanels: LeftPanel[] = [
    {
      id: 'skills', title: t('tabs.skills'), icon: Lightning, mount: 'once-opened', className: 'flex',
      render: () => (
        <SkillsPanel
          skills={skills}
          isLoading={isLoadingSkills}
          color={selectedDept?.color || '#6366f1'}
          selectedSkill={skillsTab.selectedSkill}
          selectedSkillId={skillsTab.selectedSkillId}
          onSelectSkill={skillsTab.selectSkill}
          onCloseSkill={() => skillsTab.selectSkill(null)}
          onExecuteSkill={skillsTab.executeSkill}
          onAddSkill={() => skillsTab.setWizardOpen(true)}
          onCopySkill={!isCompanyWide ? () => skillsTab.setCopyOpen(true) : undefined}
          onEditFile={handleEditFile}
          onOpenTool={(tool, port) => skillsTab.setActiveTool({ tool, port })}
          onPublish={skillsTab.shareSkill}
          onToggleNurturing={skillsTab.toggleNurturing}
        />
      ),
    },
    {
      // Always mounted: the file tree and the open files keep their state.
      id: 'files', title: t('tabs.files'), icon: FolderSimple, mount: 'always',
      render: () => (
        <FilesPanel
          split={layout.files}
          paneClassName={paneClassName}
          dividerLabel={dividerLabel}
          onResizeStart={startResize}
          onResize={resize}
          rootPath={rootPath || ''}
          departmentFolder={effectiveDeptFolder}
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          previewFilePath={previewFilePath}
          tabLabels={tabLabels}
          onOpenFile={handleOpenFile}
          onPinFile={handlePinFile}
          onSelectOpenFile={handleSelectOpenFile}
          onCloseFile={handleCloseFile}
          onPrivateFolderCreated={handlePrivateFolderCreated}
        />
      ),
    },
    {
      id: 'search', title: '検索', icon: MagnifyingGlass, mount: 'once-opened',
      onOpen: () => requestAnimationFrame(() => searchInputRef.current?.focus()),
      render: () => <SearchPanel rootPath={rootPath || ''} departmentFolder={effectiveDeptFolder} inputRef={searchInputRef} />,
    },
    {
      // Follows the department only while shown: it runs git log.
      id: 'history', title: '履歴', icon: GitCommit, mount: 'once-opened',
      render: () => <CommitHistoryPanel rootPath={rootPath || ''} departmentFolder={historyDeptFolder} />,
    },
  ]

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-zinc-950">
      <TitleBar
        companyName={currentCompany?.name}
        isLoadingPreview={sync.isLoadingPreview}
        isSyncing={sync.isSyncing}
        syncTitle={autoSync.syncButtonTitle}
        onPreview={sync.handlePreview}
        onSync={() => handleSync()}
        onShowBackups={() => setShowBackupHistory(true)}
        onShowSettings={() => setShowSettings(true)}
        onLogout={() => { void handleLogout() }}
      />
      <LeaveConfirmDialog question={leaving.question} onAnswer={leaving.answer} />
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
            paneId={paneId}
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
            <LeftPanelTabs panels={leftPanels} selectedId={leftTab} onSelect={setLeftTab} />
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

      <AppDialogs
        rootPath={rootPath || ''}
        departments={departments}
        selectedDeptId={selectedDeptId}
        selectedDept={selectedDept}
        departmentFolder={effectiveDeptFolder}
        unsyncedFolders={unsyncedFolders}
        skillsTab={skillsTab}
        sync={sync}
        showFileSearch={showFileSearch}
        onCloseFileSearch={() => setShowFileSearch(false)}
        onFileSearchSelect={handleFileSearchSelect}
        showSettings={showSettings}
        settingsFocus={settingsFocus}
        onCloseSettings={() => { setShowSettings(false); setSettingsFocus(null); sparseCheckout.refresh() }}
        showBackupHistory={showBackupHistory}
        setShowBackupHistory={setShowBackupHistory}
      />
    </div>
  )
}
