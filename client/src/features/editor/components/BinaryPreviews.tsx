import React, { useEffect, useState } from 'react'
import { Warning } from '@phosphor-icons/react'
import { useFileVersion } from '../../../lib/fileVersions'
import { localFileUrl } from '../../../../shared/local-file-url'
import { readFileBinary } from '../api'

/**
 * An image from the company folder. Its `local-file://` URL carries the
 * file's version (bumped by every watcher event for it), so a file rewritten
 * or replaced under the same name shows at once instead of the cached copy.
 */
export function LocalImage({ filePath, alt, className, ...rest }: { filePath: string } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const version = useFileVersion(filePath)
  const src = localFileUrl(filePath, version)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (failedSrc === src) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-gray-400 dark:text-zinc-500" role="img" aria-label={alt}>
        <Warning size={14} />
        画像を表示できません（削除されたか、読み込めません）
      </span>
    )
  }
  return <img {...rest} src={src} alt={alt} className={className} onError={() => setFailedSrc(src)} />
}

export function PdfPreview({ filePath }: { filePath: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  // Re-read when the file changes on disk (same name, new content).
  const version = useFileVersion(filePath)

  useEffect(() => {
    let blobUrl: string | null = null
    let cancelled = false

    readFileBinary(filePath).then(buffer => {
      if (cancelled) return
      if (buffer) {
        const blob = new Blob([buffer], { type: 'application/pdf' })
        blobUrl = URL.createObjectURL(blob)
        setUrl(blobUrl)
        setMissing(false)
      } else {
        setMissing(true)
      }
    })

    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [filePath, version])

  if (missing) {
    return (
      <div className="h-full flex items-center justify-center gap-1.5 text-gray-400 dark:text-zinc-500 text-sm">
        <Warning size={16} />
        PDFを表示できません（削除されたか、読み込めません）
      </div>
    )
  }

  if (!url) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500 text-sm">
        読み込み中...
      </div>
    )
  }

  return (
    <iframe
      src={`${url}#toolbar=1`}
      className="w-full h-full border-0"
    />
  )
}
