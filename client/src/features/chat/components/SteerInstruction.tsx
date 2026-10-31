import { memo } from 'react'
import { ArrowBendDownRight } from '@phosphor-icons/react'
import { STEER_LABEL, type SteerRecord } from '../../../../shared/steer'

/**
 * An instruction the member sent while the AI was working (shared/steer.ts),
 * shown as the member's message where the AI received it in the reply.
 */
export const SteerInstructionView = memo(function SteerInstructionView({ record }: { record: SteerRecord }) {
  return (
    <div className="my-2 flex flex-col items-end animate-fade-in">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-gray-500 dark:text-zinc-400">
        <ArrowBendDownRight size={12} weight="bold" aria-hidden="true" />
        <span>{STEER_LABEL}</span>
      </div>
      <div aria-label={STEER_LABEL} className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[14px] leading-relaxed bg-accent text-white whitespace-pre-wrap break-words">
        {record.text}
      </div>
    </div>
  )
}, (a, b) => a.record.id === b.record.id && a.record.text === b.record.text)
