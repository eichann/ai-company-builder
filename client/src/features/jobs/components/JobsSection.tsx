// Settings → 「定期の仕事」 (jobs.md "The screens"): the jobs the member is the responsible person of — what
// one waiting for their 「受け取る」 will do, on whose rights, where — and their own pause / resume. The
// sentences are the ones the admin approved (shared/core/job-words.ts); the server decides everything.
import { SpinnerGap } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader, SubHeading } from '../../../shared/ui/primitives'
import {
  jobCheckText, jobGrantLines, jobMissedText, jobPlacementText, jobRunText, jobSlotText, jobTriggerText, jobWaitingText,
} from '../../../../../shared/core/job-words'
import { useMyJobs } from '../hooks/useMyJobs'

export function JobsSection({ companyId }: { companyId: string }) {
  const { loadRef, jobs, error, message, busy, accept, pause, resume } = useMyJobs(companyId)
  const waiting = jobs?.filter(j => j.toAccept) ?? []
  const others = jobs?.filter(j => !j.toAccept) ?? []

  return (
    <div ref={loadRef} className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader
        title="定期の仕事"
        description="あなたが責任者の、決まった時間に動く仕事です。あなたの権限で動くので、内容を確かめて「受け取る」を押すまでは動きません。"
      />
      {!jobs && !error ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-zinc-500"><SpinnerGap size={16} className="animate-spin" />読み込み中…</div>
      ) : !jobs ? (
        <Callout tone="warning" role="alert">{error}</Callout>
      ) : jobs.length === 0 ? (
        <p className="text-[13px] text-zinc-600 dark:text-zinc-300">あなたが責任者の定期の仕事はありません。</p>
      ) : (
        <>
          {waiting.map(job => (
            <Card key={job.id} className="space-y-3 p-5">
              <SubHeading>受け取りを待っています：{job.name}</SubHeading>
              {job.toAccept?.definition ? (
                <>
                  <ul aria-label={`「${job.name}」の内容`} className="space-y-1 text-[13px] text-zinc-700 dark:text-zinc-200">
                    <li>いつ：{jobTriggerText(job.toAccept.definition.trigger)}</li>
                    <li>すること：{jobRunText(job.toAccept.definition.run)}</li>
                    {jobCheckText(job.toAccept.definition.check) && <li>{jobCheckText(job.toAccept.definition.check)}</li>}
                    <li>だれの権限で：あなた（動く場所：{jobPlacementText(job.toAccept.definition.placement)}）</li>
                    {jobGrantLines(job.toAccept.definition.grant).map(l => <li key={l}>{l}</li>)}
                    <li>{jobMissedText(job.toAccept.definition.missed)}</li>
                  </ul>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="primary" disabled={busy || !job.toAccept.fingerprint} onClick={() => void accept(job)}>受け取る</Button>
                    <span className="text-[12px] text-zinc-500">受け取ると、この内容のとおりにあなたの名前で動きます。違うときは管理者に知らせてください。</span>
                  </div>
                </>
              ) : (
                <p className="text-[13px] text-zinc-600 dark:text-zinc-300">この仕事には、あなたが今は見られない場所が含まれているため、内容を表示できません。管理者に確かめてください。</p>
              )}
            </Card>
          ))}
          {others.length > 0 && (
            <Card className="space-y-2 p-5">
              <SubHeading>あなたの定期の仕事</SubHeading>
              <ul className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                {others.map(job => (
                  <li key={job.id} aria-label={job.name} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                    <span className="font-medium">{job.name}</span>
                    {job.trigger && <span className="text-zinc-600 dark:text-zinc-300">{jobTriggerText(job.trigger)}</span>}
                    <span className="text-zinc-600 dark:text-zinc-300">{jobWaitingText(job.waiting, job.pausedReason)}</span>
                    {job.nextSlot && job.waiting === null && <span className="text-zinc-500">次は {jobSlotText(job.nextSlot)}</span>}
                    {job.controls && job.state === 'active' && (
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void pause(job)}>止める</Button>
                    )}
                    {job.controls && job.state === 'paused' && job.pausedReason === 'BY_RESPONSIBLE' && (
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void resume(job)}>再開する</Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {message && <p role="status" className="text-[12px] text-zinc-600 dark:text-zinc-300">{message}</p>}
        </>
      )}
    </div>
  )
}
