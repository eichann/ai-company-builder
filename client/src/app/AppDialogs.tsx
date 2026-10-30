import type { Dispatch, SetStateAction } from 'react'
import { NewSkillWizard } from '../components/skill-ui/NewSkillWizard'
import { CopySkillModal } from '../components/skill-ui/CopySkillModal'
import { ToolViewer } from '../components/skill-ui/ToolViewer'
import { FileSearchModal } from '../components/skill-ui/FileSearchModal'
import { BackupHistorySlideOver } from '../components/skill-ui/BackupHistorySlideOver'
import { SettingsPanel } from '../components/settings'
import { SyncPreviewDialog } from '../components/common/SyncPreviewDialog'
import { SyncNotification } from '../features/sync/components/SyncNotification'
import type { useSkillsTab } from '../features/skills/hooks/useSkillsTab'
import type { useSync } from '../features/sync/hooks/useSync'
import type { DepartmentConfig } from '../types'

interface Props {
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
  showSettings: boolean
  onCloseSettings: () => void
  showBackupHistory: boolean
  setShowBackupHistory: Dispatch<SetStateAction<boolean>>
}

/** What opens over the main screen: skill dialogs, Cmd+P, settings, backups, a skill's tool, the sync preview and notice. */
export function AppDialogs(props: Props) {
  const { rootPath, departments, selectedDeptId, selectedDept, departmentFolder, unsyncedFolders, skillsTab, sync } = props
  const { showFileSearch, onCloseFileSearch, onFileSearchSelect, showSettings, onCloseSettings, showBackupHistory, setShowBackupHistory } = props
  return (
    <>
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

        {/* File Search Modal (Cmd+P) */}
        <FileSearchModal
          isOpen={showFileSearch}
          onClose={onCloseFileSearch}
          rootPath={rootPath}
          departmentFolder={departmentFolder}
          onSelectFile={onFileSearchSelect}
        />

        {/* Settings Panel Modal */}
        {showSettings && (
          <SettingsPanel onClose={onCloseSettings} />
        )}

        {/* Backup History Slide Over */}
        <BackupHistorySlideOver
          isOpen={showBackupHistory}
          onClose={() => setShowBackupHistory(false)}
          rootPath={rootPath}
        />

        {/* Tool Viewer */}
        {skillsTab.activeTool && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8">
            <div className="w-full h-full max-w-6xl max-h-[90vh] rounded-xl overflow-hidden shadow-2xl">
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
