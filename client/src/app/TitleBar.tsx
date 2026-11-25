import { useState, type ReactNode } from 'react'
import { ArrowCounterClockwise, CaretDown, ClockCounterClockwise, CloudArrowUp, GearSix, Globe, House, ListChecks, Moon, Question, SignOut, SpinnerGap, Sun, WarningCircle } from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { WORKING_FOLDER_BACKUP_NOTE, WORKING_FOLDER_NOTE } from '../../shared/company-folder'
import { useDismiss } from '../shared/hooks/useDismiss'
import { STOP_ICON } from '../shared/ui/stateStyles'

interface Props {
  companyName: string | undefined
  isLoadingPreview: boolean
  isSyncing: boolean
  /** The sync button's tooltip (with the last automatic sync); its lines after the first show in the sync menu. */
  syncTitle?: string
  /** Automatic sync stopped until the member syncs by hand: the button in the warning colour with a mark. */
  syncWaitsForYou?: boolean
  /** False for a company without the shared company folder: no sync, preview or backups (one short note instead). */
  sharedFolder?: boolean
  onPreview: () => void
  onSync: () => void
  onShowBackups: () => void
  onShowSettings: () => void
  /** 「使い方」: the user manual in the middle (absent: no button). */
  onShowManual?: () => void
  /** Sign out (saves the open tabs first: AppShell). */
  onLogout: () => void
  /** 「画面をいつもの形に戻す」 in the member's menu (absent: not offered). */
  onResetLayout?: () => void
  /** The one ［受け箱］ (features/inbox, I2: where 「あなたの番 N」 and the bell were), drawn by the core app only. */
  inbox?: ReactNode
  /** The company's name as a menu to switch companies (features/company), drawn instead of the plain name. */
  companySwitcher?: ReactNode
  /** Show / hide the left column and the consultation (features/workspace). */
  layoutControls?: ReactNode
}

const ICON_BUTTON = 'p-2 rounded-control text-text-muted hover:bg-surface-sunken hover:text-text transition-colors'
const MENU = 'absolute right-0 top-full z-menu mt-1 rounded-control border border-[color:var(--color-border)] bg-surface-raised p-1 shadow-pop'
const MENU_ITEM = 'flex w-full items-center gap-2 rounded-small px-2 py-1.5 text-left text-small text-text hover:bg-surface-sunken focus-visible:bg-surface-sunken disabled:opacity-disabled'
const DIVIDER = <div className="mx-1 h-4 w-px bg-border-strong" />

/**
 * The window's title bar (draggable), tidied (owner decision 2026-11-26, 依頼2):
 * ［受け箱］［同期 ▾］｜［左の欄］［AIチャット］｜［?］［あなたの丸 ▾］. Sign-out, light / dark and the
 * language are never on the bar itself (owner): they are in the member's menu.
 */
export function TitleBar({ companyName, isLoadingPreview, isSyncing, syncTitle = 'サーバーと同期', syncWaitsForYou = false, sharedFolder = true, onPreview, onSync, onShowBackups, onShowSettings, onShowManual, onLogout, onResetLayout, inbox, companySwitcher, layoutControls }: Props) {
  const hasCompany = useAppStore((s) => s.currentCompany) != null
  // The tooltip's first line is the button's name; the rest (last automatic sync, why it waits) goes in the menu.
  const syncStatus = syncTitle.split('\n').slice(1).join('\n')

  return (
    <header className="flex-shrink-0 h-12 flex items-center justify-between pl-20 pr-4 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 app-drag">
      {companySwitcher ? <div className="app-no-drag">{companySwitcher}</div> : (
      <div className="flex items-center gap-3 app-no-drag">
        <House size={18} className="text-text-muted" />
        <span className="text-sm font-medium text-gray-700 dark:text-zinc-200">
          {companyName || 'AI Company Builder'}
        </span>
      </div>
      )}
      <div className="flex items-center gap-1 app-no-drag">
        {inbox}
        {!sharedFolder && <WorkingFolderNote />}
        {sharedFolder && (
          <div className="flex items-center">
            <button
              onClick={onSync}
              disabled={isSyncing || !hasCompany}
              className={`${ICON_BUTTON} relative disabled:opacity-disabled`}
              title={syncTitle}
              aria-label={syncWaitsForYou ? 'サーバーと同期（自動同期は止まっています）' : 'サーバーと同期'}
              data-sync-waits={syncWaitsForYou ? 'true' : undefined}
            >
              {isSyncing ? (
                <SpinnerGap size={18} className="animate-spin" />
              ) : syncWaitsForYou ? (
                <>
                  <CloudArrowUp size={18} className={STOP_ICON.needsAction} />
                  <WarningCircle size={10} weight="fill" aria-hidden className={`absolute right-1 top-1 ${STOP_ICON.needsAction}`} />
                </>
              ) : (
                <CloudArrowUp size={18} />
              )}
            </button>
            <TitleMenu label="同期のほかの操作" width="w-64"
              trigger={isLoadingPreview ? <SpinnerGap size={10} className="animate-spin" /> : <CaretDown size={10} />}
              triggerClassName="flex h-8 w-4 items-center justify-center rounded-control text-text-subtle hover:bg-surface-sunken hover:text-text">
              {close => <>
                <button type="button" role="menuitem" className={MENU_ITEM} disabled={isLoadingPreview || !hasCompany}
                  onClick={() => { close(); onPreview() }}>
                  <ListChecks size={16} className="text-text-muted" />変更を確認してから同期
                </button>
                {syncStatus && <p className="whitespace-pre-line px-2 pb-1 pt-0.5 text-caption text-text-subtle">{syncStatus}</p>}
              </>}
            </TitleMenu>
          </div>
        )}
        {layoutControls && <>{DIVIDER}{layoutControls}</>}
        {DIVIDER}
        {onShowManual && (
        <button onClick={onShowManual} className={ICON_BUTTON} title="使い方" aria-label="使い方">
          <Question size={18} />
        </button>
        )}
        <MemberMenu sharedFolder={sharedFolder} hasCompany={hasCompany} companyName={companyName}
          onShowSettings={onShowSettings} onShowBackups={onShowBackups} onResetLayout={onResetLayout} onLogout={onLogout} />
      </div>
    </header>
  )
}

