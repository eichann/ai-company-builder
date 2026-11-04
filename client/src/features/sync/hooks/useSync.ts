import { useCallback, useEffect, useRef, useState } from 'react'
import { previewSync, revertChange, summarizeChanges, syncCompany } from '../api'
import { syncNoticeFor, syncNoticeHidesItself, type SyncNotice } from '../model'
import { afterSync, recordRun } from '../autoSyncSchedule'
import { updateAutoSyncState } from '../autoSyncState'
import { keepNotice, keptNotice, type NoticeOwner } from '../lastingNotice'

const REVERT_FAILED = '元に戻せませんでした。もう一度試してください。'

export interface SyncPreview {
  changes: { added: string[]; modified: string[]; deleted: string[] }
  totalCount: number
  summary?: string | null
}

interface Options {
  rootPath: string | undefined
  companyId: string | undefined
  /** The signed-in account: a kept notice is theirs alone. */
  userId: string | undefined
  /** After a successful sync, before the notice: reload what teammates may have changed. */
  onSynced: () => Promise<void>
}

/** 「サーバーと同期」, 「変更を確認」 (the preview, its AI summary, undoing one change) and the notice after a sync. */
export function useSync({ rootPath, companyId, userId, onSynced }: Options) {
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncNotification, showNotification] = useState<SyncNotice | null>(null)
  // A notice about moved work outlives the window (lastingNotice.ts).
  const ownerOf = useCallback((company: string | undefined): NoticeOwner | null => (
    company && userId ? { userId, companyId: company } : null
  ), [userId])
  /** For a notice of a company no longer on the screen. */
  const keepNoticeFor = useCallback((company: string, notice: SyncNotice) => {
    const owner = ownerOf(company)
    if (owner) keepNotice(owner, notice)
  }, [ownerOf])
  // A sync outlives a switch of company: its notice is kept for its company, not shown over another.
  const companyOnScreen = useRef(companyId)
  companyOnScreen.current = companyId
  const setSyncNotification = useCallback((notice: SyncNotice | null) => {
    const owner = ownerOf(companyId)
    const shown = owner ? keepNotice(owner, notice) : notice
    if (companyOnScreen.current === companyId) showNotification(shown)
  }, [companyId, ownerOf])
  useEffect(() => {
    const owner = ownerOf(companyId)
    showNotification(owner ? keptNotice(owner) : null)
  }, [companyId, ownerOf])

  const [showPreview, setShowPreview] = useState(false)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [isLoadingSummary, setIsLoadingSummary] = useState(false)
  const [previewData, setPreviewData] = useState<SyncPreview | null>(null)
  // The preview's 作業メモ: kept until a sync succeeds (a failed one must not lose it).
  const [commitMemo, setCommitMemo] = useState('')

  const handlePreview = useCallback(async () => {
    if (!rootPath) return
    setIsLoadingPreview(true)
    try {
      const result = await previewSync(rootPath)
      if (!result.success) {
        setSyncNotification({ type: 'error', message: result.error || 'プレビューに失敗しました' })
        return
      }
      if (!result.hasChanges) {
        setSyncNotification({ type: 'success', message: '変更はありません' })
        setTimeout(() => setSyncNotification(null), 3000)
        return
      }
      setPreviewData({ changes: result.changes, totalCount: result.totalCount, summary: null })
      setShowPreview(true)
    } catch (error) {
      console.error('Preview failed:', error)
      setSyncNotification({ type: 'error', message: 'プレビューに失敗しました' })
    } finally {
      setIsLoadingPreview(false)
    }
  }, [rootPath, setSyncNotification])

  const handleRequestSummary = useCallback(async () => {
    if (!rootPath) return
    setIsLoadingSummary(true)
    try {
      const result = await summarizeChanges(rootPath)
      if (result.success && result.summary) {
        setPreviewData(prev => prev ? { ...prev, summary: result.summary } : prev)
      }
    } catch {
      // Summary generation failed — not critical
    } finally {
      setIsLoadingSummary(false)
    }
  }, [rootPath])

  const handleSync = useCallback(async (customCommitMessage?: string) => {
    if (!rootPath || !companyId) return

    setIsSyncing(true)
    setSyncNotification(null)

    try {
      const result = await syncCompany(
        rootPath,
        companyId,
        customCommitMessage || 'Sync from AI Company Builder'
      )
      // Before anything slow: the window may be closing, waiting only for this sync.
      const notice = syncNoticeFor(result)
      if (!syncNoticeHidesItself(result)) keepNoticeFor(companyId, notice)
      if (result.success) {
        setCommitMemo('')
        await onSynced()
      }
      // A manual sync also restarts 「自動で送る」's clock and lifts an automatic stop it resolved.
      updateAutoSyncState(companyId, s => {
        const next = afterSync(s, result, { manual: true }).state
        return result.success ? recordRun(next, 'send', 'ran', Date.now()) : next
      })
      setSyncNotification(notice)
      if (syncNoticeHidesItself(result)) {
        setTimeout(() => setSyncNotification(null), 3000)
      }
    } catch (error) {
      console.error('Sync failed:', error)
      setSyncNotification({
        type: 'error',
        message: error instanceof Error ? error.message : '同期に失敗しました'
      })
    } finally {
      setIsSyncing(false)
    }
  }, [rootPath, companyId, onSynced, setSyncNotification, keepNoticeFor])

  /** 「元に戻す」 one change; answers why it was not undone, or null. */
  const handleRevertFile = useCallback(async (filePath: string, fileStatus: 'added' | 'modified' | 'deleted'): Promise<string | null> => {
    if (!rootPath) return REVERT_FAILED
    const reverted = await revertChange(rootPath, filePath, fileStatus).catch(() => ({ success: false, error: undefined }))
    // Refresh the list either way: a failed undo may still have changed something.
    const result = await previewSync(rootPath).catch(() => null)
    if (result?.success) {
      if (result.totalCount === 0) {
        setShowPreview(false)
        setPreviewData(null)
      } else {
        setPreviewData(prev => ({ ...result, summary: prev?.summary ?? null }))
      }
    }
    if (reverted.success) return null
    // Main's own refusals are sentences for the member; a raw git error is not.
    return reverted.error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(reverted.error) ? reverted.error : REVERT_FAILED
  }, [rootPath])

  return {
    isSyncing, setIsSyncing, syncNotification, setSyncNotification, keepNoticeFor, handleSync,
    showPreview, setShowPreview, isLoadingPreview, isLoadingSummary, previewData,
    handlePreview, handleRequestSummary, handleRevertFile,
    commitMemo, setCommitMemo,
  }
}
