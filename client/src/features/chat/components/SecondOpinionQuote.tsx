import { memo, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { secondOpinionQuoteLabel, type SecondOpinionRecord } from '../../../../shared/agents/second-opinion'

/**
 * 「Codex の答えを全部見る」 (chat-and-agents.md "Asking the other AI"): the other AI's own words,
 * folded under the reply where the AI summed them up (owner, 2026-11-02: no card, no buttons to
 * pick a side). Plain text on purpose — another company's AI wrote it, so no links or images.
 */
export const SecondOpinionQuote = memo(function SecondOpinionQuote({ record }: { record: SecondOpinionRecord }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1.5 text-[12px]" data-second-opinion={record.agent}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-gray-500 dark:text-zinc-400 hover:text-accent"
      >
        {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
        {secondOpinionQuoteLabel(record.agent)}
      </button>
      {open && (
        <blockquote className="mt-1 border-l-2 border-gray-200 dark:border-zinc-700 pl-3 text-gray-600 dark:text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
          {record.answer}
        </blockquote>
      )}
    </div>
  )
}, (a, b) => a.record.id === b.record.id && a.record.answer === b.record.answer && a.record.agent === b.record.agent)
