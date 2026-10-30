import { useEffect, useRef, useState } from 'react'
import { fileExists } from '../api'

// Per company, in localStorage under `editor:<company id>`: the open file tabs,
// the active one, and the left panel tab. The left tab lives in the same entry
// because existing installs saved it there; the caller says which ids are valid.
const EDITOR_STATE_KEY_PREFIX = 'editor:'

type PersistedEditorState<Tab extends string> = {
  openFiles: string[]
  activeFilePath: string | null
  leftTab: Tab
}

export interface LeftTabChoice<Tab extends string> {
  /** Ids the screen can show; a saved id not in the list opens `fallback`. */
  valid: ReadonlyArray<Tab>
  fallback: Tab
}

function safeReadEditorState<Tab extends string>(companyId: string, tabs: LeftTabChoice<Tab>): PersistedEditorState<Tab> | null {
  try {
    const raw = localStorage.getItem(`${EDITOR_STATE_KEY_PREFIX}${companyId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.openFiles)) return null
    return {
      openFiles: parsed.openFiles.filter((p: unknown): p is string => typeof p === 'string'),
      activeFilePath: typeof parsed.activeFilePath === 'string' ? parsed.activeFilePath : null,
      leftTab: tabs.valid.includes(parsed.leftTab) ? parsed.leftTab : tabs.fallback,
    }
  } catch {
    return null
  }
}

function safeWriteEditorState<Tab extends string>(companyId: string, state: PersistedEditorState<Tab>): void {
  try {
    localStorage.setItem(`${EDITOR_STATE_KEY_PREFIX}${companyId}`, JSON.stringify(state))
  } catch {
    // Storage may be unavailable; fail silently.
  }
}

/**
 * The open file tabs, the active tab and the left panel tab of the open
 * company, restored when the company opens and saved on every change. Tabs of
 * files deleted meanwhile are dropped in the background.
 */
export function useEditorPersistence<Tab extends string>(companyId: string | undefined, leftTabs: LeftTabChoice<Tab>) {
  // The left tabs are fixed for the screen's lifetime.
  const [tabs] = useState(leftTabs)
  // Synchronously hydrate editor state from localStorage during the first render
  // so the persisted tabs/sidebar are visible immediately — no empty→populated
  // flicker. Background file-existence validation happens in the effect below.
  const initialEditorState = useState(() =>
    companyId ? safeReadEditorState(companyId, tabs) : null
  )[0]

  const [leftTab, setLeftTab] = useState<Tab>(() => initialEditorState?.leftTab ?? tabs.fallback)
  const [openFiles, setOpenFiles] = useState<string[]>(() => initialEditorState?.openFiles ?? [])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(() => initialEditorState?.activeFilePath ?? null)

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
    const persisted = safeReadEditorState(targetCompanyId, tabs)
    const wasFirstMount = isFirstEditorMountRef.current
    isFirstEditorMountRef.current = false

    // On a cross-company switch, swap state immediately so the new company's
    // persisted view appears without showing the old one. On the very first
    // mount the useState initializers already loaded the right state, so
    // skipping these setters avoids a redundant re-render.
    if (!wasFirstMount) {
      setOpenFiles(persisted?.openFiles ?? [])
      setActiveFilePath(persisted?.activeFilePath ?? null)
      setLeftTab(persisted?.leftTab ?? tabs.fallback)
    }

    if (!persisted || persisted.openFiles.length === 0) {
      setEditorRestoredForId(targetCompanyId)
      return
    }
    let cancelled = false
    void (async () => {
      const checks = await Promise.all(
        persisted.openFiles.map((p) => fileExists(p).catch(() => false))
      )
      if (cancelled) return
      const allValid = checks.every(Boolean)
      if (!allValid) {
        const validFiles = persisted.openFiles.filter((_, i) => checks[i])
        const active = validFiles.includes(persisted.activeFilePath ?? '')
          ? persisted.activeFilePath
          : (validFiles[validFiles.length - 1] ?? null)
        setOpenFiles(validFiles)
        setActiveFilePath(active)
      }
      setEditorRestoredForId(targetCompanyId)
    })()
    return () => { cancelled = true }
  }, [companyId, editorRestoredForId, tabs])

  // Persist editor state whenever it changes. Gated on restoration having
  // completed for this company so the initial empty state can't clobber a
  // previously stored entry on the same render.
  useEffect(() => {
    if (!companyId || editorRestoredForId !== companyId) return
    safeWriteEditorState(companyId, {
      openFiles,
      activeFilePath,
      leftTab,
    })
  }, [companyId, editorRestoredForId, openFiles, activeFilePath, leftTab])

  return { openFiles, setOpenFiles, activeFilePath, setActiveFilePath, leftTab, setLeftTab }
}
