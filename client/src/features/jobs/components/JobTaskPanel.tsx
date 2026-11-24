// A やること a scheduled job made (owner memo 「4b-4 挟む部分」 H-10, the common part of PR6; jobs.md "The set watch (schema 5)"
// "The app (PR6)"): on its card, what the AI judged (a set watch's — its own view only), 「議事録が直された」, and the
// presses — ［確かめて完了］ (never done for the member), ［まだ早かった］, ［作ってもらう］, 「この作業をする」. The server decides each
// correction; the やること's own changes go through the card's own presses (its version, ［取り消す］).
import { useCallback, useRef, useState } from 'react'
import { runCommand } from '../../../shared/commands/commands'
import { Button } from '../../../shared/ui/primitives'
import { minutesEditedMark, setWatchOccurrenceOf, setWatchOffer, type JobRunMinutesVersions, type MyJobOccurrence } from '../../../../shared/jobs'
import { setWatchJudgementText } from '../../../../../shared/core/job-words'
import { getMyJobOccurrences, sendJobFeedback } from '../api'

/** The note 経緯 keeps when ［まだ早かった］ takes the やること away. */
export const TOO_EARLY_NOTE = 'AI のたたき台が早すぎたため'

export interface JobTaskPanelProps {
  companyId: string
  task: { id: string; title: string; madeAt: string | null; open: boolean }
  busy: boolean
  /** ［確かめて完了］: the card's own 完了にする (null: not offered to this member now). */
  onComplete: (() => void) | null
  /** Takes the やること away with a note (the card's own 要らない); its refusal's words, or null. Null: not offered. */
  onDismiss: ((note: string) => Promise<string | null>) | null
  /**
   * PR5's run record on this PC: the minutes' version the run read and the one now. TODO(4b-4 PR5): AppShell passes it once
   * the runner keeps `docVersion` on the run record; until then absent, and nothing is said about the minutes.
   */
  minutesVersions?: JobRunMinutesVersions | null
}

export function JobTaskPanel({ companyId, task, busy, onComplete, onDismiss, minutesVersions }: JobTaskPanelProps) {
  const [occurrences, setOccurrences] = useState<MyJobOccurrence[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  // Read when the panel mounts (a callback ref: the renderer's effect count is capped), on the member's own session.
  const loadedFor = useRef<string | null>(null)
  const reload = useCallback(async () => {
    const r = await getMyJobOccurrences(companyId).catch(() => null)
    setOccurrences(r?.success ? r.occurrences : [])
  }, [companyId])
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === `${companyId}:${task.id}`) return
    loadedFor.current = `${companyId}:${task.id}`
    void reload()
  }, [companyId, task.id, reload])

  const occurrence = occurrences ? setWatchOccurrenceOf(occurrences, task.id) : null
  const offer = occurrence ? setWatchOffer(occurrence.report) : null
  const mark = occurrence ? minutesEditedMark(minutesVersions) : 'none'
  const disabled = busy || working
  const startWork = () => void runCommand('chat.consultAbout', { recordId: task.id, title: task.title, purpose: 'work', ...(task.madeAt ? { madeAt: task.madeAt } : {}) })

  const tooEarly = async () => {
    if (!occurrence || !onDismiss) return
    setWorking(true)
    setMessage(null)
    try {
      const r = await sendJobFeedback(companyId, occurrence.id, 'too_early')
      if (!r.success) { setMessage(r.error); return }
      const failure = await onDismiss(TOO_EARLY_NOTE)
      setMessage(failure ?? '「まだ早かった」と記録し、このやることを外しました（作ったファイルはそのまま残ります）。')
      await reload()
    } finally {
      setWorking(false)
    }
  }
  const makeAnyway = async () => {
    if (!occurrence || !offer) return
    if (offer.makeAnywayRecords) {
      setWorking(true)
      try {
        const r = await sendJobFeedback(companyId, occurrence.id, 'made_anyway')
        if (!r.success) { setMessage(r.error); return }
      } finally {
        setWorking(false)
      }
    }
    startWork()
  }

  return (
    <section ref={loadRef} aria-label="定期の仕事から" className="space-y-2 rounded-card border border-border bg-surface-raised p-3 text-small text-text">
      {occurrence && <p>{setWatchJudgementText(occurrence.report)}</p>}
      {mark === 'edited' && <p role="status" className="text-warning-text">AI が読んだあとに、議事録が直されています。必要なら［作ってもらう］で作り直してください。</p>}
      {mark === 'unknown' && <p className="text-text-muted">AI が読んだあとに議事録が直されたかは、確かめられません。</p>}
      <div className="flex flex-wrap items-center gap-2">
        {occurrence && offer ? <>
          {offer.confirmDone && onComplete && task.open && <Button size="sm" variant="primary" disabled={disabled} onClick={onComplete}>確かめて完了</Button>}
          {offer.tooEarly && onDismiss && task.open && <Button size="sm" disabled={disabled} onClick={() => void tooEarly()}>まだ早かった</Button>}
          {offer.makeAnyway && task.open && <Button size="sm" disabled={disabled} onClick={() => void makeAnyway()}>作ってもらう</Button>}
        </> : occurrences !== null && task.open && (
          // Any other やること a scheduled job made: its work starts in a consultation fixed to when it was made.
          <Button size="sm" disabled={disabled} onClick={startWork}>この作業をする</Button>
        )}
      </div>
      {!occurrence && occurrences !== null && task.open && <p className="text-text-muted">AI と相談しながら、このやることの作業を始めます（対象は、このやることが作られた日の週です）。終わって、その相談を見ていなければ、相談は自動で閉じます。</p>}
      {message && <p role="status" className="text-text-muted">{message}</p>}
    </section>
  )
}
