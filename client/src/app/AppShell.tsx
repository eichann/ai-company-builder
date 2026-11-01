import { useState, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightning, FolderSimple, MagnifyingGlass, ChatCircle, CaretLeft, ListChecks } from '@phosphor-icons/react'
import { ChatPanel } from '../features/chat/components/ChatPanel'
import { refreshFileVersions } from '../features/history/refresh'
import { RecordCard } from '../features/records/components/RecordCard'
import { usePlaceHistory } from '../features/editor/hooks/usePlaceHistory'
import { PlaceNavigation } from '../features/editor/components/PlaceNavigation'
import { FileSidePanel } from './FileSidePanel'
import { SearchPanel } from '../features/search/components/SearchPanel'
import { useAppStore } from '../stores/appStore'
import { useSkills } from '../features/skills/hooks/useSkills'
import { useSparseCheckout } from '../shared/hooks/useSparseCheckout'
import { useDepartments } from '../shared/hooks/useDepartments'
import { usePrivateFolderStore } from '../features/files/hooks/usePrivateFolders'
import { isChatInputRecentlyActive } from '../shared/lib/chatInputActivity'
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
import { runCommand, useCommandHandler, useKeybindings } from '../shared/commands/commands'
import { useFilesFromChatWindows } from '../features/chat/hooks/useFilesFromChatWindows'
import { useSaveBeforeLeaving } from '../features/editor/hooks/useSaveBeforeLeaving'
import { LeaveConfirmDialog } from '../features/editor/components/LeaveConfirmDialog'
import { useAuthStore } from '../stores/authStore'
import { useMinutesNotices } from '../features/minutes/hooks/useMinutesNotices'
import { startMinutesReading } from '../features/minutes/startReading'
import { skipMinutes } from '../features/minutes/api'
import { MinutesCheckButton } from '../features/minutes/components/MinutesCheckButton'
import type { AiTurnItemsView } from '../../shared/ai-turns'
import { useNotices } from '../features/notifications/hooks/useNotices'
import { TitleBarNotices } from '../features/notifications/components/TitleBarNotices'
import { useTaskList } from '../features/tasks/hooks/useTaskList'
import { TaskListPanel } from '../features/tasks/components/TaskListPanel'
import { renderRecordSource } from './recordSource'
import { companyPathOf, listShownFor } from '../features/tasks/model'
import { LinkToTaskDialog } from '../features/tasks/components/LinkToTaskDialog'
import { linkFileToTask } from '../features/tasks/api'
import { TaskCard } from '../features/tasks/components/TaskCard'
import { PreparedMailCard } from '../features/chat/components/PreparedMailCard'
import { ApprovalCard } from '../features/chat/components/ApprovalCard'
import { RecordRow } from '../features/records/components/RecordRows'
import type { RecordViewSummary } from '../../shared/record-views'

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
  // Received minutes: main checks while Google may read the member's minutes (features/minutes); the
  // AI turn runner reads them, the task list shows them in 「AI の番」.
  const minutes = useMinutesNotices(currentCompany?.id)
  // Where each of them stands with the automatic 「AI の番」 (the chat's runner reports it).
  const [aiTurnItems, setAiTurnItems] = useState<AiTurnItemsView | null>(null)
  // 「あなたの番」 and the bell (features/notifications): main reads them with the session.
  const notices = useNotices(currentCompany?.id)
  // やることの一覧 (features/tasks): read here for the tab's count and whether it shows.
  const taskList = useTaskList(currentCompany?.id)
  // 「やることにつなぐ…」 from the file tree: the file chosen (as the company names it), while its chooser is open.
  const [linkingFile, setLinkingFile] = useState<string | null>(null)
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

  // ← → over the files and record cards the editor area showed (design §7-4).
  const showFileAgain = useCallback((path: string) => {
    if (openFiles.includes(path)) handleSelectOpenFile(path)
    else { handleOpenFile(path); handlePinFile(path) }
  }, [openFiles, handleSelectOpenFile, handleOpenFile, handlePinFile])
  const places = usePlaceHistory({ companyId: currentCompany?.id, activeFilePath, showFile: showFileAgain })
  const { visitFile } = places
  const openFileFromTree = useCallback((path: string) => { visitFile(path); handleOpenFile(path) }, [visitFile, handleOpenFile])
  const selectOpenFile = useCallback((path: string) => { visitFile(path); handleSelectOpenFile(path) }, [visitFile, handleSelectOpenFile])

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
    refreshFileVersions()
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
  }

  const handleEditFile = (filePath: string) => {
    setLeftTab('files')
    openFileFromTree(filePath)
  }
  const handleFileSearchSelect = useCallback((filePath: string) => {
    setLeftTab('files')
    visitFile(filePath)
    handleOpenFile(filePath)
    handlePinFile(filePath)
  }, [visitFile, handleOpenFile, handlePinFile, setLeftTab])
  useCommandHandler('file.open', ({ path }) => handleFileSearchSelect(path))
  // A record's card (search, 「つながっているもの」) opens in the editor area of the files tab.
  useCommandHandler('record.open', ({ recordId }) => {
    setLeftTab('files')
    places.visitRecord(recordId)
  })
  // A file link in a consultation's own window opens here (that window has no editor).
  useFilesFromChatWindows()

  const approvalCard = (approvalId: string, at: string) => currentCompany
    ? <ApprovalCard key={approvalId} card={{ id: `card-${approvalId}`, companyId: currentCompany.id, conversationId: null, approvalId, origin: 'shown', at }} />
    : null
  // What the AI prepared for a task: the same mail and approval cards as in the consultation (the person sends / approves).
  const renderPrepared = (record: RecordViewSummary) => {
    if (!currentCompany) return null
    if (record.type === 'outbound_message') return <PreparedMailCard key={record.id} companyId={currentCompany.id} messageId={record.id} />
    if (record.type === 'approval') return approvalCard(record.id, record.updatedAt)
    return <RecordRow record={record} />
  }

  const tasksShown = !!taskList.data?.available && listShownFor(isCompanyWide ? null : selectedDeptId, taskList.data.listDepartmentIds)
  // A record's card: a task opens with its actions (its id starts with its type), anything else read only.
  const recordCard = (recordId: string) => {
    if (!currentCompany || !rootPath) return null
    if (recordId.startsWith('task-')) {
      return <TaskCard key={recordId} companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} renderPrepared={renderPrepared} renderSource={record => renderRecordSource(currentCompany.id, record)} onChanged={taskList.reload} />
    }
    const readOnly = <RecordCard key={recordId} companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} />
    // An approval request also gets its own card on top: approving or sending back is the person's press.
    if (recordId.startsWith('approval-')) {
      return <div key={recordId}><div className="px-5 pt-5">{approvalCard(recordId, '')}</div>{readOnly}</div>
    }
    return readOnly
  }
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
          onOpenFile={openFileFromTree}
          onPinFile={handlePinFile}
          onSelectOpenFile={selectOpenFile}
          onCloseFile={handleCloseFile}
          onPrivateFolderCreated={handlePrivateFolderCreated}
          onLinkToTask={tasksShown && rootPath ? path => setLinkingFile(companyPathOf(path, rootPath)) : undefined}
          navigation={<PlaceNavigation canBack={places.canBack} canForward={places.canForward} onBack={places.back} onForward={places.forward} />}
          overlay={places.recordId && currentCompany && rootPath
            ? recordCard(places.recordId)
            : undefined}
          aside={activeFilePath && rootPath
            ? <FileSidePanel companyId={currentCompany?.id} rootPath={rootPath} filePath={activeFilePath} />
            : undefined}
        />
      ),
    },
    {
      // Shown for the departments the company setting names (tasks-ui.md); records off → no tab.
      id: 'tasks', title: 'やること', icon: ListChecks, mount: 'once-opened', className: 'flex',
      visible: tasksShown,
      badgeCount: taskList.data?.items.filter(i => i.turn === 'mine' || i.turn === 'acceptance').length ?? null,
      render: () => currentCompany && rootPath ? (
        <TaskListPanel
          companyId={currentCompany.id}
          rootPath={rootPath}
          list={taskList}
          aiTurns={aiTurnItems}
          renderCard={recordCard}
          meetingActions={minutes.available ? {
            read: recordId => { const notice = minutes.notices.find(n => n.id === recordId); if (notice) startMinutesReading(notice) },
            skip: async recordId => { const r = await skipMinutes(currentCompany.id, recordId); return r && !r.success ? r.error : null },
          } : undefined}
        />
      ) : null,
    },
    {
      id: 'search', title: '検索', icon: MagnifyingGlass, mount: 'once-opened',
      onOpen: () => requestAnimationFrame(() => searchInputRef.current?.focus()),
      render: () => <SearchPanel rootPath={rootPath || ''} companyId={currentCompany?.id} departmentFolder={effectiveDeptFolder} inputRef={searchInputRef} />,
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
        extra={minutes.available && currentCompany ? <MinutesCheckButton companyId={currentCompany.id} /> : undefined}
        notices={currentCompany ? (
          <TitleBarNotices
            companyId={currentCompany.id}
            state={notices}
            onOpen={target => { void runCommand('record.open', { recordId: target.recordId }).catch(() => {}) }}
          />
        ) : undefined}
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
            aiTurnQueue={minutes.available ? minutes.notices : undefined}
            onAiTurnItems={setAiTurnItems}
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

      {linkingFile && currentCompany && (
        <LinkToTaskDialog
          key={linkingFile}
          companyPath={linkingFile}
          items={taskList.data?.items ?? []}
          onLink={async task => {
            const r = await linkFileToTask(currentCompany.id, task.id, linkingFile, task.version)
            taskList.reload()
            return r.success ? null : r.error
          }}
          onClose={() => setLinkingFile(null)}
        />
      )}
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
