// ［大きく開く（タブ）］ of a 「定期の仕事の案」 (UX 段3 #13, owner decision 2026-11-28 「12・13番」 5): what the screen skeleton needs
// to show the chat's proposal card as a screen tab of the middle (`viewTabKey(JOB_PROPOSAL_VIEW)`). A candidate is not a
// record, so it has no record tab: the tab draws the same card, read with the member's session from the same store, so a
// change or a press in either place shows in both.
import { CalendarCheck } from '@phosphor-icons/react'
import { JobProposalCard } from './components/JobProposalCard'

/** The middle tab's name. One tab: opening another candidate shows that one in it. */
export const JOB_PROPOSAL_VIEW = 'job-proposal'

export const JOB_PROPOSAL_TAB_LOOK = { title: '定期の仕事の案', icon: <CalendarCheck size={14} className="flex-shrink-0" aria-hidden /> }

/** Which candidate the tab shows (`jobProposal.open`'s arguments). */
export interface JobProposalTabTarget { companyId: string; candidateId: string }

/** The tab's page: only a candidate of the company on screen (another company's is said so, nothing read). */
export function renderJobProposalTab(target: JobProposalTabTarget | null, currentCompanyId: string | null) {
  if (!target || target.companyId !== currentCompanyId) {
    return <p className="p-6 text-small text-text-muted">この定期の仕事の案は、いま画面に出ている会社のものではありません。</p>
  }
  const card = { id: `tab:${target.candidateId}`, companyId: target.companyId, conversationId: null, candidateId: target.candidateId, at: '' }
  return (
    <div className="h-full overflow-auto p-6" data-testid="job-proposal-tab">
      <div className="mx-auto max-w-3xl"><JobProposalCard key={target.candidateId} card={card} /></div>
    </div>
  )
}
