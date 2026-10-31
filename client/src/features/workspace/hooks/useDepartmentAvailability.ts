import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DepartmentConfig } from '../../../types'
import { folderExistsFor, rememberFolderExists, type FolderCheck } from '../../../shared/lib/folderExists'
import { departmentFolderExists } from '../api'

interface SparseState {
  enabled: boolean
  excludedPaths: string[]
  isCheckedOut: (folderPath: string) => boolean
}

/**
 * Which departments are not on this computer: the ones left out of the
 * download (shown muted on the department tabs), and whether the selected one
 * needs the download prompt (left out, or its folder missing on disk).
 */
export function useDepartmentAvailability(
  rootPath: string | undefined,
  departments: DepartmentConfig[],
  selectedDept: DepartmentConfig | undefined,
  isCompanyWide: boolean,
  sparseCheckout: SparseState,
) {
  const { enabled, excludedPaths, isCheckedOut } = sparseCheckout
  // Compute which department folders are not checked out (sparse checkout)
  const unsyncedFolders = useMemo(() => {
    if (!enabled) return undefined
    const set = new Set<string>()
    for (const dept of departments) {
      if (!isCheckedOut(dept.folder)) {
        set.add(dept.folder)
      }
    }
    return set.size > 0 ? set : undefined
  }, [enabled, isCheckedOut, departments])

  // Check if the currently selected department folder exists on disk. The
  // answer is keyed by folder: an answer for the previous department never
  // applies to this one (that flashed the download prompt and remounted the
  // file tree on every switch), and answers are remembered per folder.
  const deptPathForCheck = rootPath && selectedDept?.folder && !isCompanyWide
    ? `${rootPath}/${selectedDept.folder}`
    : null
  const [folderCheck, setFolderCheck] = useState<FolderCheck | null>(null)
  useEffect(() => {
    if (!deptPathForCheck) return
    let cancelled = false
    const record = (exists: boolean) => {
      rememberFolderExists(deptPathForCheck, exists)
      if (!cancelled) setFolderCheck({ path: deptPathForCheck, exists })
    }
    departmentFolderExists(deptPathForCheck)
      .then((exists: boolean) => record(exists))
      .catch(() => record(false))
    return () => { cancelled = true }
  }, [deptPathForCheck, excludedPaths])
  const deptFolderExists = folderExistsFor(folderCheck, deptPathForCheck)

  // Department is unsynced if sparse checkout says so OR if the folder doesn't exist
  const isSelectedDeptUnsynced = useMemo(() => {
    if (!selectedDept || isCompanyWide) return false
    // If folder doesn't exist on disk, it's unsynced regardless of sparse checkout state
    if (!deptFolderExists) return true
    // Also check sparse checkout state
    if (!unsyncedFolders) return false
    return unsyncedFolders.has(selectedDept.folder)
  }, [selectedDept, isCompanyWide, deptFolderExists, unsyncedFolders])

  /** A department was just downloaded: its folder exists now, without waiting for a check. */
  const markDownloaded = useCallback((folder: string) => {
    if (!rootPath) return
    const deptPath = `${rootPath}/${folder}`
    rememberFolderExists(deptPath, true)
    setFolderCheck({ path: deptPath, exists: true })
  }, [rootPath])

  return { unsyncedFolders, isSelectedDeptUnsynced, markDownloaded }
}
