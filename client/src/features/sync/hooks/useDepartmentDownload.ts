import { useCallback, useEffect, useState } from 'react'
import type { ApplyResult } from '../../../shared/hooks/useSparseCheckout'

export interface DownloadError { offline: boolean; message: string }

interface Options {
  /** The selected department's folder (the one the prompt offers to download). */
  folder: string | undefined
  excludedPaths: string[]
  apply: (excluded: string[]) => Promise<ApplyResult>
  onDownloaded: (folder: string) => void
}

/** 「ダウンロードして同期を開始」 for one department: downloads it and says why when it could not. */
export function useDepartmentDownload({ folder, excludedPaths, apply, onDownloaded }: Options) {
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<DownloadError | null>(null)

  const download = useCallback(async () => {
    if (!folder) return
    setIsDownloading(true)
    setDownloadError(null)
    try {
      const result = await apply(excludedPaths.filter(p => p !== folder))
      if (result.success) {
        onDownloaded(folder)
      } else {
        // Say why instead of silently showing the button again.
        setDownloadError({ offline: !!result.offline, message: result.error || 'ダウンロードできませんでした' })
      }
    } catch (err) {
      setDownloadError({ offline: false, message: err instanceof Error ? err.message : 'ダウンロードできませんでした' })
    } finally {
      setIsDownloading(false)
    }
  }, [folder, excludedPaths, apply, onDownloaded])
  // Another department's prompt starts without the previous error.
  useEffect(() => { setDownloadError(null) }, [folder])

  return { isDownloading, downloadError, download }
}
