// Today's frame of the settings: a dialog with the left list (SettingsNav) and one section (SettingsSection).
// It holds the drafts that survive moving between sections (.env, .gitignore) and asks before anything
// typed would be lost; the sections know nothing of this frame.
import { useImperativeHandle, useState, type ReactNode, type Ref } from 'react'
import { Info, X } from '@phosphor-icons/react'
import { companyHasSharedFolder } from '../../../../shared/company-folder'
import { Dialog } from '../../../shared/ui/Dialog'
import { Callout } from '../../../shared/ui/primitives'
import { useAppStore } from '../../../stores/appStore'
import { useDepartments } from '../../../shared/hooks/useDepartments'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { AGENT_LOG_NOTICE_TEXT, SANDBOX_NOTICE_TEXT } from '../../../shared/lib/agentLogNotice'
import { useBrowserSites } from '../hooks/useBrowserSites'
import { useEnvDraft } from '../hooks/useEnvDraft'
import { useGitignoreDraft } from '../hooks/useGitignoreDraft'
import { KEPT_DRAFT_SECTIONS, sectionToOpen, settingsGroupsFor, shownSectionIds, type SettingsSectionId } from '../sections'
import { createSettingsUnsaved, type SettingsUnsavedAsk } from '../unsaved'
import type { UnsavedChanges } from '../../../shared/lib/unsavedChanges'
import { SettingsNav } from './SettingsNav'
import { SettingsSection } from './SettingsSection'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'

interface SettingsPanelProps {
  onClose: () => void
  /** Section to open first (default: AI に任せること). */
  initialTab?: SettingsSectionId
  /** 「Claude・Gemini などの鍵」: the service to show first (from the chat's "no key" card). */
  focusService?: string
  /** 「AI に任せること」's rows the screen composes (「今日のフォルダ」: it knows the departments on this PC; 「前の日のタブを自動で片づける」). */
  mineRows?: ReactNode
  /** Asks from outside what the settings have typed and not saved (every section), and saves it. */
  unsavedRef?: Ref<SettingsUnsavedAsk>
}

export function SettingsPanel({ onClose, initialTab, focusService, mineRows, unsavedRef }: SettingsPanelProps) {
  const { currentCompany } = useAppStore()
  const { departments } = useDepartments(currentCompany?.id)
  const browser = useBrowserSites(currentCompany?.id)
  const env = useEnvDraft(currentCompany?.rootPath ?? '')
  const gitignore = useGitignoreDraft(currentCompany?.id ?? '', currentCompany?.rootPath ?? '')
  const kept = useLatestRef<Partial<Record<SettingsSectionId, UnsavedChanges>>>({ envkeys: env.unsaved, gitignore: gitignore.unsaved })
  const [unsaved] = useState(() => createSettingsUnsaved(() => kept.current))
  const ctx = { sharedFolder: currentCompany ? companyHasSharedFolder(currentCompany) : false, browserSites: browser.sites.length > 0 }
  const [chosen, setActive] = useState<SettingsSectionId>(initialTab ?? 'mine')
  const active = sectionToOpen(chosen, ctx)
  const allIds = shownSectionIds(ctx)
  // Asked before closing (or leaving a section whose input would be dropped): what to do with what is unsaved.
  const [leaving, setLeaving] = useState<{ what: string[]; ids: SettingsSectionId[]; verb: string; then: () => void } | null>(null)
  const [leaveSaving, setLeaveSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useImperativeHandle(unsavedRef, () => ({ pending: () => unsaved.pending(allIds), save: () => unsaved.save(allIds) }))

  // Moving on drops only the open section's own input; the kept drafts are asked about at closing.
  const leave = (ids: SettingsSectionId[], verb: string, then: () => void) => {
    const what = unsaved.pending(ids)
    if (what.length === 0) then()
    else setLeaving({ what, ids, verb, then })
  }
  const close = () => leave(allIds, '閉じる', onClose)
  const choose = (id: SettingsSectionId) => leave(KEPT_DRAFT_SECTIONS.has(active) ? [] : [active], '移る', () => { setActive(id); setError(null) })
  const saveAndLeave = async () => {
    if (!leaving) return
    setLeaveSaving(true)
    setError(null)
    let failed: string | null
    try {
      failed = await unsaved.save(leaving.ids)
    } catch (e) {
      failed = e instanceof Error ? e.message : '保存に失敗しました'
    }
    setLeaveSaving(false)
    const then = leaving.then
    setLeaving(null)
    // Not saved: the settings stay open where the reason shows ('' = the section says it or asks itself).
    if (failed !== null) { if (failed) setError(failed); return }
    then()
  }

  if (!currentCompany) return null
  const unsavedIds = new Set<SettingsSectionId>([...(env.dirty ? ['envkeys' as const] : []), ...(gitignore.dirty ? ['gitignore' as const] : [])])

  return (
    // The shared frame (design-system.md, P2d): its surface, scrim and keys — Tab stays inside, Esc
    // closes and stops there, focus goes back to what opened it; a wide two-pane dialog of its own size.
    <Dialog onClose={close} label="設定" size="custom" padded={false}
      className="flex h-[min(760px,92vh)] max-w-[1040px] overflow-hidden">
      <nav ref={browser.loadRef} aria-label="設定の項目" className="flex w-60 shrink-0 flex-col border-r border-[color:var(--color-border)] bg-bg px-3 py-5">
        <div className="px-2.5 pb-4">
          <p className="text-title tracking-tight">設定</p>
          <p className="mt-0.5 truncate text-small text-text-subtle" title={currentCompany.rootPath}>{currentCompany.name}</p>
        </div>
        <SettingsNav groups={settingsGroupsFor(ctx)} active={active} unsavedIds={unsavedIds} onChoose={choose} />
        {/* Always shown, whatever section is open (owner decision: members are told). */}
        <p className="mt-auto flex shrink-0 gap-1.5 border-t border-[color:var(--color-border)] px-2.5 pt-3 text-caption font-normal leading-relaxed text-text-muted">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span><span className="block">{AGENT_LOG_NOTICE_TEXT}</span><span className="mt-1 block">{SANDBOX_NOTICE_TEXT}</span></span>
        </p>
      </nav>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={close}
          aria-label="閉じる"
          className="absolute right-4 top-4 z-10 rounded-control p-1.5 text-text-subtle transition-colors hover:bg-surface-sunken hover:text-text focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring"
        >
          <X size={18} />
        </button>
        {error && <div className="px-8 pt-7"><Callout tone="danger">{error}</Callout></div>}
        <div className="flex-1 overflow-y-auto">
          <SettingsSection
            id={active}
            company={currentCompany}
            departments={departments}
            unsaved={unsaved}
            env={env}
            gitignore={gitignore}
            browserSites={browser.sites}
            go={choose}
            focusService={focusService}
            mineRows={mineRows}
          />
        </div>
      </div>
      {leaving && (
        <UnsavedChangesDialog what={leaving.what} verb={leaving.verb} saving={leaveSaving}
          onSave={() => void saveAndLeave()} onDiscard={() => { const then = leaving.then; setLeaving(null); then() }} onBack={() => setLeaving(null)} />
      )}
    </Dialog>
  )
}
