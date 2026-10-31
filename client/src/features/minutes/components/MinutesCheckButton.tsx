import { useRef, useState } from 'react'
import { Notebook, SpinnerGap } from '@phosphor-icons/react'
import { checkMinutes } from '../api'

const ICON_BUTTON = 'p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors'
const SHOWN_MS = 6000

/**
 * 「議事録を確かめる」 in the title bar: asks the server to look at the member's
 * calendar now (it also does at start and every 10 minutes). Shown only while
 * the member has allowed Google to read minutes (`available`).
 */
export function MinutesCheckButton({ companyId }: { companyId: string }) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null)

  const check = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await checkMinutes(companyId)
      const text = !result ? null : result.success ? result.message ?? '確かめました。新しい議事録はお知らせに出ます。' : result.error
      setSaid(text)
      if (hide.current) clearTimeout(hide.current)
      hide.current = setTimeout(() => setSaid(null), SHOWN_MS)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => void check()} disabled={busy} className={`${ICON_BUTTON} disabled:opacity-50`} title="議事録を確かめる" aria-label="議事録を確かめる">
        {busy ? <SpinnerGap size={18} className="animate-spin" /> : <Notebook size={18} />}
      </button>
      {said && <p role="status" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 shadow dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">{said}</p>}
    </div>
  )
}
