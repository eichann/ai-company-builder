import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CloudArrowUp, GearSix, House, Lightning, FolderSimple, SignOut, Sun, Moon, Globe, SpinnerGap, FolderOpen, X, ClockCounterClockwise } from '@phosphor-icons/react'
import { DepartmentTabs } from './DepartmentTabs'
import { SkillGrid } from './SkillGrid'
import { SkillDetailPanel } from './SkillDetailPanel'
import { NewSkillWizard } from './NewSkillWizard'
import { FileTreePanel } from './FileTreePanel'
import { TabbedEditorPanel } from './TabbedEditorPanel'
import { ToolViewer } from './ToolViewer'
import { ResizeHandle } from './ResizeHandle'
import { ChatPanel } from '../chat/ChatPanel'
import { SettingsPanel } from '../settings'
import { BackupHistorySlideOver } from './BackupHistorySlideOver'
import type { Skill, SkillTool } from '../../types'
import { useAppStore } from '../../stores/appStore'
import { useSkills } from '../../hooks/useSkills'
import { useDepartments } from '../../hooks/useDepartments'
import { isPerfCutEnabled, perfMark } from '../../lib/perfDiagnostics'
import { isChatInputRecentlyActive } from '../../lib/chatInputActivity'

// Panel width constraints
const MIN_LEFT_PANEL_WIDTH = 300
const MAX_LEFT_PANEL_WIDTH = 1200
const MIN_CHAT_WIDTH = 280

type LeftPanelTab = 'skills' | 'files'

