import { useState } from 'react'
import { setWatchSummaryLines } from '../../../../../shared/core/job-words'
import type { JobDefinition } from '../../../../../shared/core/jobs'
import { acceptanceLines } from '../model'

/**
 * A version's words as 受け取る shows them (jobs.md "The screens"). A set watch first says its three summary lines and keeps
 * every line behind ［くわしく］ (owner FB 2026-11-24, 使い心地のメモ #37: some fifteen lines of 「動く条件」 were not read);
 * any other job shows every line, as before. The full list keeps `label` as its name.
 */
export function JobWordsList({ definition, label }: { definition: JobDefinition; label: string }) {
  const [open, setOpen] = useState(false)
  const summary = setWatchSummaryLines(definition, 'responsible')
  const full = <ul aria-label={label} className="space-y-1 text-body text-text">{acceptanceLines(definition).map(l => <li key={l}>{l}</li>)}</ul>
  if (summary.length === 0) return full
  return (
    <div className="space-y-2">
      <ul aria-label={`${label}（要点）`} className="space-y-1 text-body text-text">{summary.map(l => <li key={l}>{l}</li>)}</ul>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="text-small text-link hover:underline">
        {open ? 'くわしくを閉じる' : 'くわしく'}
      </button>
      {open && full}
    </div>
  )
}
