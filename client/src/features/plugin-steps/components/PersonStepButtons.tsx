import { useState } from 'react'
import { Play } from '@phosphor-icons/react'
import type { PluginStepButton } from '../../../../shared/ai-turn-steps/plugin'
import { runCommand } from '../../../shared/commands/commands'
import { startPersonStep } from '../api'
import { usePersonSteps } from '../hooks/usePersonSteps'

interface Props {
  companyId: string
  rootPath: string
  recordId: string
}

/**
 * A business plugin's `start: person` steps at the record's state (plugin-steps.md): each opens a
 * consultation with the procedure the work is pinned to (pinned now when it is the first run).
 * Nothing shows while no step applies.
 */
export function PersonStepButtons({ companyId, rootPath, recordId }: Props) {
  const steps = usePersonSteps(companyId, recordId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (steps.length === 0) return null
  const start = async (s: PluginStepButton) => {
    setBusy(true)
    setError(null)
    try {
      const r = await startPersonStep(companyId, recordId, s.pluginId, s.step, rootPath)
      if (!r.ok) { setError(r.error); return }
      await runCommand('chat.newConsultation', { message: r.message, title: r.title, pluginStep: { recordId, pluginId: s.pluginId, step: s.step } })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="手順" className="flex flex-wrap items-center gap-2 px-5 pt-5 text-xs">
      {steps.map(s => (
        <button key={`${s.pluginId}/${s.step}`} type="button" disabled={busy} onClick={() => void start(s)}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2.5 py-1 hover:bg-gray-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
          <Play size={11} />{s.label}
        </button>
      ))}
      {error && <p role="alert" className="w-full text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}
