import { useTranslation } from 'react-i18next'
import { ClockCountdown } from '@phosphor-icons/react'
import type { QueuedSend } from './queuedSends'

/** Messages waiting for the running turn to end (「応答が終わったら送ります」), each with 取り消す. */
export function QueuedSendList({ queuedSends, onCancel }: { queuedSends: QueuedSend[]; onCancel: (index: number) => void }) {
  const { t } = useTranslation()
  if (queuedSends.length === 0) return null
  return (
    <ul aria-live="polite" className="px-4 pt-3 space-y-1">
      {queuedSends.map((item, index) => (
        <li key={index} className="flex items-center gap-2 text-xs text-gray-500 dark:text-zinc-400">
          <ClockCountdown size={14} aria-hidden="true" className="flex-shrink-0" />
          <span className="flex-shrink-0">{t('chat.queuedSend')}</span>
          <span className="min-w-0 truncate text-gray-700 dark:text-zinc-300">{item.text}</span>
          <button type="button" onClick={() => onCancel(index)} className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800">{t('chat.queuedCancel')}</button>
        </li>
      ))}
    </ul>
  )
}
