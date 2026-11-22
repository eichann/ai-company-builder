// 「出した案」 in Settings → 「定期の仕事」 (jobs.md "Member proposals" "The app (PR C)"): the proposals the member sent from
// the AI chat, with what became of each — the server decides everything; 「取り下げる」 only while it waits.
import { Button, Callout, Card, StatusBadge, SubHeading } from '../../../shared/ui/primitives'
import type { MyJob } from '../../../../shared/jobs'
import { useMyJobProposals } from '../hooks/useMyJobProposals'
import { proposalRows } from '../model'

const BADGE: Record<string, 'awaiting' | 'success' | 'warning' | 'paused' | 'neutral'> = {
  submitted: 'awaiting', approved: 'success', returned: 'warning', withdrawn: 'paused',
}

export function JobProposals({ companyId, jobs, onChanged }: { companyId: string; jobs: readonly MyJob[] | null; onChanged?: () => void }) {
  const { loadRef, proposals, supported, error, message, busy, withdraw } = useMyJobProposals(companyId, onChanged)
  const rows = proposals ? proposalRows(proposals, jobs) : []
  return (
    <div ref={loadRef}>
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
      {supported && rows.length > 0 && (
        <Card className="space-y-2 p-5">
          <SubHeading>出した案</SubHeading>
          <ul aria-label="出した案" className="divide-y divide-border">
            {rows.map(row => (
              <li key={row.id} aria-label={row.name} className="flex flex-wrap items-center gap-2 py-2 text-body">
                <span className="font-strong text-text">{row.name}</span>
                <StatusBadge variant={BADGE[row.state] ?? 'neutral'}>{row.word}</StatusBadge>
                {row.sent && <span className="text-small text-text-muted">{row.sent}</span>}
                {row.withdraw && <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void withdraw(row.id)}>取り下げる</Button>}
                <span className="w-full text-small text-text-muted">{row.line}</span>
              </li>
            ))}
          </ul>
          {message && <p role="status" className="text-small text-text-muted">{message}</p>}
        </Card>
      )}
    </div>
  )
}
