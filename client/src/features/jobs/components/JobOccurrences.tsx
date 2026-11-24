// 「AI が動いた回」 (stage 4b-2, owner memo 「段4b 設計メモ」 §4-3 / D11, jobs.md "The app's runner" "「もう一度」 and 「後始末」 in the
// app"): the event occurrences this PC's AI ran for the member, with 「もう一度」 where the server allows it and 「後始末」 for an
// outside operation whose result nobody knows. Shown only from the server's answer (`GET /me/job-occurrences`); every press
// is decided by the server, its refusal said in its words.
import { useState } from 'react'
import { Button, Card, SubHeading } from '../../../shared/ui/primitives'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { JOB_RECONCILE_ASK, type MyJobOccurrence } from '../../../../shared/jobs'
import { useMyJobOccurrences } from '../hooks/useMyJobOccurrences'
import { declinedRows, makeAnywayMessage, occurrenceRows } from '../model'
import { runCommand } from '../../../shared/commands/commands'
import { jobSlotText } from '../../../../../shared/core/job-words'

type Ask = { kind: 'retry'; occurrence: MyJobOccurrence; madeBefore: string | null } | { kind: 'reconcile'; occurrence: MyJobOccurrence; key: string; what: string; done: boolean }

export function JobOccurrences({ companyId }: { companyId: string }) {
  const { loadRef, occurrences, error, message, busy, retry, reconcile, feedback } = useMyJobOccurrences(companyId)
  const [ask, setAsk] = useState<Ask | null>(null)
  const rows = occurrenceRows(occurrences)
  const declined = declinedRows(occurrences)
  // ［作ってもらう］ after 見送る (4b-4 PR6): the correction is kept first (the server checks it fits), then a consultation.
  const makeAnyway = async (o: MyJobOccurrence) => {
    if (!await feedback(o, 'made_anyway')) return
    void runCommand('chat.newConsultation', { title: `会議のたたき台を作る（${jobSlotText(o.dueSlot)}）`, message: makeAnywayMessage(o.dueSlot) })
  }

  return (
    <div ref={loadRef}>
      {error && <p role="alert" className="text-small text-danger-text">{error}</p>}
      {declined.length > 0 && (
        // Where the notice 「…AI はたたき台を作りませんでした」 (job_set_declined) leads: its ［作ってもらう］.
        <Card className="space-y-2 p-5">
          <SubHeading>会議のあとの AI の判断</SubHeading>
          <ul className="divide-y divide-border">
            {declined.map(row => (
              <li key={row.occurrence.id} aria-label={row.heading} className="flex flex-wrap items-center gap-2 py-2 text-small text-text">
                <span className="font-strong">{row.heading}</span>
                <span className="text-text-muted">{row.line}</span>
                {row.makeAnyway && <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void makeAnyway(row.occurrence)}>作ってもらう</Button>}
              </li>
            ))}
          </ul>
          {message && rows.length === 0 && <p role="status" className="text-small text-text-muted">{message}</p>}
        </Card>
      )}
      {rows.length > 0 && (
        <Card className="space-y-2 p-5">
          <SubHeading>AI が動いた回で、確かめが要るもの</SubHeading>
          <ul className="divide-y divide-border">
            {rows.map(row => (
              <li key={row.occurrence.id} aria-label={row.heading} className="space-y-1 py-2 text-small text-text">
                <div className="font-strong">{row.heading}</div>
                <div className="text-text-muted">{row.state}</div>
                {row.madeBefore && <div className="text-text-muted">{row.madeBefore}</div>}
                {row.unknown.map(u => (
                  <div key={u.key} className="flex flex-wrap items-center gap-2">
                    <span>{u.what}{JOB_RECONCILE_ASK}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsk({ kind: 'reconcile', occurrence: row.occurrence, key: u.key, what: u.what, done: true })}>作られていた</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsk({ kind: 'reconcile', occurrence: row.occurrence, key: u.key, what: u.what, done: false })}>作られていなかった</Button>
                  </div>
                ))}
                {row.retry === 'allowed' && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsk({ kind: 'retry', occurrence: row.occurrence, madeBefore: row.madeBefore })}>もう一度</Button>
                )}
                {row.retry !== null && row.retry !== 'allowed' && <div className="text-text-muted">「もう一度」はできません：{row.retry.blocked}</div>}
              </li>
            ))}
          </ul>
          {message && <p role="status" className="text-small text-text-muted">{message}</p>}
        </Card>
      )}
      <ConfirmDialog
        isOpen={ask !== null}
        title={ask?.kind === 'retry' ? 'もう一度動かしますか？' : '確かめた結果を記録しますか？'}
        message={ask?.kind === 'retry'
          ? `この回を、もう一度あなたの PC の AI で動かします（このアプリが開いていて「自動で進める」が入っているときに動きます）。${ask.madeBefore ? `${ask.madeBefore}もう一度すると、また作られることがあります。` : ''}`
          : ask ? `${ask.what}は「${ask.done ? '作られていた' : '作られていなかった'}」と記録します。記録しても、この回は動き出しません。` : ''}
        confirmText={ask?.kind === 'retry' ? 'もう一度動かす' : '記録する'}
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          const a = ask
          setAsk(null)
          if (!a) return
          void (a.kind === 'retry' ? retry(a.occurrence) : reconcile(a.occurrence, a.key, a.done))
        }}
      />
    </div>
  )
}
