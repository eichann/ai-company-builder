import { useEffect, useRef, useState } from 'react'
import { fileExists } from '../api'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { looksOfOpenTabs, parseRecordLooks, recordIdOfTab, type RecordTabLook } from '../editorTabs'

// Per company, in localStorage under `editor:<company id>`: the open tabs (files
// and records, `editorTabs.ts`), the active one, the open records' titles and the left panel tab. The left tab lives in the same entry
// because existing installs saved it there. Any saved id is kept: the left
// panel's registry shows the default for an id no panel has (an extension's
// tab may register later).
const EDITOR_STATE_KEY_PREFIX = 'editor:'

type PersistedEditorState = {
  openFiles: string[]
  activeFilePath: string | null
  leftTab: string
  /** The open record tabs' titles and kinds, so they show at once after a restart. */
  records: Record<string, RecordTabLook>
  /** Tabs the member pinned (固定): 「タブを片づける」 leaves them open. */
  pinned: string[]
}

/** The tabs as restored for a company (files deleted meanwhile dropped). */
export interface RestoredTabs {
  openFiles: string[]
  pinned: string[]
  records: Record<string, RecordTabLook>
}

function safeReadEditorState(companyId: string, defaultLeftTab: string): PersistedEditorState | null {
  try {
    const raw = localStorage.getItem(`${EDITOR_STATE_KEY_PREFIX}${companyId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.openFiles)) return null
    return {
      openFiles: parsed.openFiles.filter((p: unknown): p is string => typeof p === 'string'),
      activeFilePath: typeof parsed.activeFilePath === 'string' ? parsed.activeFilePath : null,
      leftTab: typeof parsed.leftTab === 'string' && parsed.leftTab ? parsed.leftTab : defaultLeftTab,
      records: parseRecordLooks(parsed.records),
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.filter((p: unknown): p is string => typeof p === 'string') : [],
    }
  } catch {
    return null
  }
}

function safeWriteEditorState(companyId: string, state: PersistedEditorState): void {
  try {
    localStorage.setItem(`${EDITOR_STATE_KEY_PREFIX}${companyId}`, JSON.stringify(state))
  } catch {
    // Storage may be unavailable; fail silently.
  }
}

/**
 * The open tabs (files and records), the active tab and the left panel tab of the open
 * company, restored when the company opens and saved on every change. Tabs of
 * files deleted meanwhile are dropped in the background.
 */
export function useEditorPersistence(companyId: string | undefined, defaultLeftTab: string, onRestored?: (companyId: string, tabs: RestoredTabs) => void) {
  // Told once per company open, after the tabs are restored (the daily tidy, tidyTabs.ts).
  const onRestoredRef = useLatestRef(onRestored)
  // Synchronously hydrate editor state from localStorage during the first render
  // so the persisted tabs/sidebar are visible immediately — no empty→populated
  // flicker. Background file-existence validation happens in the effect below.
  const initialEditorState = useState(() =>
    companyId ? safeReadEditorState(companyId, defaultLeftTab) : null
  )[0]

  const [leftTab, setLeftTab] = useState<string>(() => initialEditorState?.leftTab ?? defaultLeftTab)
  const [openFiles, setOpenFiles] = useState<string[]>(() => initialEditorState?.openFiles ?? [])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(() => initialEditorState?.activeFilePath ?? null)
  const [recordLooks, setRecordLooks] = useState<Record<string, RecordTabLook>>(() => initialEditorState?.records ?? {})
  const [pinnedTabs, setPinnedTabs] = useState<string[]>(() => initialEditorState?.pinned ?? [])

  // editorRestoredForId tracks which company we've finished validating files for.
  // It gates the persist effect to prevent any transient cross-company state from
  // clobbering the stored entry while a company switch is mid-flight.
  const [editorRestoredForId, setEditorRestoredForId] = useState<string | null>(null)
  const isFirstEditorMountRef = useRef(true)
  useEffect(() => {
    if (!companyId) {
      setEditorRestoredForId(null)
      return
    }
    if (editorRestoredForId === companyId) return

    const targetCompanyId = companyId
    const persisted = safeReadEditorState(targetCompanyId, defaultLeftTab)
    const wasFirstMount = isFirstEditorMountRef.current
    isFirstEditorMountRef.current = false

    // On a cross-company switch, swap state immediately so the new company's
    // persisted view appears without showing the old one. On the very first
    // mount the useState initializers already loaded the right state, so
    // skipping these setters avoids a redundant re-render.
    if (!wasFirstMount) {
      setOpenFiles(persisted?.openFiles ?? [])
      setActiveFilePath(persisted?.activeFilePath ?? null)
      setLeftTab(persisted?.leftTab ?? defaultLeftTab)
      setRecordLooks(persisted?.records ?? {})
      setPinnedTabs(persisted?.pinned ?? [])
    }

    const restored = (openFiles: string[]) => {
      setEditorRestoredForId(targetCompanyId)
      onRestoredRef.current?.(targetCompanyId, { openFiles, pinned: persisted?.pinned ?? [], records: persisted?.records ?? {} })
    }
    if (!persisted || persisted.openFiles.length === 0) {
      restored([])
      return
    }
    let cancelled = false
    void (async () => {
      const checks = await Promise.all(
        // A record tab stays: the record itself says so when it can no longer be read.
        persisted.openFiles.map((p) => recordIdOfTab(p) ? Promise.resolve(true) : fileExists(p).catch(() => false))
      )
      if (cancelled) return
      const allValid = checks.every(Boolean)
      const validFiles = persisted.openFiles.filter((_, i) => checks[i])
      if (!allValid) {
        const active = validFiles.includes(persisted.activeFilePath ?? '')
          ? persisted.activeFilePath
          : (validFiles[validFiles.length - 1] ?? null)
        setOpenFiles(validFiles)
        setActiveFilePath(active)
      }
      restored(validFiles)
    })()
    return () => { cancelled = true }
  }, [companyId, editorRestoredForId, defaultLeftTab, onRestoredRef])

  // Persist editor state whenever it changes. Gated on restoration having
  // completed for this company so the initial empty state can't clobber a
  // previously stored entry on the same render.
  useEffect(() => {
    if (!companyId || editorRestoredForId !== companyId) return
    safeWriteEditorState(companyId, {
      openFiles,
      activeFilePath,
      leftTab,
      records: looksOfOpenTabs(openFiles, recordLooks),
      // A pinned tab that was closed is no longer pinned.
      pinned: pinnedTabs.filter(k => openFiles.includes(k)),
    })
  }, [companyId, editorRestoredForId, openFiles, activeFilePath, leftTab, recordLooks, pinnedTabs])

  return { openFiles, setOpenFiles, activeFilePath, setActiveFilePath, leftTab, setLeftTab, recordLooks, setRecordLooks, pinnedTabs, setPinnedTabs }
}
