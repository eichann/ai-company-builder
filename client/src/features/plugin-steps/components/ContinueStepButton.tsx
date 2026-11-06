import { useState } from 'react'
import { ArrowRight } from '@phosphor-icons/react'
import { CONTINUE_LABEL } from '../../../../shared/ai-turn-steps/plugin'
import { runCommand } from '../../../shared/commands/commands'
import { continueStep } from '../api'
import { useStepContinuation } from '../hooks/useStepContinuation'

interface Props {
  companyId: string
  rootPath: string
  /** The deal, or the やること the automatic run handed over. */
  recordId: string
}

/**
 * 「続きをする」 (owner decision 2026-11-06, option B; plugin-steps.md "続きをする"): where an
 * automatic run of a person's step prepared something, the member finishes it in their own
 * consultation of that step — bound to it, its files held to the step's folder, the procedure's
 * scripts run with the person there. Nothing shows otherwise.
 */
export function ContinueStepButton({ companyId, rootPath, recordId }: Props) {
  const continuation = useStepContinuation(companyId, recordId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!continuation) return null
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await continueStep(companyId, recordId, rootPath)
      if (!r.ok) { setError(r.error); return }
      await runCommand('chat.newConsultation', { message: r.message, title: r.title, pluginStep: r.pluginStep })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label={CONTINUE_LABEL} className="flex flex-wrap items-center gap-2 px-5 pt-5 text-xs">
      <span className="text-gray-600 dark:text-zinc-300">AI が「{continuation.label}」を準備しました。</span>
      <button type="button" disabled={busy} onClick={() => void go()}
        className="inline-flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-white hover:opacity-90 disabled:opacity-50">
        {CONTINUE_LABEL}<ArrowRight size={11} />
      </button>
      {error && <p role="alert" className="w-full text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}
