import { Suspense, useState, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightning, FolderSimple, MagnifyingGlass, ChatCircle, CaretLeft, ListChecks } from '@phosphor-icons/react'
import { ChatPanel } from '../features/chat/components/ChatPanel'
import { useLinkedConsultations } from '../features/chat/recordConsultationsStore'
import { refreshFileVersions } from '../features/history/refresh'
import { RecordCard } from '../features/records/components/RecordCard'
import { usePlaceHistory } from '../features/editor/hooks/usePlaceHistory'
import { PlaceNavigation } from '../features/editor/components/PlaceNavigation'
import { FileSidePanel } from './FileSidePanel'
import { SearchPanel } from '../features/search/components/SearchPanel'
import type { PaletteRecent } from '../features/search/model'
import { useAppStore } from '../stores/appStore'
import { useSkills } from '../features/skills/hooks/useSkills'
import { useSparseCheckout } from '../shared/hooks/useSparseCheckout'
import { useDepartments } from '../shared/hooks/useDepartments'
import { useWriteAccess } from '../shared/hooks/useWriteAccess'
import { usePrivateFolderStore } from '../features/files/hooks/usePrivateFolders'
import { isChatInputRecentlyActive } from '../shared/lib/chatInputActivity'
import { recordIdOfTab, recordTabKey, tabDepartmentLabels, type RecordTabLook } from '../features/editor/editorTabs'
import { COMPANY_TAB_ID } from '../shared/lib/departments'
import { TitleBar } from './TitleBar'
import { FileTreePanel } from '../features/files/components/FileTreePanel'
import { TabbedEditorPanel } from '../features/editor/components/TabbedEditorPanel'
import { AppDialogs } from './AppDialogs'
import { LeftPanelTabs } from '../features/workspace/components/LeftPanelTabs'
import { resolveLeftPanel, type LeftPanel } from '../features/workspace/leftPanels'
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
import { declineMeetingBundle, skipMinutes } from '../features/minutes/api'
import { MeetingBundleBar } from '../features/minutes/components/MeetingBundleBar'
import { MinutesCheckButton } from '../features/minutes/components/MinutesCheckButton'
import type { AiTurnItemsView } from '../../shared/ai-turns'
import { useNotices } from '../features/notifications/hooks/useNotices'
import { TitleBarNotices, type MeetingTurnRow } from '../features/notifications/components/TitleBarNotices'
import { meetingTurns } from '../../shared/notifications-app'
import { useTaskList } from '../features/tasks/hooks/useTaskList'
import { useSeenTasks } from '../features/tasks/hooks/useSeenTasks'
import { usePluginStepTurns } from '../features/plugin-steps/hooks/usePluginStepTurns'
import { PersonStepButtons } from '../features/plugin-steps/components/PersonStepButtons'
import { TaskListPanel } from '../features/tasks/components/TaskListPanel'
import { renderRecordBundleField } from './recordBundleField'
import { renderRecordSource } from './recordSource'
import { aiTurnQueue } from '../../shared/ai-turn-steps/registry'
import { companyPathOf, listShownFor, tagCounts } from '../features/tasks/model'
import { LinkToTaskDialog } from '../features/tasks/components/LinkToTaskDialog'
import { linkFileToTask, linkMeetingBundle } from '../features/tasks/api'
import { BundleChooser } from '../features/tasks/components/BundleChooser'
import { TaskCard } from '../features/tasks/components/TaskCard'
import { PreparedMailCard } from '../features/chat/components/PreparedMailCard'
import { ApprovalCard } from '../features/chat/components/ApprovalCard'
import { RecordRow } from '../features/records/components/RecordRows'
import type { RecordViewSummary } from '../../shared/record-views'
import { usePluginScreens } from '../features/plugins/hooks/usePluginScreens'
import { LazyPluginFileActionDialog as PluginFileActionDialog } from '../features/plugins/components/LazyPluginSlots'
import { pluginSlots, type FileActionOpen } from './pluginSlots'

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
  // The やること tab's dot: something of あなたの番 came that the member has not seen in the tab.
  const seenTasks = useSeenTasks(currentCompany?.id)
  // What the chat's runner starts by itself: every waiting kind that has a step (ai-turn-steps/registry.ts).
  // A business plugin's steps that start as an AI turn (plugin-steps.md): the server lists the member's records at one.
  const pluginTurns = usePluginStepTurns(currentCompany?.id)
  const aiTurns = useMemo(
    () => aiTurnQueue({ minutes: minutes.available ? minutes.notices : [], tasks: taskList.data?.items ?? [], plugins: pluginTurns }),
    [minutes.available, minutes.notices, taskList.data, pluginTurns],
  )
  const { isReadOnly } = useWriteAccess()
  // 「どのまとまりの会議ですか？」 chosen from the title bar (where the department shows no task list) or a meeting's card.
  const [choosingBundle, setChoosingBundle] = useState<{ id: string; title: string } | null>(null)
  // Bumped when a まとまり is chosen, so an open meeting card asks the server again.
  const [bundleRev, setBundleRev] = useState(0)
  // 「やることにつなぐ…」 from the file tree: the file chosen (as the company names it), while its chooser is open.
  const [linkingFile, setLinkingFile] = useState<string | null>(null)
  const [fileAction, setFileAction] = useState<FileActionOpen | null>(null)
  const sparseCheckout = useSparseCheckout({ rootPath: rootPath || '' })

  // The department tab, saved per company; 全社 when the saved one is gone.
  const { selectedDeptId, selectDepartment } = useDepartmentSelection(currentCompany?.id, departments)
  const isCompanyWide = selectedDeptId === COMPANY_TAB_ID
  const selectedDept = useMemo(() => departments.find((d) => d.id === selectedDeptId), [departments, selectedDeptId])
  const effectiveDeptFolder = isCompanyWide ? '' : (selectedDept?.folder || '')
  // Which departments are not on this computer, and whether the selected one shows the download prompt.
  const { unsyncedFolders, isSelectedDeptUnsynced, markDownloaded } =
    useDepartmentAvailability(rootPath, departments, selectedDept, isCompanyWide, sparseCheckout)

  // Open tabs (files and records side by side), the active one and the left tab, saved per company.
  const { openFiles, setOpenFiles, activeFilePath, setActiveFilePath, leftTab, setLeftTab, recordLooks, setRecordLooks } =
    useEditorPersistence(currentCompany?.id, DEFAULT_LEFT_PANEL)
  // A record's card tells its title and kind once read: its tab shows them (and after a restart).
  const noteRecordLook = useCallback((id: string, look: RecordTabLook) => {
    setRecordLooks(prev => {
      const old = prev[id]
      if (old && old.title === look.title && old.state === look.state && old.typeLabel === look.typeLabel) return prev
      return { ...prev, [id]: look }
    })
  }, [setRecordLooks])
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

  // ← → over the files and records the middle showed (design §7-4): both are tabs.
  const showFileAgain = useCallback((path: string) => {
    if (openFiles.includes(path)) handleSelectOpenFile(path)
    else { handleOpenFile(path); handlePinFile(path) }
  }, [openFiles, handleSelectOpenFile, handleOpenFile, handlePinFile])
  const places = usePlaceHistory({ companyId: currentCompany?.id, activeFilePath, showFile: showFileAgain })
  const { visitFile } = places
  const activeRecordId = recordIdOfTab(activeFilePath)
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
  useCommandHandler('find.byName', () => setShowFileSearch(true))
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

  // The middle (open files and records) is beside the left tab, except while a wide tab (スキル…) covers it.
  const middleHidden = useRef(false)
  const showMiddle = useCallback(() => { if (middleHidden.current) setLeftTab('files') }, [setLeftTab])
  const handleEditFile = (filePath: string) => {
    setLeftTab('files')
    openFileFromTree(filePath)
  }
  // Opens a tab for good (not the preview tab the next single click replaces).
  const openTab = useCallback((key: string) => {
    showMiddle()
    visitFile(key)
    handleOpenFile(key)
    handlePinFile(key)
  }, [showMiddle, visitFile, handleOpenFile, handlePinFile])
  const handleFileSearchSelect = openTab
  // A file opened from 探す shows the line that was found (its editor tab only).
  const [gotoLine, setGotoLine] = useState<{ path: string; line: number } | null>(null)
  useCommandHandler('file.open', ({ path }) => openTab(path))
  // A record (search, 「つながっているもの」, a notice) opens in a tab in the middle, next to the files.
  useCommandHandler('record.open', ({ recordId }) => openTab(recordTabKey(recordId)))
  // A task list row opens its item as the preview tab, like a single click in the file tree.
  const openListItem = useCallback((item: { id: string; title: string; type: string; typeLabel: string; state: string | null; implements?: string[] }) => {
    noteRecordLook(item.id, { title: item.title, type: item.type, typeLabel: item.typeLabel, state: item.state, ...(item.implements ? { implements: item.implements } : {}) })
    const key = recordTabKey(item.id)
    visitFile(key)
    handleOpenFile(key)
  }, [noteRecordLook, visitFile, handleOpenFile])
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

  // 「部署に出す」 offers the departments the member can write to (the server checks again).
  const shareFolders = rootPath ? departments.filter(d => d.folder && !isReadOnly(`${rootPath}/${d.folder}`)).map(d => ({ folder: d.folder, name: d.name })) : []
  // 「相談する」 on a task: the chat opens the member's latest consultation about it, else starts one.
  const consultAbout = (task: { id: string; title: string }, fresh = false) => { void runCommand('chat.consultAbout', { recordId: task.id, title: task.title, ...(fresh ? { fresh } : {}) }).catch(() => {}) }
  // A record's 「つながっているもの」 lists the consultations about it (this PC's history).
  const recordConsultations = useLinkedConsultations(currentCompany?.id)
  // Business plugins' four slots (plugin-frame.md "The four slots"): only verified packages the company lists now.
  const pluginScreens = usePluginScreens(currentCompany?.id)
  const plugins = pluginSlots({ companyId: currentCompany?.id, rootPath, plugins: pluginScreens, taskItems: taskList.data?.items ?? [], onFileAction: setFileAction })
  const tasksShown = !!taskList.data?.available && listShownFor(isCompanyWide ? null : selectedDeptId, taskList.data.listDepartmentIds)
  // What the department on screen makes as its 案件・プロジェクト (全社: the company's own kind; records.md "Bundle kinds").
  const bundleKinds = taskList.data?.bundleKinds
  const deptBundleKind = bundleKinds ? (bundleKinds.departments.find(d => d.folder === effectiveDeptFolder)?.kind ?? bundleKinds.core) : null
  // A record's card: a task opens with its actions (its id starts with its type), anything else read only.
  const recordCard = (recordId: string) => {
    if (!currentCompany || !rootPath) return null
    if (recordId.startsWith('task-')) {
      return <TaskCard key={`${recordId}@${taskList.data?.items.find(i => i.id === recordId)?.version ?? 0}`} onLoaded={look => noteRecordLook(recordId, look)} companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} renderPrepared={renderPrepared} renderSource={record => renderRecordSource(currentCompany.id, record)} renderSections={plugins.renderSections} shareFolders={shareFolders} onConsult={consultAbout} tagsInUse={tagCounts(taskList.data?.items ?? []).map(t => t.tag)} onChanged={taskList.reload} />
    }
    // A meeting without a まとまり: 「どのまとまりの会議ですか？」 on its card, also after it left あなたの番.
    const meetingBar = recordId.startsWith('meeting-') || recordId.startsWith('minutes-')
      ? <MeetingBundleBar key={`${recordId}:${bundleRev}`} companyId={currentCompany.id} meetingId={recordId} onChoose={setChoosingBundle} onChanged={taskList.reload} />
      : null
    // A business plugin's `start: person` steps at the record's state (plugin-steps.md) sit above its card.
    const readOnly = <div key={recordId}>{meetingBar}<PersonStepButtons companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} /><RecordCard companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} renderSections={plugins.renderSections} renderSource={record => renderRecordSource(currentCompany.id, record)} renderApproval={id => approvalCard(id, '')} consultations={recordConsultations.get(recordId)} onConsult={consultAbout}
      renderBundleField={ctx => renderRecordBundleField(currentCompany.id, ctx, deptBundleKind, effectiveDeptFolder || null)} onLoaded={r => noteRecordLook(recordId, { title: r.title, type: r.type, typeLabel: r.typeLabel, ...(r.kind === 'bundle' ? { implements: ['bundle'] } : {}) })} /></div>
    // An approval request also gets its own card on top: approving or sending back is the person's press.
    if (recordId.startsWith('approval-')) {
      return <div key={recordId}><div className="px-5 pt-5">{approvalCard(recordId, '')}</div>{readOnly}</div>
    }
    return readOnly
  }
  // A department without the task list: its meetings (received minutes, a まとまり to choose) wait in the title bar.
  const titleBarMeetings: MeetingTurnRow[] = tasksShown || !currentCompany ? [] : meetingTurns(taskList.data?.items ?? [], aiTurnItems?.items ?? []).map(m => {
    const actions: MeetingTurnRow['actions'] = []
    if (m.kind === 'bundle') {
      const s = m.suggestedBundle
      if (s) actions.push({ label: 'はい', run: () => void linkMeetingBundle(currentCompany.id, m.id, s.id).then(() => taskList.reload()) })
      actions.push({ label: s ? 'ちがう／選ぶ' : 'まとまりを選ぶ', run: () => setChoosingBundle({ id: m.id, title: m.title }) })
      actions.push({ label: 'まとまりはない', run: () => void declineMeetingBundle(currentCompany.id, m.id).then(() => taskList.reload()) })
    }
    if (m.kind === 'minutes' && m.ai?.state !== 'running' && minutes.available && taskList.data?.items.find(i => i.id === m.id)?.state === 'received') {
      actions.push({ label: '自分で読み取る', run: () => { const notice = minutes.notices.find(n => n.id === m.id); if (notice) startMinutesReading(notice) } })
      actions.push({ label: '今は読まない', run: () => void skipMinutes(currentCompany.id, m.id).then(() => taskList.reload()) })
    }
    if (m.ai?.canRetry) actions.push({ label: 'もう一度', run: () => aiTurnItems?.retry(m.id) })
    if (m.ai?.canHand) actions.push({ label: '人に渡す', run: () => aiTurnItems?.handOver(m.id) })
    return { ...m, actions }
  })
  // 探す ⌘K's 「最近開いたもの」: the tabs open in the middle, newest first.
  const recentTabs: PaletteRecent[] = [...openFiles].reverse().flatMap((key): PaletteRecent[] => {
    const id = recordIdOfTab(key)
    if (id) return recordLooks[id] ? [{ key, recordId: id, record: recordLooks[id] }] : []
    const path = rootPath ? companyPathOf(key, rootPath) : null
    return path ? [{ key, path }] : []
  })
  const myTurnIds = (taskList.data?.items ?? []).filter(i => i.turn === 'mine' || i.turn === 'acceptance').map(i => i.id)
  // Opening the やること tab, or leaving it, means the member has seen what is in it.
  const selectLeftTab = (id: string) => {
    if (id === 'tasks' || leftTab === 'tasks') seenTasks.markSeen(myTurnIds)
    setLeftTab(id)
  }
  // The left panel's tabs, registered like an extension's tab will be (features/workspace/leftPanels.ts).
  const leftPanels: LeftPanel[] = [
    {
      id: 'skills', title: t('tabs.skills'), icon: Lightning, mount: 'once-opened', className: 'flex', wide: true,
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
        <FileTreePanel
          rootPath={rootPath || ''}
          departmentFolder={effectiveDeptFolder}
          selectedFilePath={activeFilePath}
          onSelectFile={openFileFromTree}
          onDoubleClickFile={handlePinFile}
          onPrivateFolderCreated={handlePrivateFolderCreated}
          onLinkToTask={tasksShown && rootPath ? path => setLinkingFile(companyPathOf(path, rootPath)) : undefined}
          extraMenuItems={plugins.fileMenuItems}
        />
      ),
    },
    {
      // Shown for the departments the company setting names (tasks-ui.md); records off → no tab.
      id: 'tasks', title: 'やること', icon: ListChecks, mount: 'once-opened', className: 'flex',
      visible: tasksShown,
      // No count here: the count of あなたの番 is the title bar's alone (owner 2026-11-02); a dot for what is new.
      dot: leftTab !== 'tasks' && myTurnIds.some(id => !seenTasks.seen.has(id)),
      render: () => currentCompany && rootPath ? (
        <TaskListPanel
          companyId={currentCompany.id}
          rootPath={rootPath}
          list={taskList}
          aiTurns={aiTurnItems}
          activeRecordId={activeRecordId}
          onOpen={id => { const item = taskList.data?.items.find(i => i.id === id); if (item) openListItem(item); else openTab(recordTabKey(id)) }}
          onConsult={consultAbout}
          askFolder={isCompanyWide ? null : (selectedDept?.folder ?? null)}
          meetingActions={minutes.available ? {
            read: recordId => { const notice = minutes.notices.find(n => n.id === recordId); if (notice) startMinutesReading(notice) },
            skip: async recordId => { const r = await skipMinutes(currentCompany.id, recordId); return r && !r.success ? r.error : null },
          } : undefined}
        />
      ) : null,
    },
    {
      // 探す (never 「検索」): the narrow column; what is found opens in a tab in the middle.
      id: 'search', title: '探す', icon: MagnifyingGlass, mount: 'once-opened',
      onOpen: () => requestAnimationFrame(() => searchInputRef.current?.focus()),
      render: () => <SearchPanel rootPath={rootPath || ''} companyId={currentCompany?.id} departmentFolder={effectiveDeptFolder} inputRef={searchInputRef}
        onOpenFile={(path, line) => { setGotoLine({ path, line }); openTab(path) }} />,
    },
    // A business plugin's screen takes the whole left side, like スキル.
    ...plugins.tabs.map(tab => ({ ...tab, wide: true })),
  ]
  const shownLeft = leftPanels.find(p => p.id === resolveLeftPanel(leftTab, leftPanels))
  middleHidden.current = !!shownLeft?.wide

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
            meetings={titleBarMeetings}
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
            aiTurnQueue={aiTurns}
            onAiTurnItems={setAiTurnItems}
            focus={activeRecordId ? { recordId: activeRecordId, title: recordLooks[activeRecordId]?.title ?? '' } : null}
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
            {/* The left tab beside the middle (open files and records, plan A); a wide tab covers the middle, which stays mounted. */}
            <SplitView
              split={layout.files} limits={PANE_LIMITS} className="h-full min-w-0"
              collapsed={shownLeft?.wide ? 'editor' : null}
              paneClassName={paneClassName} dividerLabel={dividerLabel} onResizeStart={startResize} onResize={resize}
              renderPane={id => id === 'fileTree' ? (
                <div className="h-full flex flex-col min-w-0"><LeftPanelTabs panels={leftPanels} selectedId={leftTab} onSelect={selectLeftTab} /></div>
              ) : (
                <TabbedEditorPanel
                  openFiles={openFiles}
                  activeFilePath={activeFilePath}
                  previewFilePath={previewFilePath}
                  tabLabels={tabLabels}
                  recordLooks={recordLooks}
                  onSelectFile={selectOpenFile}
                  onCloseFile={handleCloseFile}
                  onPinFile={handlePinFile}
                  navigation={<PlaceNavigation canBack={places.canBack} canForward={places.canForward} onBack={places.back} onForward={places.forward} />}
                  renderRecord={recordCard}
                  gotoLine={gotoLine?.path === activeFilePath ? gotoLine.line : null}
                  aside={activeFilePath && !activeRecordId && rootPath
                    ? <FileSidePanel companyId={currentCompany?.id} rootPath={rootPath} filePath={activeFilePath} />
                    : undefined}
                />
              )}
            />
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

      {choosingBundle && currentCompany && (
        <BundleChooser
          companyId={currentCompany.id} meetingTitle={choosingBundle.title}
          onChoose={async b => {
            const r = await linkMeetingBundle(currentCompany.id, choosingBundle.id, b.id)
            taskList.reload()
            setBundleRev(n => n + 1)
            return r?.success ? null : (r?.error ?? 'できませんでした。')
          }}
          onNoBundle={async () => {
            const r = await declineMeetingBundle(currentCompany.id, choosingBundle.id)
            taskList.reload()
            setBundleRev(n => n + 1)
            return r.success ? null : r.error
          }}
          onClose={() => setChoosingBundle(null)}
        />
      )}
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
      {/* Hidden as soon as its plugin is no longer listed (turned off, stopped). */}
      {fileAction && currentCompany && pluginScreens.screens.some(s => s.plugin.id === fileAction.action.plugin.id && s.plugin.version === fileAction.action.plugin.version) && (
        <Suspense fallback={null}>
          <PluginFileActionDialog
            companyId={currentCompany.id}
            action={fileAction.action}
            companyPath={fileAction.companyPath}
            isFolder={fileAction.isFolder}
            onOpen={target => { setFileAction(null); return plugins.openFromPlugin(target) }}
            onClose={() => setFileAction(null)}
          />
        </Suspense>
      )}
      <AppDialogs
        companyId={currentCompany?.id}
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
        recentTabs={recentTabs}
        onOpenRecord={id => openTab(recordTabKey(id))}
        showSettings={showSettings}
        settingsFocus={settingsFocus}
        onCloseSettings={() => { setShowSettings(false); setSettingsFocus(null); sparseCheckout.refresh() }}
        showBackupHistory={showBackupHistory}
        setShowBackupHistory={setShowBackupHistory}
      />
    </div>
  )
}
