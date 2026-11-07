import { Suspense, useState, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightning, FolderSimple, MagnifyingGlass, ChatCircle, CaretLeft, ListChecks, HandPointing } from '@phosphor-icons/react'
import { ChatPanel } from '../features/chat/components/ChatPanel'
import { useLinkedConsultations } from '../features/chat/recordConsultationsStore'
import { useConsultationTopics } from '../features/chat/consultationTopicsStore'
import { getChatSessionSummaries, patchChatSession } from '../features/chat/api'
import { paletteConsultations } from '../features/chat/conversationRows'
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
import { FileTreePanel, type FileTreeControls } from '../features/files/components/FileTreePanel'
import { createEmptyFile } from '../features/files/api'
import { useTodayFolder } from '../features/workspace/hooks/useTodayFolder'
import { TodayFolderSetting } from '../features/settings/components/TodayFolderSetting'
import { fileNameProblem, NAME_TAKEN_MESSAGE } from '../../shared/file-names'
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
import { useEditorPersistence, type RestoredTabs } from '../features/editor/hooks/useEditorPersistence'
import { useEditorTabs } from '../features/editor/hooks/useEditorTabs'
import { useTabTidying } from '../features/editor/hooks/useTabTidying'
import { useTabArrangement } from '../features/editor/hooks/useTabArrangement'
import { TabTidyingMenu, TabTidyingNotice } from '../features/editor/components/TabTidyingControls'
import { useAiCommandRequests } from './useAiCommandRequests'
import { useCompanyWatcher } from '../features/files/hooks/useCompanyWatcher'
import { useSkillsTab } from '../features/skills/hooks/useSkillsTab'
import { useSkillsAutoRefresh } from '../features/skills/hooks/useSkillsAutoRefresh'
import { skillCommands } from '../features/skills/model'
import { useDepartmentDownload } from '../features/sync/hooks/useDepartmentDownload'
import { useSync } from '../features/sync/hooks/useSync'
import { useAutoSync } from '../features/sync/hooks/useAutoSync'
import { forgetNotices } from '../features/sync/lastingNotice'
import { DepartmentDownloadPrompt } from '../features/sync/components/DepartmentDownloadPrompt'
import { runCommand, useCommandHandler, useKeybindings } from '../shared/commands/commands'
import { useFilesFromChatWindows } from '../features/chat/hooks/useFilesFromChatWindows'
import { useSaveBeforeLeaving } from '../features/editor/hooks/useSaveBeforeLeaving'
import { LeaveConfirmDialog } from '../features/editor/components/LeaveConfirmDialog'
import { useAuthStore } from '../stores/authStore'
import { useMinutesNotices } from '../features/minutes/hooks/useMinutesNotices'
import { startMinutesReading } from '../features/minutes/startReading'
import { declineMeetingBundle, requestMeetingReading, skipMinutes } from '../features/minutes/api'
import { MinutesCheckButton } from '../features/minutes/components/MinutesCheckButton'
import { MeetingBanners } from '../features/minutes/components/MeetingBanners'
import { useMeetingArrivals } from '../features/minutes/hooks/useMeetingArrivals'
import { renderMeetingPanel } from './meetingCard'
import type { AiTurnItemsView } from '../../shared/ai-turns'
import { useNotices, useOpenTasksRequest } from '../features/notifications/hooks/useNotices'
import { TitleBarNotices, type MeetingTurnRow } from '../features/notifications/components/TitleBarNotices'
import { arrivedMeetingTurns, meetingTurns } from '../../shared/notifications-app'
import { useTaskList } from '../features/tasks/hooks/useTaskList'
import { useSeenTasks } from '../features/tasks/hooks/useSeenTasks'
import { usePluginStepTurns } from '../features/plugin-steps/hooks/usePluginStepTurns'
import { ContinueStepButton } from '../features/plugin-steps/components/ContinueStepButton'
import { PersonStepButtons } from '../features/plugin-steps/components/PersonStepButtons'
import { StepDeliverables } from '../features/plugin-steps/components/StepDeliverables'
import { TaskListPanel } from '../features/tasks/components/TaskListPanel'
import { CorePressPanel } from '../features/tasks/components/CorePressPanel'
import { featuresFrom } from '../../../shared/core/features'
import { renderRecordBundleField } from './recordBundleField'
import { renderRecordSource } from './recordSource'
import { aiTurnQueue } from '../../shared/ai-turn-steps/registry'
import { bundlePlacesOf, companyPathOf, departmentBundleKind, listShownFor, tagCounts } from '../features/tasks/model'
import { meetingBundleWords } from '../../shared/tasks'
import { LinkToTaskDialog } from '../features/tasks/components/LinkToTaskDialog'
import { linkFileToTask, linkMeetingBundle } from '../features/tasks/api'
import { BundleChooser } from '../features/tasks/components/BundleChooser'
import { TaskCard } from '../features/tasks/components/TaskCard'
import { PreparedMailCard } from '../features/chat/components/PreparedMailCard'
import { ApprovalCard } from '../features/chat/components/ApprovalCard'
import { FileLinkRow, RecordRow } from '../features/records/components/RecordRows'
import type { RecordViewSummary } from '../../shared/record-views'
import { usePluginScreens } from '../features/plugins/hooks/usePluginScreens'
import { LazyPluginFileActionDialog as PluginFileActionDialog } from '../features/plugins/components/LazyPluginSlots'
import { pluginSlots, type FileActionOpen } from './pluginSlots'
import { companyHasSharedFolder } from '../../shared/company-folder'
import { closeStopsTheAI } from '../../shared/chat-windows'
import { someConsultationStatus } from '../features/chat/consultationStatusStore'
import { useCompanySwitch } from '../features/company/hooks/useCompanySwitch'
import { CompanySwitcher } from '../features/company/components/CompanySwitcher'

