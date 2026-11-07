import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ClockCounterClockwise, CloudArrowUp, GearSix, Globe, House, ListChecks, Moon, SignOut, SpinnerGap, Sun } from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import { WORKING_FOLDER_BACKUP_NOTE, WORKING_FOLDER_NOTE } from '../../shared/company-folder'
import { useDismiss } from '../shared/hooks/useDismiss'

interface Props {
  companyName: string | undefined
  isLoadingPreview: boolean
  isSyncing: boolean
  /** The sync button's tooltip (with the last automatic sync). */
  syncTitle?: string
  /** False for a company without the shared company folder: no sync, preview or backups (one short note instead). */
  sharedFolder?: boolean
  onPreview: () => void
  onSync: () => void
  onShowBackups: () => void
  onShowSettings: () => void
  /** Sign out (saves the open tabs first: AppShell). */
  onLogout: () => void
  /** A feature's button next to sync (「議事録を確かめる」 while Google may read minutes). */
  extra?: ReactNode
  /** 「あなたの番 N」 and the bell (features/notifications), drawn by the core app only. */
  notices?: ReactNode
}

const ICON_BUTTON = 'p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors'

/** The window's title bar (draggable): the company, 変更を確認 / 同期, backups, language, theme, settings, sign-out. */
export function TitleBar({ companyName, isLoadingPreview, isSyncing, syncTitle = 'サーバーと同期', sharedFolder = true, onPreview, onSync, onShowBackups, onShowSettings, onLogout, extra, notices }: Props) {
  const { t } = useTranslation()
  const hasCompany = useAppStore((s) => s.currentCompany) != null
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)

  const toggleLanguage = useCallback(() => {
    setLanguage(language === 'ja' ? 'en' : 'ja')
  }, [language, setLanguage])

  return (
    <header className="flex-shrink-0 h-12 flex items-center justify-between pl-20 pr-4 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 app-drag">
      <div className="flex items-center gap-3 app-no-drag">
        <House size={18} className="text-gray-500 dark:text-zinc-400" />
        <span className="text-sm font-medium text-gray-700 dark:text-zinc-200">
          {companyName || 'AI Company Builder'}
        </span>
      </div>
      <div className="flex items-center gap-2 app-no-drag">
        {notices}
        {!sharedFolder && <WorkingFolderNote />}
        {sharedFolder && <>
        <button
          onClick={onPreview}
          disabled={isLoadingPreview || !hasCompany}
          className={`${ICON_BUTTON} disabled:opacity-50`}
          title="変更を確認"
        >
          {isLoadingPreview ? (
            <SpinnerGap size={18} className="animate-spin" />
          ) : (
            <ListChecks size={18} />
          )}
        </button>
        <button
          onClick={onSync}
          disabled={isSyncing || !hasCompany}
          className={`${ICON_BUTTON} disabled:opacity-50`}
          title={syncTitle}
          aria-label="サーバーと同期"
        >
          {isSyncing ? (
            <SpinnerGap size={18} className="animate-spin" />
          ) : (
            <CloudArrowUp size={18} />
          )}
        </button>
        </>}
        {extra}
        <div className="w-px h-4 bg-gray-200 dark:bg-zinc-700" />
        {sharedFolder && (
        <button
          onClick={onShowBackups}
          disabled={!hasCompany}
          className={`${ICON_BUTTON} disabled:opacity-50`}
          title="バックアップ履歴"
        >
          <ClockCounterClockwise size={18} />
        </button>
        )}
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
          className={ICON_BUTTON}
          title={theme === 'dark' ? t('header.lightMode') : t('header.darkMode')}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button
          onClick={onShowSettings}
          className={ICON_BUTTON}
          title={t('header.settings')}
        >
          <GearSix size={18} />
        </button>
        <button
          onClick={onLogout}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-red-500 transition-colors"
          title={t('header.logout')}
        >
          <SignOut size={18} />
        </button>
      </div>
    </header>
  )
}

/** 「この PC だけで作業」 (a company without the shared folder): pressed, it says where files are kept and to back them up. */
function WorkingFolderNote() {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  useDismiss(box, open, () => setOpen(false))
  return (
    <div ref={setBox} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} title={WORKING_FOLDER_NOTE}
        className="px-2 py-1 rounded-md text-xs text-gray-500 dark:text-zinc-400 bg-gray-100 dark:bg-zinc-800 hover:text-gray-700 dark:hover:text-zinc-200">
        この PC だけで作業
      </button>
      {open && (
        <div role="note" data-working-folder-note className="absolute right-0 top-full z-50 mt-1 w-80 space-y-1 rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-600 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <p>{WORKING_FOLDER_NOTE}</p>
          <p>{WORKING_FOLDER_BACKUP_NOTE}</p>
        </div>
      )}
    </div>
  )
}
