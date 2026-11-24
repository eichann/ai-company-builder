// The Friday やること 「今週の定例レポートを作る」 (S5): its work starts with the common part's 「この作業をする」 (the week fixed to
// when the やること was made); here ［今週は作らない］ (W6, OD5: the やること's own 完了), ［MIN の判断を直す］ (W7) and ［作り直す］ (W5, E9:
// the member deletes this week's section in the document first — neither the app nor the AI can delete there).
import { useState } from 'react'
import { runCommand } from '../../../shared/commands/commands'
import { Button, Callout } from '../../../shared/ui/primitives'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { WEEKLY_MIN_ASK, WEEKLY_REDO_ASK } from '../model'
import type { CardTask } from './UpdateProposalCard'

export function WeeklyReportPart({ task, busy, onComplete }: { task: CardTask; busy: boolean; onComplete: (() => Promise<string | null>) | null }) {
  const [ask, setAsk] = useState<'skip' | 'redo' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  if (!task.open) return null
  const work = (detail: string) => void runCommand('chat.consultAbout', { recordId: task.id, title: task.title, purpose: 'work', ...(task.madeAt ? { madeAt: task.madeAt } : {}), detail })
  return (
    <section aria-label="今週の定例レポート" className="space-y-2 rounded-card border border-border bg-surface-raised p-3 text-small text-text">
      <div className="flex flex-wrap items-center gap-2">
        {onComplete && <Button size="sm" disabled={busy} onClick={() => setAsk('skip')}>今週は作らない</Button>}
        <Button size="sm" disabled={busy} onClick={() => work(WEEKLY_MIN_ASK)}>MIN の判断を直す</Button>
        <Button size="sm" disabled={busy} onClick={() => setAsk('redo')}>作り直す</Button>
      </div>
      {message && <Callout tone="danger">{message}</Callout>}
      <ConfirmDialog isOpen={ask === 'skip'} title="今週は作りませんか？" confirmOnEnter={false}
        message="このやることを完了にします。ドキュメントには何も書きません。長く休むときは、管理者に定期の仕事を止めてもらってください。"
        confirmText="今週は作らない" onCancel={() => setAsk(null)}
        onConfirm={() => { setAsk(null); void onComplete?.().then(failure => setMessage(failure)) }} />
      <ConfirmDialog isOpen={ask === 'redo'} title="作り直す前に" confirmOnEnter={false}
        message="アプリと AI は、ドキュメントの中身を消せません。先に、議事録のドキュメントから今週分を手で消してください。消してから押すと、今週のレポートを作り直します。"
        confirmText="消したので作り直す" onCancel={() => setAsk(null)} onConfirm={() => { setAsk(null); work(WEEKLY_REDO_ASK) }} />
    </section>
  )
}
