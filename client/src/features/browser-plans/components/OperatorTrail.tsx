import { BROWSER_TRAIL_WORDS as W, answerProblemWords, type BrowserOperatorTrail, type BrowserTrailRun } from '../../../../shared/browser-operator-trail'
import { BROWSER_TOOLSET_WORDS } from '../../../../shared/browser-operator-toolset-choice'

/**
 * The operator AI's own trail on the person's card (agent-browser.md "The operator's trail on the card"): what it did step
 * by step (the action, the button's or field's label in the run log's kept form, its own reason), its own words for stopping
 * and its notes. Written by an AI that reads page text, so it is outside text: collapsed by default under
 * 「係の AI のメモを見る」, labelled as the operator's memo — not a checked fact —, shown as plain text only (React text,
 * never markup). It names the tool set the operator answered in (agent-browser.md "The operator's tool sets").
 */
export function OperatorTrail({ trail, asked = null }: {
  trail: BrowserOperatorTrail
  /** The question the card already puts first: a stop whose words are exactly it is not said again here. */
  asked?: string | null
}) {
  if (trail.length === 0) return null
  return (
    <details data-operator-trail className="mt-2 text-small text-text-muted">
      <summary className="cursor-pointer select-none">{W.open}</summary>
      <div className="mt-1 rounded-control border border-border bg-surface-raised p-2">
        <p className="font-strong text-text-muted">{W.heading}</p>
        {trail.map((run, i) => <TrailRun key={i} run={run} titled={trail.length > 1} asked={asked} />)}
      </div>
    </details>
  )
}

function TrailRun({ run, titled, asked }: { run: BrowserTrailRun; titled: boolean; asked: string | null }) {
  const stopReason = run.end?.kind === 'stop' ? run.end.reason : null
  return (
    <div className="mt-2" data-trail-phase={run.phase}>
      {titled && <p className="font-strong text-text">{W.phase[run.phase]}</p>}
      {run.toolset && <p className="mt-1" data-trail-toolset>{W.toolset}：{BROWSER_TOOLSET_WORDS.names[run.toolset]}</p>}
      {run.end?.kind === 'stop' && !(asked !== null && stopReason === asked) && (
        <p className="mt-1 text-text" data-trail-stop>
          {W.stopReason}：{stopReason ?? W.noReason}
        </p>
      )}
      {run.unlisted && (
        <p className="mt-1 text-text" data-trail-unlisted>
          {W.unlisted}：{run.unlisted}
        </p>
      )}
      {run.steps.length === 0 && run.more === 0
        ? <p className="mt-1">{W.noSteps}</p>
        : (
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            {run.steps.map((s, i) => (
              <li key={i} className="break-words">
                <span className="text-text">{W.action[s.action]}{s.label ? `「${s.label}」` : ''}</span>
                {s.page && <span className="ml-1">{s.page}</span>}
                <span className="ml-1">— {s.reason ?? W.noReason}</span>
              </li>
            ))}
          </ol>
        )}
      {run.more > 0 && <p className="mt-1">{W.more(run.more)}</p>}
      {run.end && run.end.kind !== 'stop' && (
        <p className="mt-1"><span className="text-text">{W.end[run.end.kind]}</span> — {run.end.reason ?? W.noReason}</p>
      )}
      {!run.end && <p className="mt-1">{run.problem ? <span data-trail-problem>{W.problem(answerProblemWords(run.problem, run.toolset))}</span> : W.appEnded}</p>}
      {run.notes && (
        <div className="mt-1">
          <p className="font-strong">{W.notes}</p>
          <p className="whitespace-pre-wrap break-words">{run.notes}</p>
        </div>
      )}
    </div>
  )
}
