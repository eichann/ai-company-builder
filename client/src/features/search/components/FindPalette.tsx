import { useCallback, useMemo, useRef, useState } from 'react'
import { Broom, MagnifyingGlass } from '@phosphor-icons/react'
import type { RecordViewSummary } from '../../../../shared/record-views'
import { CALM, THING_NAMES } from '../../../../shared/thing-words'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { RecordIcon, ThingIcon } from '../../../shared/ui/ThingIcon'
import { listCompanyFiles, searchRecords } from '../api'
import { paletteItems, type PaletteConsultation, type PaletteAction, type PaletteItem, type PaletteRecent, type PaletteSkill } from '../model'

interface Props {
  onClose: () => void
  rootPath: string
  /** Records are found company-wide (what the member may read); none without a company. */
  companyId?: string
  departmentFolder: string
  /** 「最近開いたもの」 while nothing is typed: the tabs open in the middle, newest first. */
  recent: PaletteRecent[]
  onSelectFile: (filePath: string) => void
  onOpenRecord: (recordId: string) => void
  /** The skills already loaded for the Skill tab (and slash commands): found by name, opened there. */
  skills?: readonly PaletteSkill[]
  onOpenSkill?: (skillId: string) => void
  /** 「AIへの相談」, read once when the window opens; one chosen opens in the chat. */
  loadConsultations?: () => Promise<PaletteConsultation[]>
  onOpenConsultation?: (sessionId: string) => void
  /** The screen's own lists found by name (「片づけたタブ」), opened by `onAction`. */
  actions?: readonly PaletteAction[]
  onAction?: (id: string) => void
}

/**
 * 探す ⌘K (Windows Ctrl+K; ⌘P too): open anything by its name — やること, 案件, 会議の記録,
 * Skill, AIへの相談, ファイル… — with the same icons as everywhere. Rendered only while open, so it starts empty.
 */
export function FindPalette({ onClose, rootPath, companyId, departmentFolder, recent, onSelectFile, onOpenRecord, skills, onOpenSkill, loadConsultations, onOpenConsultation, actions, onAction }: Props) {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [consultations, setConsultations] = useState<PaletteConsultation[]>([])
  const [records, setRecords] = useState<{ query: string; list: RecordViewSummary[] }>({ query: '', list: [] })
  const [at, setAt] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const prefix = departmentFolder ? departmentFolder + '/' : ''

  // The file names load when the window mounts (a callback ref: the renderer's effect count is capped).
  const loadRef = useCallback((el: HTMLInputElement | null) => {
    if (!el) return
    loadConsultations?.().then(setConsultations, () => {})
    if (!rootPath) return
    el.focus()
    listCompanyFiles(rootPath, departmentFolder).then(r => { if (r.success) setFiles(r.files) }).catch(() => {})
  }, [rootPath, departmentFolder, loadConsultations])
  useEventListener<KeyboardEvent>(document, 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); onClose() } })

  const type = (next: string) => {
    setQuery(next)
    setAt(0)
    if (timer.current) clearTimeout(timer.current)
    const q = next.trim()
    if (!q || !companyId) return
    // Asked of the server once typing pauses; only the newest answer is kept.
    const mine = ++seq.current
    timer.current = setTimeout(() => {
      searchRecords(companyId, q).then(r => {
        if (mine === seq.current && r.success && r.available) setRecords({ query: q, list: r.records })
      }).catch(() => {})
    }, 250)
  }

  const items = useMemo(
    () => paletteItems(query, files, records.query === query.trim() ? records.list : [], recent, { skills, consultations, actions }),
    [query, files, records, recent, skills, consultations, actions],
  )
  const pick = Math.min(at, Math.max(0, items.length - 1))
  const open = (i: PaletteItem | undefined) => {
    if (!i) return
    if (i.actionId) onAction?.(i.actionId)
    else if (i.recordId) onOpenRecord(i.recordId)
    else if (i.skillId) onOpenSkill?.(i.skillId)
    else if (i.consultationId) onOpenConsultation?.(i.consultationId)
    else if (i.path) onSelectFile(`${rootPath}/${i.path}`)
    onClose()
  }

  return (
    // A palette is drawn like a menu (design-system.md, P2d): the raised surface with its border and
    // the pop shadow, on the menus' layer, over the light `scrim-palette` veil (lighter than a
    // dialog's scrim; owner decision 2026-11-22). A click on the veil closes it.
    <div data-palette-backdrop className="fixed inset-0 z-menu flex items-start justify-center bg-scrim-palette pt-[14vh]" onClick={onClose}>
      <div role="dialog" aria-label="探す" className="w-full max-w-xl overflow-hidden rounded-card border border-[color:var(--color-border)] bg-surface-raised text-text shadow-pop" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-3">
          <MagnifyingGlass size={16} className="flex-shrink-0 text-text-subtle" />
          <input
            ref={loadRef}
            type="text"
            aria-label="名前で探す"
            value={query}
            onChange={e => type(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(pick + 1, items.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(pick - 1, 0)) }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); open(items[pick]) }
            }}
            placeholder="やること・案件・ファイルなどを名前で探す"
            className="flex-1 bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none"
          />
          <kbd className="rounded-small border border-[color:var(--color-border)] px-1.5 text-[10px] text-text-subtle">esc</kbd>
        </div>
        <div className="px-4 pb-1 pt-2 text-caption font-semibold text-text-subtle">{query.trim() ? `見つかったもの（${items.length}）` : '最近開いたもの'}</div>
        <ul role="listbox" aria-label="開くもの" className="max-h-[50vh] overflow-auto px-1.5 pb-1.5">
          {items.length === 0 && <li className="px-3 py-3 text-small text-text-subtle">{CALM.notFound}</li>}
          {items.map((i, n) => {
            const name = i.path ? i.path.split('/').pop() ?? i.path : i.title
            const FileIc = i.path ? getFileIcon(name, false) : null
            return (
              <li key={i.key} role="option" aria-selected={n === pick} onMouseEnter={() => setAt(n)} onClick={() => open(i)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-small px-2.5 py-1.5 ${n === pick ? 'bg-selected-bg' : 'hover:bg-surface-sunken'}`}>
                {FileIc ? <FileIc size={15} className="flex-shrink-0" /> : i.actionId ? <Broom size={15} className="flex-shrink-0 text-text-muted" /> : i.record ? <RecordIcon record={i.record} size={15} />
                  : <ThingIcon kind={i.skillId ? 'skill' : i.consultationId ? 'consultation' : 'other'} size={15} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small text-text">{name}</span>
                  {i.detail && <span className="block truncate text-caption font-normal text-text-muted">{i.detail}</span>}
                  {i.path && <span className="block truncate text-caption font-normal text-text-muted">{i.path.startsWith(prefix) ? i.path.slice(prefix.length) : i.path}</span>}
                </span>
                <span className="w-[96px] shrink-0 truncate pr-1 text-right text-caption font-normal text-text-subtle">{i.path ? THING_NAMES.file : i.kindName}</span>
              </li>
            )
          })}
        </ul>
        <div className="flex gap-3 border-t border-[color:var(--color-border)] px-4 py-1.5 text-caption font-normal text-text-subtle">
          <span>↑↓ で選ぶ</span><span>Enter で開く</span><span className="ml-auto">⌘K でいつでも</span>
        </div>
      </div>
    </div>
  )
}