// The main screen: composes the features (state lives in their hooks) and lays them out.

// Classes of each pane of the split tree besides its size (SplitView adds that).
const PANE_CLASSES: Record<string, string> = {
  side: 'relative flex flex-col border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900',
  fileTree: 'overflow-hidden',
  // Nothing of the consultation is drawn outside its pane (over the middle's tabs).
  chat: 'min-w-0 overflow-hidden',
}
const paneClassName = (paneId: string) => PANE_CLASSES[paneId] ?? ''
const dividerLabel = (splitId: string) => splitId === 'files' ? 'ファイルツリーとエディタの境目' : '左の欄とチャットの境目'

// The first registered panel opens when nothing (or an id no panel has) is remembered.
const DEFAULT_LEFT_PANEL = 'skills'

export function AppShell() {
  const { t } = useTranslation()
  const currentCompany = useAppStore((s) => s.currentCompany)
  const rootPath = currentCompany?.rootPath
  // A company without the shared folder (client/shared/company-folder.ts): rootPath is a plain
  // working folder on this PC. Sync, download choices, private folders, history and backups
  // get no folder (their hooks stay idle) and their buttons are hidden.
  const sharedFolder = companyHasSharedFolder(currentCompany)
  const syncedRoot = sharedFolder ? rootPath : undefined

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
  // 「議事録が届きました」 (meetings for their attendees): the banner on やること; what the member asked to be read runs even with 自動で進める off.
  const meetings = useMeetingArrivals(currentCompany?.id)
  const askedMeetings = useMemo(() => new Set(meetings.arrivals.items.filter(m => m.byYou && m.status === 'asked').map(m => m.recordId)), [meetings.arrivals])
  const aiTurns = useMemo(
    () => aiTurnQueue({ minutes: minutes.available ? minutes.notices : [], tasks: taskList.data?.items ?? [], plugins: pluginTurns, asked: askedMeetings }),
    [minutes.available, minutes.notices, taskList.data, pluginTurns, askedMeetings],
  )
  const { isReadOnly } = useWriteAccess()
  // 「どのまとまりの会議ですか？」 chosen from the title bar (where the department shows no task list) or the list.
  const [choosingBundle, setChoosingBundle] = useState<{ id: string; title: string } | null>(null)
  // Bumped when a まとまり is chosen there, so an open meeting card reads again.
  const [bundleRev, setBundleRev] = useState(0)
  // 「やることにつなぐ…」 from the file tree: the file chosen (as the company names it), while its chooser is open.
  const [linkingFile, setLinkingFile] = useState<string | null>(null)
  const [fileAction, setFileAction] = useState<FileActionOpen | null>(null)
  const sparseCheckout = useSparseCheckout({ rootPath: syncedRoot || '' })

  // The department tab, saved per company; 全社 when the saved one is gone.
  const { selectedDeptId, selectDepartment } = useDepartmentSelection(currentCompany?.id, departments)
  const isCompanyWide = selectedDeptId === COMPANY_TAB_ID
  const selectedDept = useMemo(() => departments.find((d) => d.id === selectedDeptId), [departments, selectedDeptId])
  const effectiveDeptFolder = isCompanyWide ? '' : (selectedDept?.folder || '')
  // Which departments are not on this computer, and whether the selected one shows the download prompt.
  const { unsyncedFolders, isSelectedDeptUnsynced, markDownloaded } =
    useDepartmentAvailability(syncedRoot, departments, selectedDept, isCompanyWide, sparseCheckout)

  // Open tabs (files and records side by side), the active one and the left tab, saved per company.
  // Set while a wide left tab (スキル…) covers the middle. The daily tidy hears when a company's tabs are restored (set below).
  const middleHidden = useRef(false)
  const tabsRestored = useRef<(companyId: string, tabs: RestoredTabs) => void>(() => {})
  const onTabsRestored = useCallback((companyId: string, tabs: RestoredTabs) => tabsRestored.current(companyId, tabs), [])
  const { openFiles, setOpenFiles, activeFilePath, setActiveFilePath, leftTab, setLeftTab, recordLooks, setRecordLooks, pinnedTabs, setPinnedTabs } =
    useEditorPersistence(currentCompany?.id, DEFAULT_LEFT_PANEL, onTabsRestored)
  // A record's card tells its title and kind once read: its tab shows them (and after a restart).
  const noteRecordLook = useCallback((id: string, look: RecordTabLook) => {
    setRecordLooks(prev => {
      const old = prev[id]
      if (old && old.title === look.title && old.state === look.state && old.typeLabel === look.typeLabel) return prev
      return { ...prev, [id]: look }
    })
  }, [setRecordLooks])
  const { previewFilePath, openFile: handleOpenFile, pinFile: handlePinFile, selectFile: handleSelectOpenFile, closeFile: handleCloseFile, closeTabs, openTabs: reopenTabs } =
    useEditorTabs({ openFiles, setOpenFiles, activeFilePath, setActiveFilePath })
  // 「タブを片づける」 (tabs.tidy / list / restore, also the AI's) and the daily tidy; 固定 tabs stay.
  const tidying = useTabTidying({ companyId: currentCompany?.id, rootPath, openTabs: openFiles, pinnedTabs, setPinnedTabs, recordLooks, closeTabs,
    reopenTabs: keys => { reopenTabs(keys); if (middleHidden.current && keys.length > 0) setLeftTab('files') } })
  tabsRestored.current = tidying.onTabsRestored
  // Their order by drag, named groups and 「種類ごとにまとめる」 (per company on this Mac).
  const arrangement = useTabArrangement({ companyId: currentCompany?.id, openTabs: openFiles, setOpenTabs: setOpenFiles, pinned: tidying.pinned, recordLooks })
  useAiCommandRequests() // the consultation AI's app commands (the tabs above) run in this window
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
    if (currentCompany?.id && sharedFolder) void usePrivateFolderStore.getState().load(currentCompany.id)
    await refreshDepartments()
    void refreshSkills()
    if (!isCompanyWide) void refreshCompanySkills()
    refreshFileVersions()
  }, [currentCompany?.id, sharedFolder, refreshDepartments, refreshSkills, refreshCompanySkills, isCompanyWide])
  const signedInUserId = useAuthStore(s => s.user?.id)
  const sync = useSync({ rootPath: syncedRoot, companyId: currentCompany?.id, userId: signedInUserId, onSynced: handleSynced })

  // Signing out closes this screen: every open tab is saved first (useSaveBeforeLeaving).
  const leaving = useSaveBeforeLeaving()
  const signOut = useAuthStore(s => s.signOut)
  const handleLogout = useCallback(async () => {
    if (!await leaving.confirmLeave()) return
    try {
      await signOut()
      if (signedInUserId) forgetNotices(signedInUserId)
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }, [leaving, signOut, signedInUserId])
  const { handleSync } = sync

  // The title bar's company switch: waits for a running sync, asks before stopping an AI at work, saves every tab.
  const companySwitch = useCompanySwitch({
    currentId: currentCompany?.id,
    userId: signedInUserId,
    isSyncing: sync.isSyncing,
    aiWorking: () => someConsultationStatus(closeStopsTheAI),
    saveTabs: leaving.confirmLeave,
  })

  // 「自動で受け取る」 / 「自動で送る」 while the app is open (Settings → 自動同期).
  const autoSync = useAutoSync({
    rootPath: syncedRoot,
    companyId: currentCompany?.id,
    isSyncing: sync.isSyncing,
    setIsSyncing: sync.setIsSyncing,
    showNotice: sync.setSyncNotification,
    keepNoticeFor: sync.keepNoticeFor,
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

  // 今日のフォルダ (client/shared/today-folder.ts): which department holds it, opening it, a task's new file in it.
  const { enabled: sparseEnabled, isCheckedOut } = sparseCheckout
  const isDownloaded = useCallback((folder: string) => !sparseEnabled || isCheckedOut(folder), [sparseEnabled, isCheckedOut])
  const today = useTodayFolder(currentCompany?.id, rootPath, departments, isDownloaded)
  const treeControls = useRef<FileTreeControls>(null)
  const openToday = async () => {
    const made = await today.ensure()
    if ('error' in made) { sync.setSyncNotification({ type: 'error', message: made.error }); return }
    if (selectedDeptId !== made.department.id) handleSelectDept(made.department.id)
    setLeftTab('files')
    // The tree shows the department after the next render.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
    await treeControls.current?.reveal(`${rootPath}/${made.folder}`)
  }
  const createTodayFile = async (name: string): Promise<{ path: string } | { error: string }> => {
    const problem = fileNameProblem(name)
    if (problem) return { error: problem }
    const made = await today.ensure()
    if ('error' in made) return made
    const r = await createEmptyFile(`${rootPath}/${made.folder}/${name}`)
    if (!r.success) return { error: r.code === 'name_taken' ? r.error || NAME_TAKEN_MESSAGE : 'ファイルを作れませんでした。もう一度試してください。' }
    return { path: `${made.folder}/${name}` }
  }
  useCommandHandler('files.openToday', () => { void openToday() })
  // A folder linked to a record opens in the file tree, under its department (records.md "Folder links").
  useCommandHandler('folder.reveal', async ({ path }) => {
    const inside = rootPath ? companyPathOf(path, rootPath) : null
    if (!inside) return
    const top = inside.split('/')[0]
    const dept = departments.find(d => d.folder === top)
    if (dept && selectedDeptId !== dept.id) handleSelectDept(dept.id)
    setLeftTab('files')
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
    await treeControls.current?.reveal(path)
  })

  // The middle (open files and records) is beside the left tab, except while a wide tab (スキル…) covers it.
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
  // ［催促の下書きを作る］ on a task whose 返事の見込み passed: a new consultation that drafts the nudge (the member sends it).
  const draftNudge = (task: { id: string; title: string }) => { void runCommand('chat.consultAbout', { recordId: task.id, title: task.title, purpose: 'nudge' }).catch(() => {}) }
  // A record's 「つながっているもの」 lists the consultations about it (this PC's history).
  const recordConsultations = useLinkedConsultations(currentCompany?.id)
  // 探す finds a consultation through the やること / 案件 it is about (the answers 「AIへの相談」 reads too).
  const topicIds = useMemo(() => [...recordConsultations.keys()], [recordConsultations])
  const consultationTopics = useConsultationTopics(currentCompany?.id ?? '', topicIds)
  // Business plugins' four slots (plugin-frame.md "The four slots"): only verified packages the company lists now.
  const pluginScreens = usePluginScreens(currentCompany?.id)
  const plugins = pluginSlots({ companyId: currentCompany?.id, rootPath, plugins: pluginScreens, taskItems: taskList.data?.items ?? [], onFileAction: setFileAction })
  // 「使う機能」 (records.md "Features on and off"): an older server or main without them = everything on.
  const features = featuresFrom(taskList.data?.features)
  const tasksShown = !!taskList.data?.available && features.taskList && listShownFor(isCompanyWide ? null : selectedDeptId, taskList.data.listDepartmentIds)
  // The task list turned off for the company: 「ACB で押すもの」, the small list of what only ACB can act on.
  const pressShown = !!taskList.data?.available && !features.taskList
  // 「議事録が届きました」 only while 会議と議事録 is on (the server answers none while it is off, too).
  const arrivalsShown = meetings.arrivals.available && features.meetings
  // What the department on screen makes as its 案件・プロジェクト (全社: the company's own kind; records.md "Bundle kinds").
  const bundleKinds = taskList.data?.bundleKinds
  const deptBundleKind = departmentBundleKind(bundleKinds, effectiveDeptFolder)
  // 「新しい〇〇にする」 puts it in the member's own department (所属) by default (records.md "A task and its 案件・プロジェクト").
  const bundlePlaces = bundlePlacesOf(departments, bundleKinds, today.myDepartmentIds, effectiveDeptFolder || null)
  const bundleWord = deptBundleKind?.name ?? 'プロジェクト'
  const meetingWords = meetingBundleWords(bundleWord)
  // A linked folder left out on this computer is marked on the cards (download-choices.md).
  const notDownloadedFolderOf = sparseCheckout.enabled ? sparseCheckout.notDownloadedFolderOf : undefined
  // A record's card: a task opens with its actions (its id starts with its type), anything else read only.
  const recordCard = (recordId: string) => {
    if (!currentCompany || !rootPath) return null
    if (recordId.startsWith('task-')) {
      // Keyed by id only: a new version (the AI linked a file, a press in the list) updates it in place.
      // 「続きをする」 sits above a やること an automatic step run handed over (plugin-steps.md).
      return <div key={recordId}><ContinueStepButton companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} /><TaskCard knownVersion={taskList.data?.items.find(i => i.id === recordId)?.version} onLoaded={look => noteRecordLook(recordId, look)} companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} renderPrepared={renderPrepared} renderSource={record => renderRecordSource(currentCompany.id, record)} renderSections={plugins.renderSections} shareFolders={shareFolders} onConsult={consultAbout} onNudge={draftNudge} consultations={recordConsultations.get(recordId)} tagsInUse={tagCounts(taskList.data?.items ?? []).map(t => t.tag)} onChanged={taskList.reload} bundleKind={deptBundleKind} bundleFolder={effectiveDeptFolder || null} bundlePlaces={bundlePlaces} createTodayFile={createTodayFile} notDownloadedFolderOf={notDownloadedFolderOf} sharedFolder={sharedFolder}
        onDetachConsultation={sessionId => { void patchChatSession(currentCompany.id, sessionId, { topicRecordId: null }).catch(() => {}) }} /></div>
    }
    // A まとまり chosen from the list or the title bar: a meeting's open card reads again.
    const isMeeting = recordId.startsWith('meeting-') || recordId.startsWith('minutes-')
    // A business plugin's `start: person` steps at the record's state (plugin-steps.md) sit above its card.
    const readOnly = <div key={isMeeting ? `${recordId}:${bundleRev}` : recordId}><PersonStepButtons companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} /><ContinueStepButton companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} /><StepDeliverables companyId={currentCompany.id} recordId={recordId} renderPrepared={renderPrepared} renderFile={f => <FileLinkRow rootPath={rootPath} path={f.path} broken={f.broken} />} /><RecordCard companyId={currentCompany.id} rootPath={rootPath} recordId={recordId} renderSections={plugins.renderSections} renderSource={record => renderRecordSource(currentCompany.id, record)} renderApproval={id => approvalCard(id, '')} consultations={recordConsultations.get(recordId)} onConsult={consultAbout} notDownloadedFolderOf={notDownloadedFolderOf}
      renderBundleField={ctx => renderRecordBundleField(currentCompany.id, ctx, deptBundleKind, effectiveDeptFolder || null, taskList.reload, bundlePlaces)}
      renderMeeting={(r, parts) => renderMeetingPanel(currentCompany.id, r.id, { parts, members: (taskList.data?.members ?? []).filter(p => p.id !== taskList.data?.me), onConsult: m => consultAbout(m), onChanged: () => { meetings.reload(); taskList.reload() } })} onLoaded={r => noteRecordLook(recordId, { title: r.title, type: r.type, typeLabel: r.typeLabel, ...(r.kind === 'bundle' ? { implements: ['bundle'] } : {}) })} /></div>
    // An approval request also gets its own card on top: approving or sending back is the person's press.
    if (recordId.startsWith('approval-')) {
      return <div key={recordId}><div className="px-5 pt-5">{approvalCard(recordId, '')}</div>{readOnly}</div>
    }
    return readOnly
  }
  // A department without the task list: its meetings (received minutes, a まとまり to choose) wait in the title bar.
  const listMeetings = tasksShown || !currentCompany ? [] : meetingTurns(taskList.data?.items ?? [], aiTurnItems?.items ?? [], bundleWord)
  // Minutes that arrived and nobody asked the AI to read count too, with ［AI に読ませる］ (owner decision 2026-11-07).
  const arrivedMeetings = tasksShown || !currentCompany || !arrivalsShown ? [] : arrivedMeetingTurns(meetings.arrivals.items, new Set(listMeetings.map(m => m.id)))
  const titleBarMeetings: MeetingTurnRow[] = !currentCompany ? [] : [...arrivedMeetings, ...listMeetings].map(m => {
    const actions: MeetingTurnRow['actions'] = []
    if (m.kind === 'bundle') {
      const s = m.suggestedBundle
      if (s) actions.push({ label: 'はい', run: () => void linkMeetingBundle(currentCompany.id, m.id, s.id).then(() => taskList.reload()) })
      actions.push({ label: s ? 'ちがう／選ぶ' : meetingWords.choose, run: () => setChoosingBundle({ id: m.id, title: m.title }) })
      actions.push({ label: meetingWords.none, run: () => void declineMeetingBundle(currentCompany.id, m.id).then(() => taskList.reload()) })
    }
    if (arrivedMeetings.some(a => a.id === m.id)) {
      const arrival = meetings.arrivals.items.find(a => a.recordId === m.id)
      if (arrival) actions.push({ label: 'AI に読ませる', run: () => void requestMeetingReading(currentCompany.id, arrival.recordId, arrival.version).then(() => { meetings.reload(); taskList.reload() }) })
      return { ...m, actions }
    }
    if (m.kind === 'minutes' && m.ai?.state !== 'running' && minutes.available && taskList.data?.items.find(i => i.id === m.id)?.state === 'received') {
      actions.push({ label: '自分で読み取る', run: () => { const notice = minutes.notices.find(n => n.id === m.id); if (notice) startMinutesReading(notice, features) } })
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
  // 探す ⌘K's skills: the ones the スキル tab shows, then the company-wide ones (both already loaded).
  const paletteSkills = useMemo(() => [...skills, ...(isCompanyWide ? [] : companySkills)]
    .map(s => ({ id: s.id, name: s.name, command: s.skillPath?.split('/').pop() ?? '', group: s.group })), [skills, companySkills, isCompanyWide])
  const companyId = currentCompany?.id
  const loadPaletteConsultations = useMemo(() => companyId ? () => getChatSessionSummaries(companyId).then(paletteConsultations) : undefined, [companyId])
  // 探す's consultations: this PC's history with the record each was started from (shown ones only).
  const loadFindConsultations = useMemo(() => companyId ? () => getChatSessionSummaries(companyId).then(all => {
    const listed = new Set(paletteConsultations(all).map(c => c.id))
    return all.filter(s => listed.has(s.id)).map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, ...(s.topicRecordId ? { topicRecordId: s.topicRecordId } : {}) }))
  }) : undefined, [companyId])
  const openConsultation = (sessionId: string) => {
    if (collapsedPane === 'chat') toggleChat()
    void runCommand('chat.openConsultation', { sessionId }).catch(() => {})
  }
  const departmentNames = useMemo(() => Object.fromEntries(departments.map(d => [d.folder, d.name])), [departments])
  const myTurnIds = (taskList.data?.items ?? []).filter(i => i.turn === 'mine' || i.turn === 'acceptance').map(i => i.id)
  // Opening the やること tab, or leaving it, means the member has seen what is in it.
  const selectLeftTab = (id: string) => {
    if (id === 'tasks' || leftTab === 'tasks') seenTasks.markSeen(myTurnIds)
    setLeftTab(id)
  }
  // The morning's 「今日のあなたの番」 (its Mac notification or its bell line) opens the task list.
  const openTasks = () => { if (tasksShown) selectLeftTab('tasks'); else if (pressShown) selectLeftTab('press') }
  useOpenTasksRequest(currentCompany?.id, openTasks)
  // A skill opens where a click in the スキル tab opens it; a company-wide one under 全社.
  const openSkillFromPalette = (id: string) => {
    if (!skills.some(s => s.id === id)) handleSelectDept(COMPANY_TAB_ID)
    skillsTab.selectSkill(id)
    selectLeftTab('skills')
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
          onPublish={sharedFolder ? skillsTab.shareSkill : undefined}
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
          sharedFolder={sharedFolder}
          // A file on one PC means nothing to others: the server refuses file links without the shared folder.
          onLinkToTask={tasksShown && rootPath && sharedFolder ? path => setLinkingFile(companyPathOf(path, rootPath)) : undefined}
          extraMenuItems={plugins.fileMenuItems}
          onOpenToday={() => { void openToday() }}
          controls={treeControls}
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
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {arrivalsShown && <MeetingBanners key={currentCompany.id} companyId={currentCompany.id} items={meetings.arrivals.items} aiTurns={aiTurnItems} decisionsOn={features.decisions}
          onView={m => openTab(recordTabKey(m.id))} onChanged={() => { meetings.reload(); taskList.reload() }} />}
        <div className="flex min-h-0 flex-1">
        <TaskListPanel
          companyId={currentCompany.id}
          rootPath={rootPath}
          list={taskList}
          aiTurns={aiTurnItems}
          activeRecordId={activeRecordId}
          onOpen={id => { const item = taskList.data?.items.find(i => i.id === id); if (item) openListItem(item); else openTab(recordTabKey(id)) }}
          onConsult={consultAbout}
          onCompleted={id => closeTabs([recordTabKey(id)])}
          askFolder={isCompanyWide ? null : (selectedDept?.folder ?? null)}
          showCalendar={features.meetings}
          meetingActions={minutes.available && features.meetings ? {
            read: recordId => { const notice = minutes.notices.find(n => n.id === recordId); if (notice) startMinutesReading(notice, features) },
            skip: async recordId => { const r = await skipMinutes(currentCompany.id, recordId); return r && !r.success ? r.error : null },
          } : undefined}
        />
        </div>
        </div>
      ) : null,
    },
    {
      // The task list turned off (「使う機能」): what only ACB can act on, with 今日の予定 and arrived minutes above it.
      id: 'press', title: '押すもの', icon: HandPointing, mount: 'once-opened', className: 'flex',
      visible: pressShown,
      render: () => currentCompany ? (
        <CorePressPanel companyId={currentCompany.id} data={taskList.data} showCalendar={features.meetings}
          onOpen={id => { const item = taskList.data?.items.find(i => i.id === id); if (item) openListItem(item); else openTab(recordTabKey(id)) }}
          meetings={arrivalsShown ? <MeetingBanners key={currentCompany.id} companyId={currentCompany.id} items={meetings.arrivals.items} aiTurns={aiTurnItems} decisionsOn={features.decisions}
            onView={m => openTab(recordTabKey(m.id))} onChanged={() => { meetings.reload(); taskList.reload() }} /> : null} />
      ) : null,
    },
    {
      // 探す (never 「検索」): the narrow column; what is found opens in a tab in the middle.
      id: 'search', title: '探す', icon: MagnifyingGlass, mount: 'once-opened',
      onOpen: () => requestAnimationFrame(() => searchInputRef.current?.focus()),
      render: () => <SearchPanel rootPath={rootPath || ''} companyId={currentCompany?.id} departmentFolder={effectiveDeptFolder} inputRef={searchInputRef}
        departmentNames={departmentNames} recent={recentTabs} bundleWord={bundleWord} bundleKinds={bundleKinds} activeRecordId={activeRecordId}
        loadConsultations={loadFindConsultations} consultationTopics={consultationTopics} onOpenConsultation={openConsultation}
        notDownloaded={sparseCheckout.enabled ? sparseCheckout.excludedPaths : undefined}
        onOpenFile={(path, line) => { if (line !== undefined) setGotoLine({ path, line }); openTab(path) }} />,
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
        sharedFolder={sharedFolder}
        onPreview={sync.handlePreview}
        onSync={() => handleSync()}
        onShowBackups={() => setShowBackupHistory(true)}
        onShowSettings={() => setShowSettings(true)}
        onLogout={() => { void handleLogout() }}
        companySwitcher={currentCompany ? (
          <CompanySwitcher
            companyName={currentCompany.name}
            shown={companySwitch.shown}
            targets={companySwitch.targets}
            onSwitch={company => { void companySwitch.switchTo(company) }}
            question={companySwitch.question}
            onAnswer={companySwitch.answer}
            waitingForSync={companySwitch.waitingForSync}
            onStopWaiting={companySwitch.stopWaiting}
          />
        ) : undefined}
        extra={minutes.available && features.meetings && currentCompany ? <MinutesCheckButton companyId={currentCompany.id} /> : undefined}
        notices={currentCompany ? (
          <TitleBarNotices
            companyId={currentCompany.id}
            state={notices}
            meetings={titleBarMeetings}
            onOpen={target => { void runCommand('record.open', { recordId: target.recordId }).catch(() => {}) }}
            onOpenTasks={openTasks}
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
            todayFolder={today.folderNow}
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
                  aside={activeFilePath && !activeRecordId && rootPath && sharedFolder
                    ? <FileSidePanel companyId={currentCompany?.id} rootPath={rootPath} filePath={activeFilePath} />
                    : undefined}
                  pinnedTabs={tidying.pinned}
                  onTogglePinned={tidying.togglePinned}
                  arrangement={arrangement}
                  notice={<TabTidyingNotice tidying={tidying} />}
                  tabsEnd={<TabTidyingMenu tidying={tidying} arrangement={arrangement} activeKey={activeFilePath} looks={recordLooks} />}
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
          companyId={currentCompany.id} meetingTitle={choosingBundle.title} word={bundleWord}
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
        paletteSkills={paletteSkills}
        onOpenSkill={openSkillFromPalette}
        loadConsultations={loadPaletteConsultations}
        onOpenConsultation={openConsultation}
        tidying={tidying}
        showSettings={showSettings}
        settingsFocus={settingsFocus}
        onCloseSettings={() => { setShowSettings(false); setSettingsFocus(null); sparseCheckout.refresh() }}
        todayFolderSetting={<TodayFolderSetting choices={today.choices} chosenId={today.chosenId} onChoose={today.choose}
          defaultName={today.defaultDepartment?.name ?? null}
          chosenMissingName={today.chosenMissing?.name ?? null} folderNow={today.folderNow()} />}
        showBackupHistory={showBackupHistory}
        setShowBackupHistory={setShowBackupHistory}
      />
    </div>
  )
}
