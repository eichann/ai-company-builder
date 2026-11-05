import { useEffect, useRef, useSyncExternalStore } from 'react'
import { autoSync } from '../api'
import { autoSyncNoticeFor, receiveNoticeFor, type SyncNotice } from '../model'
import { afterSync, recordRun, runDueNow, syncButtonTitle } from '../autoSyncSchedule'
import { readAutoSyncState, updateAutoSyncState, useAutoSyncState } from '../autoSyncState'
import { autoSyncSettings } from '../../../shared/lib/autoSyncSettings'
import { hasUnsavedEdits } from '../../../shared/lib/unsavedEdits'

/** First look a minute after the company opens (at most one catch-up run), then every 30 s. */
const FIRST_CHECK_MS = 60_000
const CHECK_EVERY_MS = 30_000

interface Options {
  rootPath: string | undefined
  companyId: string | undefined
  /** A sync is running (the button's own state): never start another. */
  isSyncing: boolean
  setIsSyncing: (value: boolean) => void
  /** Show a notice the way a manual sync would. */
  showNotice: (notice: SyncNotice | null) => void
  /** Keep a notice of a company no longer on the screen until it is opened again. */
  keepNoticeFor: (companyId: string, notice: SyncNotice) => void
  /** Reload what teammates may have changed (departments, skills, history). */
  onSynced: () => Promise<void>
}

/**
 * 「自動で受け取る」 / 「自動で送る」 while the app is open (.claude/rules/sync.md
 * "Automatic sync"). When a run is due is autoSyncSchedule.ts; whether it may
 * run now is main's decision (`git:autoSync`), which skips silently.
 */
export function useAutoSync({ rootPath, companyId, isSyncing, setIsSyncing, showNotice, keepNoticeFor, onSynced }: Options) {
  const settings = useSyncExternalStore(autoSyncSettings.subscribe, autoSyncSettings.getSnapshot)
  const state = useAutoSyncState(companyId)

  // The tick reads the latest values without restarting its timer.
  const latest = useRef({ rootPath, companyId, isSyncing, setIsSyncing, showNotice, keepNoticeFor, onSynced })
  latest.current = { rootPath, companyId, isSyncing, setIsSyncing, showNotice, keepNoticeFor, onSynced }

  useEffect(() => {
    if (!rootPath || !companyId) return
    const startedAt = Date.now()
    let running = false
    let stopped = false
    // The open files 「受け取る」 last told the member about (said once per set).
    let openFilesShown: string | null = null

    const tick = async () => {
      const { rootPath: root, companyId: company, isSyncing: busy } = latest.current
      if (running || busy || !root || !company || company !== companyId) return
      const now = Date.now()
      const mode = runDueNow(autoSyncSettings.getSnapshot(), readAutoSyncState(company), now, startedAt)
      if (!mode) return
      running = true
      try {
        if (mode === 'send') latest.current.setIsSyncing(true)
        const answer = await autoSync(root, company, mode, {
          unsavedEdits: hasUnsavedEdits(),
          needsMember: readAutoSyncState(company).needsMember,
          offline: typeof navigator !== 'undefined' && navigator.onLine === false,
        })
        if (stopped) {
          // The member moved to another company while it ran: its notice waits for that company.
          const left = answer.status === 'sent' ? autoSyncNoticeFor(answer.result, false) : null
          if (left) latest.current.keepNoticeFor(company, left)
          return
        }
        if (answer.status === 'skipped') {
          updateAutoSyncState(company, s => recordRun(s, mode, 'skipped', now))
          return
        }
        if (answer.status === 'received') {
          updateAutoSyncState(company, s => ({ ...recordRun(s, 'receive', 'ran', now), lastAutoSyncAt: now }))
          const { notice, key } = receiveNoticeFor(answer.result, openFilesShown)
          openFilesShown = key
          if (notice) latest.current.showNotice(notice)
          if (answer.result.received > 0) await latest.current.onSynced()
          return
        }
        const result = answer.result
        let showFailure = false
        updateAutoSyncState(company, s => {
          const decided = afterSync(recordRun(s, 'send', 'ran', now), result, { manual: false })
          showFailure = decided.showFailure
          return result.success ? { ...decided.state, lastAutoSyncAt: now } : decided.state
        })
        // Before anything slow: the window may be closing, waiting only for this sync.
        const notice = autoSyncNoticeFor(result, showFailure)
        if (notice) latest.current.showNotice(notice)
        if (result.success) await latest.current.onSynced()
      } catch (error) {
        console.warn('[auto-sync] run failed:', error instanceof Error ? error.message : 'unknown')
        updateAutoSyncState(company, s => recordRun(s, mode, 'skipped', now))
      } finally {
        if (mode === 'send') latest.current.setIsSyncing(false)
        running = false
      }
    }

    let interval: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(() => {
      void tick()
      interval = setInterval(() => { void tick() }, CHECK_EVERY_MS)
    }, FIRST_CHECK_MS)
    return () => {
      stopped = true
      clearTimeout(first)
      if (interval) clearInterval(interval)
    }
  }, [rootPath, companyId])

  return { syncButtonTitle: syncButtonTitle(state, settings) }
}
