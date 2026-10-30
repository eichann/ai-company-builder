import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CloudArrowUp, GearSix, House, Lightning, FolderSimple, SignOut, Sun, Moon, Globe, SpinnerGap, FolderOpen, X, ClockCounterClockwise, ListChecks, GitCommit, MagnifyingGlass, Info, ChatCircle, CaretLeft } from '@phosphor-icons/react'
import { DepartmentTabs } from '../components/skill-ui/DepartmentTabs'
import { SkillGrid } from '../components/skill-ui/SkillGrid'
import { SkillDetailPanel } from '../components/skill-ui/SkillDetailPanel'
import { NewSkillWizard } from '../components/skill-ui/NewSkillWizard'
import { CopySkillModal } from '../components/skill-ui/CopySkillModal'
import { FileTreePanel } from '../components/skill-ui/FileTreePanel'
import { TabbedEditorPanel } from '../components/skill-ui/TabbedEditorPanel'
import { ToolViewer } from '../components/skill-ui/ToolViewer'
import { SplitView } from '../features/workspace/components/SplitView'
import { ChatPanel } from '../components/chat/ChatPanel'
import { SettingsPanel } from '../components/settings'
import { BackupHistorySlideOver } from '../components/skill-ui/BackupHistorySlideOver'
import { CommitHistoryPanel, invalidateCommitCache, prefetchCommits } from '../components/skill-ui/CommitHistoryPanel'
import { SearchPanel } from '../components/skill-ui/SearchPanel'
import { FileSearchModal } from '../components/skill-ui/FileSearchModal'
import { SyncPreviewDialog } from '../components/common/SyncPreviewDialog'
import type { Skill, SkillTool } from '../types'
import { useAppStore } from '../stores/appStore'
import { useSkills } from '../hooks/useSkills'
import { useSparseCheckout } from '../hooks/useSparseCheckout'
import { useDepartments } from '../hooks/useDepartments'
import type { SlashCommandItem } from '../components/chat/SlashCommandDropdown'
import { isPerfCutEnabled, perfMark } from '../lib/perfDiagnostics'
import { isChatInputRecentlyActive } from '../lib/chatInputActivity'
import { usePrivateFolderStore } from '../hooks/usePrivateFolders'
import { subscribeFileChanges } from '../lib/fileEvents'
import { useSplitLayout } from '../features/workspace/hooks/useSplitLayout'
import { PANE_LIMITS } from '../features/workspace/layoutTree'
import { tabDepartmentLabels } from '../lib/editorTabs'
import { scanAffected, skillsScopesAffected } from '../../shared/skills-refresh'
import { unwatchCompany, watchCompany } from '../shared/ipc/file-events'
import { useEditorPersistence } from '../features/editor/hooks/useEditorPersistence'
import { useDepartmentSelection } from '../features/workspace/hooks/useDepartmentSelection'
import { COMPANY_TAB_ID } from '../shared/lib/departments'
import { useDepartmentAvailability } from '../features/workspace/hooks/useDepartmentAvailability'
import { useDepartmentDownload } from '../features/sync/hooks/useDepartmentDownload'
import { DepartmentDownloadPrompt } from '../features/sync/components/DepartmentDownloadPrompt'
import { copySkill, createSkillDirectory, makeSkillPrivate, publishSkill, readSkillFile, setSkillNurturing, writeSkillFile } from '../features/skills/api'
import { previewSync, revertChange, summarizeChanges, syncCompany } from '../features/sync/api'
import { signOut } from '../features/auth/api'

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
  // Use individual selectors to prevent unnecessary re-renders
  const currentCompany = useAppStore((s) => s.currentCompany)
  const setPendingChatInput = useAppStore((s) => s.setPendingChatInput)
  const setCurrentCompany = useAppStore((s) => s.setCurrentCompany)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)

  // Fetch departments from API
  const { departments, isLoading: isLoadingDepartments, refresh: refreshDepartments } = useDepartments(currentCompany?.id)

  // Sparse checkout state
  const sparseCheckout = useSparseCheckout({ rootPath: currentCompany?.rootPath || '' })

  const toggleLanguage = useCallback(() => {
    setLanguage(language === 'ja' ? 'en' : 'ja')
  }, [language, setLanguage])

  // The department tab, saved per company; 全社 when the saved one is gone.
  const { selectedDeptId, selectDepartment } = useDepartmentSelection(currentCompany?.id, departments)

  // Open file tabs, the active one and the left tab, saved per company.
  const { openFiles, setOpenFiles, activeFilePath, setActiveFilePath, leftTab, setLeftTab } =
    useEditorPersistence<LeftPanelTab>(currentCompany?.id, LEFT_TABS)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)

  // Search
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showFileSearch, setShowFileSearch] = useState(false)

  // Pane sizes as a split tree, saved per company; the chat is one leaf and can be hidden.
  const { layout, collapsed: collapsedPane, toggleCollapsed, startResize, resize } = useSplitLayout(currentCompany?.id)
  const toggleChat = useCallback(() => toggleCollapsed('chat'), [toggleCollapsed])

  // Modals
  const [showNewSkillWizard, setShowNewSkillWizard] = useState(false)
  const [showCopySkillModal, setShowCopySkillModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showBackupHistory, setShowBackupHistory] = useState(false)

  // Tool viewer state
  const [activeTool, setActiveTool] = useState<{ tool: SkillTool; port: number } | null>(null)

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncNotification, setSyncNotification] = useState<{
    type: 'success' | 'warning' | 'error'
    message: string
    backupPath?: string
  } | null>(null)

  // Preview state
  const [showPreview, setShowPreview] = useState(false)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [isLoadingSummary, setIsLoadingSummary] = useState(false)
  const [previewData, setPreviewData] = useState<{
    changes: { added: string[]; modified: string[]; deleted: string[] }
    totalCount: number
    summary?: string | null
  } | null>(null)

  const isCompanyWide = selectedDeptId === COMPANY_TAB_ID

  const selectedDept = useMemo(
    () => departments.find((d) => d.id === selectedDeptId),
    [departments, selectedDeptId]
  )

  // Which departments are not on this computer, and whether the selected one shows the download prompt.
  const { unsyncedFolders, isSelectedDeptUnsynced, markDownloaded } =
    useDepartmentAvailability(currentCompany?.rootPath, departments, selectedDept, isCompanyWide, sparseCheckout)

  // The effective path for file tree and chat
  const effectiveDeptFolder = isCompanyWide ? '' : (selectedDept?.folder || '')

  // Left tabs opened at least once stay mounted (hidden when not shown).
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<LeftPanelTab>>(() => new Set([leftTab]))
  if (!visitedTabs.has(leftTab)) setVisitedTabs(new Set([...visitedTabs, leftTab]))
  // The history panel follows the department only while shown (it runs git log).
  const [historyDeptFolder, setHistoryDeptFolder] = useState(effectiveDeptFolder)
  if (leftTab === 'history' && historyDeptFolder !== effectiveDeptFolder) setHistoryDeptFolder(effectiveDeptFolder)

  // Load skills from file system — skip if department is unsynced
  const { skills, isLoading: isLoadingSkills, refresh: refreshSkills } = useSkills({
    rootPath: currentCompany?.rootPath || '',
    departmentFolder: isSelectedDeptUnsynced ? '' : effectiveDeptFolder,
    departmentId: isSelectedDeptUnsynced ? '' : (isCompanyWide ? COMPANY_TAB_ID : selectedDeptId),
    departmentName: isCompanyWide ? '全社' : selectedDept?.name,
  })

  // Always load company-wide skills for slash command autocomplete
  const { skills: companySkills, refresh: refreshCompanySkills } = useSkills({
    rootPath: currentCompany?.rootPath || '',
    departmentFolder: '',
    departmentId: isCompanyWide ? '' : COMPANY_TAB_ID, // Skip when already viewing company tab (avoid duplicate)
    departmentName: '全社',
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

  // Skills rescans requested by file events, coalesced (120 ms, deferred up to
  // 1 s while the member is typing in the chat): the shown list and/or the
  // company-wide skills behind the slash commands.
  const pendingSkillsRefreshRef = useRef({ shown: false, company: false })
  const deferredSkillsRefreshTimerRef = useRef<number | null>(null)

  const skillsDeferCountRef = useRef(0)
  const SKILLS_MAX_DEFER_COUNT = 4

  const requestDeferredSkillsRefresh = useCallback((which: { shown: boolean; company: boolean }) => {
    const pending = pendingSkillsRefreshRef.current
    pending.shown ||= which.shown
    pending.company ||= which.company
    if (deferredSkillsRefreshTimerRef.current != null) return
    skillsDeferCountRef.current = 0

    const run = () => {
      const { shown, company } = pendingSkillsRefreshRef.current
      if (!shown && !company) {
        deferredSkillsRefreshTimerRef.current = null
        return
      }

      if (isChatInputRecentlyActive() && skillsDeferCountRef.current < SKILLS_MAX_DEFER_COUNT) {
        skillsDeferCountRef.current++
        perfMark('skill_layout.refresh_skills.deferred_for_chat_input')
        deferredSkillsRefreshTimerRef.current = window.setTimeout(run, 250)
        return
      }

      pendingSkillsRefreshRef.current = { shown: false, company: false }
      deferredSkillsRefreshTimerRef.current = null
      skillsDeferCountRef.current = 0
      if (shown) void refreshSkills()
      if (company) void refreshCompanySkills()
    }

    deferredSkillsRefreshTimerRef.current = window.setTimeout(run, 120)
  }, [refreshSkills, refreshCompanySkills])

  useEffect(() => {
    return () => {
      if (deferredSkillsRefreshTimerRef.current != null) {
        window.clearTimeout(deferredSkillsRefreshTimerRef.current)
      }
    }
  }, [])

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
      // Cmd+Shift+C → toggle chat panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        if (isChatInputRecentlyActive()) return
        e.preventDefault()
        toggleChat()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setLeftTab, toggleChat])

  // One recursive watcher for the whole company, opened with the company and
  // kept across department switches (closing chokidar's per-department
  // watchers blocked the main process for up to 40 s). Retried briefly in case
  // the folder is not registered with the main process yet.
  useEffect(() => {
    const root = currentCompany?.rootPath
    if (!root) return
    if (isPerfCutEnabled('disableWatchers')) {
      perfMark('skill_layout.watch.disabled')
      return
    }
    perfMark('skill_layout.watch.start')
    let cancelled = false
    let retryTimer: number | null = null
    const open = (attempt: number) => {
      void watchCompany(root).then(result => {
        if (cancelled || result?.success !== false || attempt >= 5) return
        retryTimer = window.setTimeout(() => open(attempt + 1), 1000)
      }).catch(() => {})
    }
    open(0)
    return () => {
      cancelled = true
      if (retryTimer != null) window.clearTimeout(retryTimer)
      void unwatchCompany(root)
      perfMark('skill_layout.watch.stop')
    }
  }, [currentCompany?.rootPath])

  // Rescan skills when a file event touches what the scans read: any
  // .claude/skills/ inside the shown department (any depth), the root
  // .claude/skills/ (company-wide view and slash commands), the root
  // .gitignore (private marks), or folders moved in/out of the department
  // (shared/skills-refresh.ts). The main process drops its cache on the same
  // events; the renderer's refresh is forced anyway.
  useEffect(() => {
    const root = currentCompany?.rootPath
    if (!root) return
    const shownFolder = isSelectedDeptUnsynced ? null : effectiveDeptFolder
    const shownIsCompany = isCompanyWide
    return subscribeFileChanges((changes) => {
      perfMark('skill_layout.fs_change')
      const scopes = skillsScopesAffected(root, changes)
      if (!scopes) return
      const company = scanAffected(scopes, '')
      const shown = shownIsCompany ? company : (shownFolder ? scanAffected(scopes, shownFolder) : false)
      if (!shown && !company) return
      perfMark('skill_layout.skills_change')
      // The company-wide hook is idle while the company tab is shown (the shown list is the same scan).
      requestDeferredSkillsRefresh({ shown, company: company && !shownIsCompany })
    })
  }, [currentCompany?.rootPath, effectiveDeptFolder, isCompanyWide, isSelectedDeptUnsynced, requestDeferredSkillsRefresh])

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId),
    [skills, selectedSkillId]
  )

  const handleSelectDept = (id: string) => {
    selectDepartment(id)
    setSelectedSkillId(null)
    // Open file tabs (and the active one) stay: they are one strip for the
    // whole company, labelled with their department when it is not this one.
    // Prefetch commit history for this department
    const dept = departments.find(d => d.id === id)
    if (dept && currentCompany?.rootPath) {
      prefetchCommits(currentCompany.rootPath, dept.folder)
    }
  }

  const tabLabels = useMemo(() => tabDepartmentLabels(openFiles, {
    rootPath: currentCompany?.rootPath || '',
    departments,
    selectedDeptId: isCompanyWide ? null : selectedDeptId,
  }), [openFiles, currentCompany?.rootPath, departments, isCompanyWide, selectedDeptId])

  const handleSelectSkill = (id: string) => {
    setSelectedSkillId(id)
  }

  const handleExecuteSkill = useCallback((id: string) => {
    const skill = skills.find((s) => s.id === id)
    if (!skill || !skill.skillPath) return

    // Extract folder name from skill path to use as slash command
    const folderName = skill.skillPath.split('/').pop()
    if (folderName) {
      setPendingChatInput(`/${folderName} `, true)
    }
  }, [skills, setPendingChatInput])

  // Build slash command items for chat autocomplete (current dept + company-wide)
  const slashCommands = useMemo<SlashCommandItem[]>(() => {
    const allSkills = isCompanyWide
      ? skills // Already showing company-wide
      : [...skills, ...companySkills]
    // Deduplicate by command (folder name)
    const seen = new Set<string>()
    return allSkills
      .filter(s => s.skillPath)
      .map(s => {
        const command = s.skillPath!.split('/').pop() || ''
        const dept = departments.find(d => d.id === s.departmentId)
        return {
          command,
          name: s.name,
          description: s.description,
          color: dept?.color || '#6366f1',
        }
      })
      .filter(item => {
        if (!item.command || seen.has(item.command)) return false
        seen.add(item.command)
        return true
      })
  }, [skills, companySkills, departments, isCompanyWide])

  // Open file as preview (single-click from file tree)
  // Replaces existing preview tab; already-pinned files just get activated
  const handleOpenFile = useCallback((filePath: string) => {
    setOpenFiles(prev => {
      const alreadyOpen = prev.includes(filePath)
      if (alreadyOpen) return prev // Already open — just activate
      // Replace existing preview tab with new preview
      const filtered = previewFilePath ? prev.filter(f => f !== previewFilePath) : prev
      return [...filtered, filePath]
    })
    setPreviewFilePath(prev => {
      // Don't overwrite if file is already pinned (open and not the current preview)
      if (openFiles.includes(filePath) && prev !== filePath) return prev
      return filePath
    })
    setActiveFilePath(filePath)
  }, [previewFilePath, openFiles, setOpenFiles, setActiveFilePath])

  // Pin a file as preview → pinned (double-click or edit)
  const handlePinFile = useCallback((filePath: string) => {
    setPreviewFilePath(prev => prev === filePath ? null : prev)
  }, [])

  const handleSelectOpenFile = useCallback((filePath: string) => {
    setActiveFilePath(filePath)
  }, [setActiveFilePath])

  const handleCloseFile = useCallback((filePath: string) => {
    setPreviewFilePath(prev => prev === filePath ? null : prev)
    setOpenFiles(prev => {
      const newFiles = prev.filter(f => f !== filePath)
      // If closing the active file, switch to another
      if (filePath === activeFilePath) {
        const index = prev.indexOf(filePath)
        const nextFile = newFiles[Math.min(index, newFiles.length - 1)] || null
        setActiveFilePath(nextFile)
      }
      return newFiles
    })
  }, [activeFilePath, setOpenFiles, setActiveFilePath])

  const handleEditFile = (filePath: string) => {
    setLeftTab('files')
    handleOpenFile(filePath)
  }

  const handleFileSearchSelect = useCallback((filePath: string) => {
    setLeftTab('files')
    handleOpenFile(filePath)
    handlePinFile(filePath)
  }, [handleOpenFile, handlePinFile, setLeftTab])


  const handleAddSkill = () => {
    setShowNewSkillWizard(true)
  }

  const handleCreateSkill = useCallback(async (data: { name: string; description: string; prompt: string; folderName: string }) => {
    if (!currentCompany?.rootPath || !selectedDept?.folder) return

    // Use the provided folder name (already validated as alphanumeric with - and _)
    const skillDirName = data.folderName

    const skillsBasePath = `${currentCompany.rootPath}/${selectedDept.folder}/.claude/skills`
    const skillPath = `${skillsBasePath}/${skillDirName}`
    const skillMdPath = `${skillPath}/SKILL.md`

    try {
      // Create .claude/skills directory if it doesn't exist
      await createSkillDirectory(skillsBasePath)

      // Create skill directory
      await createSkillDirectory(skillPath)

      // Create subdirectories (always create these even if empty)
      await createSkillDirectory(`${skillPath}/rules`)
      await createSkillDirectory(`${skillPath}/references`)
      await createSkillDirectory(`${skillPath}/scripts`)
      await createSkillDirectory(`${skillPath}/tools`)

      // Create SKILL.md with frontmatter
      const promptContent = data.prompt || `このスキルを実行すると、AIアシスタントが「${data.name}」タスクを実行します。`
      const skillMdContent = `---
name: ${data.name}
description: ${data.description}
---

# ${data.name}

${data.description}

## AIへの指示

${promptContent}

## ルール

<!-- rules/ フォルダにルールファイルを追加してください -->

## 参考資料

<!-- references/ フォルダに参考資料を追加してください -->
`

      await writeSkillFile(skillMdPath, skillMdContent)

      // Default to private (not shared): add to .gitignore
      const skillRelativePath = `${selectedDept.folder}/.claude/skills/${skillDirName}/`
      await makeSkillPrivate(currentCompany.rootPath, skillRelativePath)

      // Refresh skills list
      refreshSkills()

      // Close wizard
      setShowNewSkillWizard(false)

      // Select the new skill
      setSelectedSkillId(`${selectedDeptId}-${skillDirName}`)
    } catch (error) {
      console.error('Failed to create skill:', error)
      // TODO: Show error message to user
    }
  }, [currentCompany?.rootPath, selectedDept?.folder, selectedDeptId, refreshSkills])

  const handleCopySkill = useCallback(async (sourceSkillPath: string, name: string, folderName: string) => {
    if (!currentCompany?.rootPath || !effectiveDeptFolder) return

    const skillsBasePath = `${currentCompany.rootPath}/${effectiveDeptFolder}/.claude/skills`
    const destPath = `${skillsBasePath}/${folderName}`

    try {
      // Ensure .claude/skills directory exists
      await createSkillDirectory(skillsBasePath)

      // Copy entire skill directory
      const copyResult = await copySkill(sourceSkillPath, destPath)
      if (!copyResult.success) {
        console.error('Failed to copy skill:', copyResult.error)
        return
      }

      // Update SKILL.md frontmatter with new name
      const skillMdPath = `${destPath}/SKILL.md`
      const content = await readSkillFile(skillMdPath)
      if (content) {
        const updated = content.replace(
          /^(---\n[\s\S]*?name:\s*).+$/m,
          `$1${name}`,
        )
        await writeSkillFile(skillMdPath, updated)
      }

      // Copied skills are public by default (user intentionally copied them)

      refreshSkills()
      setShowCopySkillModal(false)
      setSelectedSkillId(`${selectedDeptId}-${folderName}`)
    } catch (error) {
      console.error('Failed to copy skill:', error)
    }
  }, [currentCompany?.rootPath, effectiveDeptFolder, selectedDeptId, refreshSkills])

  const handlePublishSkill = useCallback(async (skill: Skill) => {
    if (!currentCompany?.rootPath) return
    const dept = departments.find(d => d.id === skill.departmentId)
    if (!dept) return
    const skillFolderName = skill.skillPath?.split('/').pop()
    if (!skillFolderName) return

    const skillRelativePath = `${dept.folder}/.claude/skills/${skillFolderName}/`
    await publishSkill(currentCompany.rootPath, skillRelativePath)
    refreshSkills()
  }, [currentCompany?.rootPath, departments, refreshSkills])

  const handleToggleNurturing = useCallback(async (skill: Skill) => {
    if (!skill.files.skillMd) return
    await setSkillNurturing(skill.files.skillMd, !skill.isNurturing)
    refreshSkills()
  }, [refreshSkills])

  const handlePreview = useCallback(async () => {
    if (!currentCompany?.rootPath) return
    setIsLoadingPreview(true)
    try {
      const result = await previewSync(currentCompany.rootPath)
      if (!result.success) {
        setSyncNotification({ type: 'error', message: result.error || 'プレビューに失敗しました' })
        return
      }
      if (!result.hasChanges) {
        setSyncNotification({ type: 'success', message: '変更はありません' })
        setTimeout(() => setSyncNotification(null), 3000)
        return
      }
      setPreviewData({ changes: result.changes, totalCount: result.totalCount, summary: null })
      setShowPreview(true)
    } catch (error) {
      console.error('Preview failed:', error)
      setSyncNotification({ type: 'error', message: 'プレビューに失敗しました' })
    } finally {
      setIsLoadingPreview(false)
    }
  }, [currentCompany?.rootPath])

  const handleRequestSummary = useCallback(async () => {
    if (!currentCompany?.rootPath) return
    setIsLoadingSummary(true)
    try {
      const result = await summarizeChanges(currentCompany.rootPath)
      if (result.success && result.summary) {
        setPreviewData(prev => prev ? { ...prev, summary: result.summary } : prev)
      }
    } catch {
      // Summary generation failed — not critical
    } finally {
      setIsLoadingSummary(false)
    }
  }, [currentCompany?.rootPath])

  const handleSync = useCallback(async (customCommitMessage?: string) => {
    if (!currentCompany?.rootPath || !currentCompany?.id) return

    setIsSyncing(true)
    setSyncNotification(null)

    try {
      const result = await syncCompany(
        currentCompany.rootPath,
        currentCompany.id,
        customCommitMessage || 'Sync from AI Company Builder'
      )

      if (result.success) {
        // Refresh departments, skills, private folders and commit history after successful sync
        void usePrivateFolderStore.getState().load(currentCompany.id)
        await refreshDepartments()
        // Teammates' skills: the shown list and the company-wide ones behind the slash commands.
        void refreshSkills()
        if (!isCompanyWide) void refreshCompanySkills()
        invalidateCommitCache()

        if (result.restoredProtectedFiles && result.restoredProtectedFiles.length > 0) {
          // Protected agent config was put back to the server's version
          setSyncNotification({
            type: 'warning',
            message: result.message || `管理者だけが変更できるファイルをサーバーの状態に戻しました: ${result.restoredProtectedFiles.join(', ')}`,
            backupPath: result.protectedBackupPath || result.backupPath
          })
        } else if (result.restoredWriteDeniedFiles && result.restoredWriteDeniedFiles.length > 0) {
          // Files in a folder the member may not edit were put back to the server's version
          setSyncNotification({
            type: 'warning',
            message: result.message || `編集する権限がないフォルダのファイルを元に戻しました: ${result.restoredWriteDeniedFiles.join(', ')}`,
            backupPath: result.writeDeniedBackupPath || result.backupPath
          })
        } else if (result.untrackedPersonalFiles && result.untrackedPersonalFiles.length > 0) {
          // .personal/ files are never shared; sync untracked them (kept on disk)
          setSyncNotification({
            type: 'warning',
            message: result.message || `個人用フォルダ（.personal）のファイルを共有対象から外しました: ${result.untrackedPersonalFiles.join(', ')}`,
            backupPath: result.backupPath
          })
        } else if (result.outsideCheckoutFiles && result.outsideCheckoutFiles.length > 0) {
          // Files created in a folder this computer has not downloaded were set aside, not shared
          setSyncNotification({
            type: 'warning',
            message: result.message || `ダウンロードしていないフォルダに作られたファイルを .backups に保存しました: ${result.outsideCheckoutFiles.join(', ')}`,
            backupPath: result.outsideCheckoutBackupPath || result.backupPath
          })
        } else if (result.hadConflicts) {
          setSyncNotification({
            type: 'warning',
            message: result.message || `${result.conflictFiles?.length || 0}ファイルが競合しました。サーバー版で上書きしました。`,
            backupPath: result.backupPath
          })
        } else if (result.restoredFolders && result.restoredFolders.length > 0) {
          setSyncNotification({
            type: 'warning',
            message: `部署フォルダを復元しました: ${result.restoredFolders.join(', ')}`
          })
        } else if (result.ignoredLargeFiles && result.ignoredLargeFiles.length > 0) {
          setSyncNotification({
            type: 'warning',
            message: `${result.ignoredLargeFiles.length}個の大容量ファイル（100MB以上）を同期対象外にしました: ${result.ignoredLargeFiles.slice(0, 3).join(', ')}${result.ignoredLargeFiles.length > 3 ? '...' : ''}`
          })
        } else if (result.excludedNestedRepos && result.excludedNestedRepos.length > 0) {
          setSyncNotification({
            type: 'warning',
            message: `別の場所から取り込んだフォルダを、共有せずこのPCだけに置きました（${result.excludedNestedRepos.length}件）: ${result.excludedNestedRepos.slice(0, 3).join(', ')}${result.excludedNestedRepos.length > 3 ? '...' : ''}`
          })
        } else {
          setSyncNotification({
            type: 'success',
            message: result.message || '同期が完了しました'
          })
        }
      } else {
        setSyncNotification({
          type: 'error',
          message: result.error || '同期に失敗しました'
        })
      }

      // Auto-hide success notification after 3 seconds (unless there were warnings)
      const hasWarnings = result.hadConflicts ||
        (result.restoredProtectedFiles && result.restoredProtectedFiles.length > 0) ||
        (result.restoredWriteDeniedFiles && result.restoredWriteDeniedFiles.length > 0) ||
        (result.untrackedPersonalFiles && result.untrackedPersonalFiles.length > 0) ||
        (result.outsideCheckoutFiles && result.outsideCheckoutFiles.length > 0) ||
        (result.nestedRepoBackupFiles && result.nestedRepoBackupFiles.length > 0) ||
        (result.restoredFolders && result.restoredFolders.length > 0) ||
        (result.ignoredLargeFiles && result.ignoredLargeFiles.length > 0) ||
        (result.excludedNestedRepos && result.excludedNestedRepos.length > 0)
      if (result.success && !hasWarnings) {
        setTimeout(() => setSyncNotification(null), 3000)
      }
    } catch (error) {
      console.error('Sync failed:', error)
      setSyncNotification({
        type: 'error',
        message: error instanceof Error ? error.message : '同期に失敗しました'
      })
    } finally {
      setIsSyncing(false)
    }
  }, [currentCompany, refreshDepartments, refreshSkills, refreshCompanySkills, isCompanyWide])

  const handlePrivateFolderCreated = useCallback(() => { void handleSync() }, [handleSync])

  const handleRevertFile = useCallback(async (filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => {
    if (!currentCompany?.rootPath) return
    await revertChange(currentCompany.rootPath, filePath, fileStatus)
    // Refresh preview data
    const result = await previewSync(currentCompany.rootPath)
    if (result.success) {
      if (result.totalCount === 0) {
        setShowPreview(false)
        setPreviewData(null)
      } else {
        setPreviewData(result)
      }
    }
  }, [currentCompany?.rootPath])

  const handleOpenBackup = useCallback((backupPath: string) => {
    // Use shell.openPath equivalent - for now just copy path
    navigator.clipboard.writeText(backupPath)
    alert(`バックアップパスをコピーしました:\n${backupPath}`)
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await signOut()
      setCurrentCompany(null)
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }, [setCurrentCompany])

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-zinc-950">
      {/* Title Bar */}
      <header className="flex-shrink-0 h-12 flex items-center justify-between pl-20 pr-4 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 app-drag">
        <div className="flex items-center gap-3 app-no-drag">
          <House size={18} className="text-gray-500 dark:text-zinc-400" />
          <span className="text-sm font-medium text-gray-700 dark:text-zinc-200">
            {currentCompany?.name || 'AI Company Builder'}
          </span>
        </div>
        <div className="flex items-center gap-2 app-no-drag">
          <button
            onClick={handlePreview}
            disabled={isLoadingPreview || !currentCompany}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors disabled:opacity-50"
            title="変更を確認"
          >
            {isLoadingPreview ? (
              <SpinnerGap size={18} className="animate-spin" />
            ) : (
              <ListChecks size={18} />
            )}
          </button>
          <button
            onClick={() => handleSync()}
            disabled={isSyncing || !currentCompany}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors disabled:opacity-50"
            title="サーバーと同期"
          >
            {isSyncing ? (
              <SpinnerGap size={18} className="animate-spin" />
            ) : (
              <CloudArrowUp size={18} />
            )}
          </button>
          <div className="w-px h-4 bg-gray-200 dark:bg-zinc-700" />
          <button
            onClick={() => setShowBackupHistory(true)}
            disabled={!currentCompany}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors disabled:opacity-50"
            title="バックアップ履歴"
          >
            <ClockCounterClockwise size={18} />
          </button>
          <button
            onClick={toggleLanguage}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors text-xs font-medium"
            title={language === 'ja' ? 'Switch to English' : '日本語に切り替え'}
          >
            <Globe size={16} />
            <span>{language === 'ja' ? 'EN' : 'JA'}</span>
          </button>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors"
            title={theme === 'dark' ? t('header.lightMode') : t('header.darkMode')}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors"
            title={t('header.settings')}
          >
            <GearSix size={18} />
          </button>
          <button
            onClick={handleLogout}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-red-500 transition-colors"
            title={t('header.logout')}
          >
            <SignOut size={18} />
          </button>
        </div>
      </header>

      {/* Department Tabs */}
      <div className="flex-shrink-0 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        {isLoadingDepartments ? (
          <div className="flex items-center justify-center h-14 text-gray-400 dark:text-zinc-500 text-sm">
            {t('common.loading')}...
          </div>
        ) : departments.length === 0 ? (
          <div className="flex items-center justify-center h-14 text-gray-400 dark:text-zinc-500 text-sm">
            {t('departments.noDepartments')}
          </div>
        ) : (
          <DepartmentTabs
            departments={departments}
            selectedId={selectedDeptId}
            onSelect={handleSelectDept}
            unsyncedFolders={unsyncedFolders}
          />
        )}
      </div>

      {/* Sparse checkout banner for company-wide tab */}
      {isCompanyWide && sparseCheckout.enabled && unsyncedFolders && unsyncedFolders.size > 0 && (
        <div className="flex-shrink-0 flex items-center gap-2 px-6 py-2 bg-indigo-50 dark:bg-indigo-950/30 border-b border-indigo-100 dark:border-indigo-900/50 text-sm text-indigo-700 dark:text-indigo-300">
          <Info size={16} className="flex-shrink-0" />
          <span>
            一部の部署がダウンロードされていません。ファイルツリーとAIチャットの対象はダウンロード済みの部署に限られます。
          </span>
          <button
            onClick={() => setShowSettings(true)}
            className="ml-auto text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"
          >
            設定で変更
          </button>
        </div>
      )}

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
            departmentPath={currentCompany?.rootPath}
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
                    rootPath={currentCompany?.rootPath || ''}
                    departmentFolder={historyDeptFolder}
                  />
                </div>
              )}

              {/* Search Tab */}
              {visitedTabs.has('search') && (
                <div className={`h-full ${leftTab !== 'search' ? 'hidden' : ''}`}>
                  <SearchPanel
                    rootPath={currentCompany?.rootPath || ''}
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
                    rootPath={currentCompany?.rootPath || ''}
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
        rootPath={currentCompany?.rootPath || ''}
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
        rootPath={currentCompany?.rootPath || ''}
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
          rootPath={currentCompany?.rootPath || ''}
          onSync={(commitMessage) => { setShowPreview(false); handleSync(commitMessage) }}
          isSyncing={isSyncing}
          onRevertFile={handleRevertFile}
        />
      )}

      {/* Sync Notification */}
      {syncNotification && (
        <div className="fixed bottom-4 right-4 z-50 max-w-md animate-in slide-in-from-bottom-2">
          <div className={`
            rounded-lg shadow-lg border p-4
            ${syncNotification.type === 'success'
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : syncNotification.type === 'warning'
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
            }
          `}>
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <p className="text-sm font-medium">{syncNotification.message}</p>
                {syncNotification.backupPath && (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() => handleOpenBackup(syncNotification.backupPath!)}
                      className="flex items-center gap-1 text-xs hover:underline"
                    >
                      <FolderOpen size={14} />
                      フォルダを開く
                    </button>
                    <button
                      onClick={() => {
                        setShowBackupHistory(true)
                        setSyncNotification(null)
                      }}
                      className="flex items-center gap-1 text-xs hover:underline"
                    >
                      <ClockCounterClockwise size={14} />
                      履歴を見る
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => setSyncNotification(null)}
                className="text-current opacity-70 hover:opacity-100"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
