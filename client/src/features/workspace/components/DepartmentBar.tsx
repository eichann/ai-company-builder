import { useTranslation } from 'react-i18next'
import { Info } from '@phosphor-icons/react'
import { DepartmentTabs } from './DepartmentTabs'
import type { DepartmentConfig } from '../../../types'

interface Props {
  departments: DepartmentConfig[]
  isLoading: boolean
  selectedId: string
  onSelect: (id: string) => void
  /** Department folders not downloaded on this computer (muted tabs). */
  unsyncedFolders: Set<string> | undefined
  /** On 全社 while some department is not downloaded: say what that limits. */
  showNotDownloadedNote: boolean
  onOpenSettings: () => void
}

/** The department tabs under the title bar, and on 全社 the note that some are not downloaded. */
export function DepartmentBar({ departments, isLoading, selectedId, onSelect, unsyncedFolders, showNotDownloadedNote, onOpenSettings }: Props) {
  const { t } = useTranslation()
  return (
    <>
      <div className="flex-shrink-0 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        {isLoading ? (
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
            selectedId={selectedId}
            onSelect={onSelect}
            unsyncedFolders={unsyncedFolders}
          />
        )}
      </div>

      {showNotDownloadedNote && (
        <div className="flex-shrink-0 flex items-center gap-2 px-6 py-2 bg-indigo-50 dark:bg-indigo-950/30 border-b border-indigo-100 dark:border-indigo-900/50 text-sm text-indigo-700 dark:text-indigo-300">
          <Info size={16} className="flex-shrink-0" />
          <span>
            一部の部署がダウンロードされていません。ファイルツリーとAIチャットの対象はダウンロード済みの部署に限られます。
          </span>
          <button
            onClick={onOpenSettings}
            className="ml-auto text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"
          >
            設定で変更
          </button>
        </div>
      )}
    </>
  )
}
