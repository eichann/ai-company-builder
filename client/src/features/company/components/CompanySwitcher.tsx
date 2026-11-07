// The company's name in the title bar: for a member of two or more companies it opens a menu
// to switch (useCompanySwitch decides when the switch may go ahead).
import { useState } from 'react'
import { CaretDown, House, SpinnerGap } from '@phosphor-icons/react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { useDismiss } from '../../../shared/hooks/useDismiss'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import type { SwitchQuestion } from '../hooks/useCompanySwitch'

const NAME_CLASS = 'text-sm font-medium text-gray-700 dark:text-zinc-200'

const QUESTIONS: Record<SwitchQuestion, { title: string; message: string; confirmText: string; cancelText: string; danger: boolean }> = {
  sync: {
    title: '同期の途中です',
    message: '同期が終わってから会社を切り替えます。',
    confirmText: '終わったら切り替える',
    cancelText: '切り替えない',
    danger: false,
  },
  ai: {
    title: 'AIが作業中です',
    message: '会社を切り替えると、AIの作業はそこで止まります。ここまでのやり取りは保存されます。',
    confirmText: '切り替える',
    cancelText: 'キャンセル',
    danger: true,
  },
}

interface Props {
  companyName: string
  /** False for a member of one company: the name only. */
  shown: boolean
  /** The other companies. */
  targets: CompanyInfo[]
  onSwitch: (company: CompanyInfo) => void
  question: SwitchQuestion | null
  onAnswer: (yes: boolean) => void
  waitingForSync: boolean
  onStopWaiting: () => void
}

export function CompanySwitcher({ companyName, shown, targets, onSwitch, question, onAnswer, waitingForSync, onStopWaiting }: Props) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  useDismiss(box, open, () => setOpen(false))
  const asked = question ? QUESTIONS[question] : null

  return (
    <div className="flex items-center gap-3">
      <House size={18} className="text-gray-500 dark:text-zinc-400" />
      {!shown ? <span className={NAME_CLASS}>{companyName}</span> : (
        <div ref={setBox} className="relative">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
            title="会社を切り替える"
            className={`${NAME_CLASS} flex items-center gap-1 rounded-md px-1.5 py-0.5 -mx-1.5 hover:bg-gray-100 dark:hover:bg-zinc-800`}
          >
            {companyName}
            <CaretDown size={12} className="text-gray-500 dark:text-zinc-400" />
          </button>
          {open && (
            <div role="menu" aria-label="会社を切り替える" className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              <p className="px-3 py-1.5 text-xs text-gray-500 dark:text-zinc-400">ほかの会社を開く</p>
              {targets.map(company => (
                <button
                  key={company.id}
                  type="button"
                  role="menuitem"
                  onClick={() => { setOpen(false); onSwitch(company) }}
                  className="block w-full px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  {company.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {waitingForSync && (
        <span role="status" className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-zinc-400">
          <SpinnerGap size={14} className="animate-spin" />
          同期が終わったら会社を切り替えます
          <button type="button" onClick={onStopWaiting} className="underline hover:text-gray-700 dark:hover:text-zinc-200">やめる</button>
        </span>
      )}
      <ConfirmDialog
        isOpen={asked !== null}
        title={asked?.title ?? ''}
        message={asked?.message ?? ''}
        confirmText={asked?.confirmText}
        cancelText={asked?.cancelText}
        danger={asked?.danger}
        confirmOnEnter={false}
        onConfirm={() => onAnswer(true)}
        onCancel={() => onAnswer(false)}
      />
    </div>
  )
}