/** The first letter of the member's name, else of their email (never empty). */
function initialOf(name: string | null | undefined, email: string | undefined): string {
  const from = name?.trim() || email?.trim() || ''
  return from ? Array.from(from)[0].toUpperCase() : '?'
}

/** あなたの丸: who is signed in, then 設定・バックアップ履歴・いつもの形 / 表示・言語 / ログアウト (last, apart). */
function MemberMenu({ sharedFolder, hasCompany, companyName, onShowSettings, onShowBackups, onResetLayout, onLogout }: {
  sharedFolder: boolean; hasCompany: boolean; companyName: string | undefined
  onShowSettings: () => void; onShowBackups: () => void; onResetLayout?: () => void; onLogout: () => void
}) {
  const user = useAuthStore((s) => s.user)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const who = user?.name?.trim() || user?.email || ''
  return (
    <TitleMenu label="あなたのメニュー" width="w-64"
      trigger={<span aria-hidden>{initialOf(user?.name, user?.email)}</span>}
      triggerClassName="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-selected-bg text-small font-strong text-selected-text hover:bg-selected-bg-hover">
      {close => <>
        {(who || companyName) && (
          <div className="border-b border-[color:var(--color-border)] px-2 pb-2 pt-1">
            {who && <p className="truncate text-small font-strong text-text">{who}</p>}
            {companyName && <p className="truncate text-caption text-text-subtle">{companyName}</p>}
          </div>
        )}
        <div className="py-1">
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => { close(); onShowSettings() }}>
            <GearSix size={16} className="text-text-muted" />設定
          </button>
          {sharedFolder && (
            <button type="button" role="menuitem" className={MENU_ITEM} disabled={!hasCompany} onClick={() => { close(); onShowBackups() }}>
              <ClockCounterClockwise size={16} className="text-text-muted" />バックアップ履歴
            </button>
          )}
          {onResetLayout && (
            <button type="button" role="menuitem" className={MENU_ITEM} title="大きさと表示を最初に戻す" onClick={() => { close(); onResetLayout() }}>
              <ArrowCounterClockwise size={16} className="text-text-muted" />画面をいつもの形に戻す
            </button>
          )}
        </div>
        {/* Switches: the menu stays open so the member sees the change. */}
        <div className="border-t border-[color:var(--color-border)] py-1">
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={toggleTheme}>
            {theme === 'dark' ? <Moon size={16} className="text-text-muted" /> : <Sun size={16} className="text-text-muted" />}
            <span className="flex-1">表示</span><span className="text-caption text-text-subtle">{theme === 'dark' ? 'ダーク' : 'ライト'}</span>
          </button>
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => setLanguage(language === 'ja' ? 'en' : 'ja')}>
            <Globe size={16} className="text-text-muted" />
            <span className="flex-1">言語</span><span className="text-caption text-text-subtle">{language === 'ja' ? '日本語' : 'English'}</span>
          </button>
        </div>
        <div className="border-t border-[color:var(--color-border)] pt-1">
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => { close(); onLogout() }}>
            <SignOut size={16} className="text-text-muted" />ログアウト
          </button>
        </div>
      </>}
    </TitleMenu>
  )
}

/** A title-bar button with its menu: Enter / Space open it (focus on the first item), Esc or a press outside closes it. */
function TitleMenu({ label, trigger, triggerClassName, width, children }: {
  label: string; trigger: ReactNode; triggerClassName: string; width: string; children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const close = () => setOpen(false)
  useDismiss(box, open, close)
  return (
    <div ref={setBox} className="relative">
      <button type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(o => !o)} className={triggerClassName}>
        {trigger}
      </button>
      {open && (
        <div role="menu" aria-label={label} className={`${MENU} ${width}`}
          ref={el => { el?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus() }}
          onKeyDown={e => {
            // Esc (closed by useDismiss) gives the focus back to the button; ↑ ↓ move between the items.
            if (e.key === 'Escape') box?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus()
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
            const at = items.indexOf(document.activeElement as HTMLElement)
            items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
          }}>
          {children(close)}
        </div>
      )}
    </div>
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
        <div role="note" data-working-folder-note className="absolute right-0 top-full z-50 mt-1 w-80 space-y-1 rounded-control border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-600 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <p>{WORKING_FOLDER_NOTE}</p>
          <p>{WORKING_FOLDER_BACKUP_NOTE}</p>
        </div>
      )}
    </div>
  )
}
