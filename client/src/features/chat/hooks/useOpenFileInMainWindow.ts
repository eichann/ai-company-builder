import { useCallback, useEffect, useRef, useState } from 'react'
import { useCommandHandler } from '../../../shared/commands/commands'
import { openFileInMainWindow } from '../api'

const NOTICE_MS = 6000
const FAILED = 'ファイルを開けませんでした。'

/**
 * A consultation's own window has no editor: its `file.open` handler (what a
 * 「確認をお願いします」 file link runs) asks main to open the file in the main
 * window's editor, which comes to the front. Main checks the path; its
 * plain-Japanese refusal is returned for the window to show for a while.
 */
export function useOpenFileInMainWindow(): { notice: string | null; dismiss: () => void } {
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dismiss = useCallback(() => { clearTimeout(timer.current); setNotice(null) }, [])
  useEffect(() => () => clearTimeout(timer.current), [])

  useCommandHandler('file.open', async ({ path }) => {
    const result = await openFileInMainWindow(path).catch(() => ({ ok: false as const, error: FAILED }))
    clearTimeout(timer.current)
    if (result.ok) { setNotice(null); return }
    setNotice(result.error)
    timer.current = setTimeout(() => setNotice(null), NOTICE_MS)
  })
  return { notice, dismiss }
}