export function SkillCentricLayout() {
  const { t } = useTranslation()
  // Use individual selectors to prevent unnecessary re-renders
  const currentCompany = useAppStore((s) => s.currentCompany)
  const setActiveSkill = useAppStore((s) => s.setActiveSkill)
  const setCurrentCompany = useAppStore((s) => s.setCurrentCompany)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)

  // Fetch departments from API
  const { departments, isLoading: isLoadingDepartments, refresh: refreshDepartments } = useDepartments(currentCompany?.id)

  const toggleLanguage = useCallback(() => {
    setLanguage(language === 'ja' ? 'en' : 'ja')
  }, [language, setLanguage])

  // Department selection
  const [selectedDeptId, setSelectedDeptId] = useState<string>('')

  // Auto-select first department when departments load (no useEffect needed)
  const prevDeptCountRef = useRef(0)
  if (departments.length > 0 && !selectedDeptId && prevDeptCountRef.current === 0) {
    setSelectedDeptId(departments[0].id)
  }
  prevDeptCountRef.current = departments.length

  // Left panel state
  const [leftTab, setLeftTab] = useState<LeftPanelTab>('skills')
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)

  // Multi-file editor state
  const [openFiles, setOpenFiles] = useState<string[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)

  // Panel width state (resizable)
  const [leftPanelWidth, setLeftPanelWidth] = useState(550)

  // Modals
  const [showNewSkillWizard, setShowNewSkillWizard] = useState(false)
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

  const selectedDept = useMemo(
    () => departments.find((d) => d.id === selectedDeptId),
    [departments, selectedDeptId]
  )

  // Load skills from file system
  const { skills, isLoading: isLoadingSkills, refresh: refreshSkills } = useSkills({
    rootPath: currentCompany?.rootPath || '',
    departmentFolder: selectedDept?.folder || '',
    departmentId: selectedDeptId,
  })
  const pendingSkillsRefreshRef = useRef(false)
  const deferredSkillsRefreshTimerRef = useRef<number | null>(null)

  const requestDeferredSkillsRefresh = useCallback(() => {
    pendingSkillsRefreshRef.current = true
    if (deferredSkillsRefreshTimerRef.current != null) return

    const run = () => {
      if (!pendingSkillsRefreshRef.current) {
        deferredSkillsRefreshTimerRef.current = null
        return
      }

      if (isChatInputRecentlyActive()) {
        perfMark('skill_layout.refresh_skills.deferred_for_chat_input')
        deferredSkillsRefreshTimerRef.current = window.setTimeout(run, 250)
        return
      }

      pendingSkillsRefreshRef.current = false
      deferredSkillsRefreshTimerRef.current = null
      void refreshSkills()
    }

    deferredSkillsRefreshTimerRef.current = window.setTimeout(run, 120)
  }, [refreshSkills])

  useEffect(() => {
    return () => {
      if (deferredSkillsRefreshTimerRef.current != null) {
        window.clearTimeout(deferredSkillsRefreshTimerRef.current)
      }
    }
  }, [])

  // Watch skills directory for changes
  useEffect(() => {
    if (!currentCompany?.rootPath || !selectedDept?.folder) return

    const skillsPath = `${currentCompany.rootPath}/${selectedDept.folder}/.claude/skills`

    if (isPerfCutEnabled('disableWatchers')) {
      perfMark('skill_layout.watch.disabled')
      return
    }

    // Start watching the skills directory
    perfMark('skill_layout.watch.start')
    window.electronAPI.watchDirectory(skillsPath)

    const unsubscribe = window.electronAPI.onFileChange((data) => {
      perfMark('skill_layout.fs_change')
      if (isPerfCutEnabled('fsEvents')) {
        perfMark('skill_layout.fs_change.skipped')
        return
      }

      // Check if the change is in the skills directory
      if (data.path.startsWith(skillsPath)) {
        perfMark('skill_layout.skills_change')
        requestDeferredSkillsRefresh()
      }
    })

    return () => {
      unsubscribe()
      window.electronAPI.unwatchDirectory(skillsPath)
      perfMark('skill_layout.watch.stop')
    }
  }, [currentCompany?.rootPath, selectedDept?.folder, requestDeferredSkillsRefresh])

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId),
    [skills, selectedSkillId]
  )

  const handleSelectDept = (id: string) => {
    setSelectedDeptId(id)
    setSelectedSkillId(null)
    setOpenFiles([])
    setActiveFilePath(null)
  }

  const handleSelectSkill = (id: string) => {
    setSelectedSkillId(id)
  }

  const handleExecuteSkill = useCallback(async (id: string) => {
    const skill = skills.find((s) => s.id === id)
    if (!skill || !skill.files.skillMd) return

    try {
      // Read the SKILL.md content
      const skillMdContent = await window.electronAPI.readFile(skill.files.skillMd)
      if (skillMdContent) {
        setActiveSkill(skill, skillMdContent)
      }
    } catch (error) {
      console.error('Failed to read SKILL.md:', error)
    }
  }, [skills, setActiveSkill])

  const handleOpenFile = useCallback((filePath: string) => {
    setOpenFiles(prev => {
      if (prev.includes(filePath)) {
        return prev // Already open
      }
      return [...prev, filePath]
    })
    setActiveFilePath(filePath)
  }, [])

  const handleSelectOpenFile = useCallback((filePath: string) => {
    setActiveFilePath(filePath)
  }, [])

  const handleCloseFile = useCallback((filePath: string) => {
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
  }, [activeFilePath])

  const handleEditFile = (filePath: string) => {
    setLeftTab('files')
    handleOpenFile(filePath)
  }

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
      await window.electronAPI.createDirectory(skillsBasePath)

      // Create skill directory
      await window.electronAPI.createDirectory(skillPath)

      // Create subdirectories (always create these even if empty)
      await window.electronAPI.createDirectory(`${skillPath}/rules`)
      await window.electronAPI.createDirectory(`${skillPath}/references`)
      await window.electronAPI.createDirectory(`${skillPath}/scripts`)
      await window.electronAPI.createDirectory(`${skillPath}/tools`)

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

      await window.electronAPI.writeFile(skillMdPath, skillMdContent)

      // Default to private (not shared): add to .gitignore
      const skillRelativePath = `${selectedDept.folder}/.claude/skills/${skillDirName}/`
      await window.electronAPI.makeSkillPrivate(currentCompany.rootPath, skillRelativePath)

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

  const handlePublishSkill = useCallback(async (skill: Skill) => {
    if (!currentCompany?.rootPath) return
    const dept = departments.find(d => d.id === skill.departmentId)
    if (!dept) return
    const skillFolderName = skill.skillPath?.split('/').pop()
    if (!skillFolderName) return

    const skillRelativePath = `${dept.folder}/.claude/skills/${skillFolderName}/`
    await window.electronAPI.publishSkill(currentCompany.rootPath, skillRelativePath)
    refreshSkills()
  }, [currentCompany?.rootPath, departments, refreshSkills])

  const handleToggleNurturing = useCallback(async (skill: Skill) => {
    if (!skill.files.skillMd) return
    await window.electronAPI.toggleSkillNurturing(skill.files.skillMd, !skill.isNurturing)
    refreshSkills()
  }, [refreshSkills])

  const handleLeftPanelResize = useCallback((delta: number) => {
    setLeftPanelWidth(prev => {
      const newWidth = prev + delta
      // Calculate max width based on window width to ensure chat min width
      const windowWidth = window.innerWidth
      const dynamicMaxWidth = Math.min(MAX_LEFT_PANEL_WIDTH, windowWidth - MIN_CHAT_WIDTH - 10)
      // Clamp to min/max values
      return Math.min(dynamicMaxWidth, Math.max(MIN_LEFT_PANEL_WIDTH, newWidth))
    })
  }, [])

  const handleSync = useCallback(async () => {
    if (!currentCompany?.rootPath || !currentCompany?.id) return

    setIsSyncing(true)
    setSyncNotification(null)

    try {
      const result = await window.electronAPI.gitSync(
        currentCompany.rootPath,
        currentCompany.id,
        'Sync from AI Company Builder'
      )

      if (result.success) {
        // Refresh departments and skills after successful sync
        await refreshDepartments()
        refreshSkills()

        if (result.hadConflicts) {
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
        (result.restoredFolders && result.restoredFolders.length > 0) ||
        (result.ignoredLargeFiles && result.ignoredLargeFiles.length > 0)
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
  }, [currentCompany, refreshDepartments, refreshSkills])

  const handleOpenBackup = useCallback((backupPath: string) => {
    // Use shell.openPath equivalent - for now just copy path
    navigator.clipboard.writeText(backupPath)
    alert(`バックアップパスをコピーしました:\n${backupPath}`)
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await window.electronAPI.signOut()
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
            onClick={handleSync}
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
          />
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel (Skills or Files) */}
        <div
          className="flex flex-col border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex-shrink-0"
          style={{ width: leftPanelWidth }}
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
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-hidden min-w-0">
            {leftTab === 'skills' ? (
              /* Skills Tab */
              <div className="h-full flex">
                <div className={`${selectedSkillId ? 'w-1/2' : 'w-full'} transition-all overflow-hidden`}>
                  <SkillGrid
                    skills={skills}
                    color={selectedDept?.color || '#f59e0b'}
                    selectedSkillId={selectedSkillId}
                    onSelectSkill={handleSelectSkill}
                    onExecuteSkill={handleExecuteSkill}
                    onAddSkill={handleAddSkill}
                    isLoading={isLoadingSkills}
                  />
                </div>
                {selectedSkillId && selectedSkill && (
                  <div className="w-1/2 border-l border-gray-200 dark:border-zinc-800 overflow-hidden">
                    <SkillDetailPanel
                      skill={selectedSkill}
                      color={selectedDept?.color || '#f59e0b'}
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
            ) : (
              /* Files Tab */
              <div className="h-full flex min-w-0">
                <div className="w-[200px] flex-shrink-0">
                  <FileTreePanel
                    rootPath={currentCompany?.rootPath || ''}
                    departmentFolder={selectedDept?.folder || ''}
                    selectedFilePath={activeFilePath}
                    onSelectFile={handleOpenFile}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <TabbedEditorPanel
                    openFiles={openFiles}
                    activeFilePath={activeFilePath}
                    onSelectFile={handleSelectOpenFile}
                    onCloseFile={handleCloseFile}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Resize Handle */}
        <ResizeHandle onResize={handleLeftPanelResize} direction="horizontal" />

        {/* Right Panel (Chat - Always Visible) */}
        <div className="flex-1" style={{ minWidth: MIN_CHAT_WIDTH }}>
          <ChatPanel
            departmentPath={selectedDept && currentCompany
              ? `${currentCompany.rootPath}/${selectedDept.folder}`
              : undefined
            }
          />
        </div>
      </div>

      {/* New Skill Wizard Modal */}
      {showNewSkillWizard && selectedDept && (
        <NewSkillWizard
          departmentName={selectedDept.name}
          color={selectedDept.color}
          onClose={() => setShowNewSkillWizard(false)}
          onComplete={handleCreateSkill}
        />
      )}

      {/* Settings Panel Modal */}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
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
              color={selectedDept?.color || '#f59e0b'}
              onClose={() => setActiveTool(null)}
            />
          </div>
        </div>
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
