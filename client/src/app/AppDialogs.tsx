import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { NewSkillWizard } from '../features/skills/components/NewSkillWizard'
import { CopySkillModal } from '../features/skills/components/CopySkillModal'
import { ToolViewer } from '../features/skills/components/ToolViewer'
import { FindPalette } from '../features/search/components/FindPalette'
import { RECORDS_TABLE_PALETTE_ACTION } from '../features/records-table/entry'
import type { PaletteAction, PaletteConsultation, PaletteRecent, PaletteSkill } from '../features/search/model'
import type { useTabTidying } from '../features/editor/hooks/useTabTidying'
import { TabTidyingList } from '../features/editor/components/TabTidyingControls'
import { TidyTabsSetting } from '../features/settings/components/TidyTabsSetting'
import { BackupHistorySlideOver } from '../features/sync/components/BackupHistorySlideOver'
import { SettingsPanel } from '../features/settings/components/SettingsPanel'
import { ConnectToolsScreen } from '../features/settings/components/ConnectToolsScreen'
import { SyncPreviewDialog } from '../features/sync/components/SyncPreviewDialog'
import { SyncNotification } from '../features/sync/components/SyncNotification'
import type { useSkillsTab } from '../features/skills/hooks/useSkillsTab'
import type { useSync } from '../features/sync/hooks/useSync'
import type { DepartmentConfig } from '../types'

// 探す ⌘K finds 「片づけたタブ」 by these words too.
const PALETTE_ACTIONS: PaletteAction[] = [{ id: 'tidiedTabs', title: '片づけたタブ', words: ['タブ', '片づけ', '片付け', 'かたづけ', 'tab'] }, RECORDS_TABLE_PALETTE_ACTION]
// ⌘K 「受け箱」 (I2), also by the words of what it replaced in the title bar (あなたの番, the bell's 知らせ).
const INBOX_PALETTE_ACTION: PaletteAction = { id: 'inbox', title: '受け箱', words: ['受け箱', 'うけばこ', 'あなた待ち', 'あなたの番', '知らせ', '通知', 'ベル', 'inbox'] }

interface Props {
  /** The open company: 「仕事の道具をつなぐ」 offers itself once per member and company. */
  companyId: string | undefined
  rootPath: string
  departments: DepartmentConfig[]
  selectedDeptId: string
  selectedDept: DepartmentConfig | undefined
  departmentFolder: string
  unsyncedFolders: Set<string> | undefined
  skillsTab: ReturnType<typeof useSkillsTab>
  sync: ReturnType<typeof useSync>
  showFileSearch: boolean
  onCloseFileSearch: () => void
  onFileSearchSelect: (filePath: string) => void
  /** 探す ⌘K: the tabs open in the middle (newest first), and opening a record found. */
  recentTabs: PaletteRecent[]
  onOpenRecord: (recordId: string) => void
  /** ⌘K 「記録の一覧」 (features/records-table). */
  onShowRecordsTable: () => void
  /** ⌘K 「受け箱」: only while there is an inbox (records on, or the company's own notices). */
  onOpenInbox?: () => void
  /** 探す ⌘K's skills (already loaded) and 「AIへの相談」 (read when it opens), each opened in its usual place. */
  paletteSkills: PaletteSkill[]
  onOpenSkill: (skillId: string) => void
  loadConsultations?: () => Promise<PaletteConsultation[]>
  onOpenConsultation: (sessionId: string) => void
  showSettings: boolean
  /** Open settings on 「自分の鍵」 for this service (a new request remounts the panel). */
  settingsFocus: { service?: string; tab?: 'ownkeys' | 'jobs'; at: number } | null
  onCloseSettings: () => void
  /** 自分の設定's 「今日のフォルダ」 row. */
  todayFolderSetting?: ReactNode
  /** 「タブを片づける」 (features/editor): 「片づけたタブ」, its ⌘K entry and the daily tidy's setting. */
  tidying: ReturnType<typeof useTabTidying>
  showBackupHistory: boolean
  setShowBackupHistory: Dispatch<SetStateAction<boolean>>
}

/** What opens over the main screen: skill dialogs, Cmd+P, settings, backups, a skill's tool, the sync preview and notice. */
export function AppDialogs(props: Props) {
  const { companyId, rootPath, departments, selectedDeptId, selectedDept, departmentFolder, unsyncedFolders, skillsTab, sync } = props
  const { showFileSearch, onCloseFileSearch, onFileSearchSelect, showSettings, settingsFocus, onCloseSettings, showBackupHistory, setShowBackupHistory } = props
  return (
    <>
        <TabTidyingList tidying={props.tidying} />
        {/* New Skill Wizard Modal */}
        {skillsTab.wizardOpen && selectedDept && (
          <NewSkillWizard
            departmentName={selectedDept.name}
            color={selectedDept.color}
            onClose={() => skillsTab.setWizardOpen(false)}
            onComplete={skillsTab.create}
          />
        )}

        {/* Copy Skill Modal */}
        {skillsTab.copyOpen && rootPath && (
          <CopySkillModal
            rootPath={rootPath}
            currentDepartmentId={selectedDeptId}
            departments={departments}
            color={selectedDept?.color || '#6366f1'}
            onClose={() => skillsTab.setCopyOpen(false)}
            onCopy={skillsTab.copy}
            unsyncedFolders={unsyncedFolders}
          />
        )}

        {/* 探す ⌘K / ⌘P: open anything by its name (mounted only while open, so it starts empty) */}
        {showFileSearch && (
          <FindPalette
            onClose={onCloseFileSearch}
            rootPath={rootPath}
            companyId={companyId}
            departmentFolder={departmentFolder}
            recent={props.recentTabs}
            onSelectFile={onFileSearchSelect}
            onOpenRecord={props.onOpenRecord}
            skills={props.paletteSkills}
            onOpenSkill={props.onOpenSkill}
            loadConsultations={props.loadConsultations}
            onOpenConsultation={props.onOpenConsultation}
            actions={props.onOpenInbox ? [INBOX_PALETTE_ACTION, ...PALETTE_ACTIONS] : PALETTE_ACTIONS}
            onAction={id => {
              if (id === 'tidiedTabs') props.tidying.openList()
              else if (id === RECORDS_TABLE_PALETTE_ACTION.id) props.onShowRecordsTable()
              else if (id === INBOX_PALETTE_ACTION.id) props.onOpenInbox?.()
            }}
          />
        )}

        {/* 「仕事の道具をつなぐ」: opens by itself only when something is new (settings has it too) */}
        {companyId && <ConnectToolsScreen key={companyId} companyId={companyId} firstRun />}

        {/* Settings Panel Modal */}
        {showSettings && (
          <SettingsPanel
            key={settingsFocus?.at ?? 'settings'}
            onClose={onCloseSettings}
            {...(settingsFocus ? { initialTab: settingsFocus.tab ?? 'ownkeys', focusService: settingsFocus.service } : {})}
            mineRows={<>{props.todayFolderSetting}<TidyTabsSetting on={props.tidying.dailyOn} onChange={props.tidying.setDailyTidy} /></>}
          />
        )}

        {/* Backup History Slide Over */}
        <BackupHistorySlideOver
          isOpen={showBackupHistory}
          onClose={() => setShowBackupHistory(false)}
          rootPath={rootPath}
        />

        {/* Tool Viewer */}
        {skillsTab.activeTool && (
          <div className="fixed inset-0 z-dialog bg-scrim flex items-center justify-center p-8">
            <div className="w-full h-full max-w-6xl max-h-[90vh] rounded-card overflow-hidden shadow-dialog">
              <ToolViewer
                tool={skillsTab.activeTool.tool}
                port={skillsTab.activeTool.port}
                color={selectedDept?.color || '#6366f1'}
                onClose={() => skillsTab.setActiveTool(null)}
              />
            </div>
          </div>
        )}

        {/* Sync Preview Dialog */}
        {sync.previewData && (
          <SyncPreviewDialog
            isOpen={sync.showPreview}
            onClose={() => sync.setShowPreview(false)}
            changes={sync.previewData.changes}
            totalCount={sync.previewData.totalCount}
            summary={sync.previewData.summary}
            isLoadingSummary={sync.isLoadingSummary}
            onRequestSummary={sync.handleRequestSummary}
            rootPath={rootPath}
            onSync={(commitMessage) => { sync.setShowPreview(false); sync.handleSync(commitMessage) }}
            isSyncing={sync.isSyncing}
            onRevertFile={sync.handleRevertFile}
            commitMessage={sync.commitMemo}
            onCommitMessageChange={sync.setCommitMemo}
          />
        )}

        {sync.syncNotification && (
          <SyncNotification
            notice={sync.syncNotification}
            onDismiss={() => sync.setSyncNotification(null)}
            onShowBackups={() => { setShowBackupHistory(true); sync.setSyncNotification(null) }}
          />
        )}
    </>
  )
}
