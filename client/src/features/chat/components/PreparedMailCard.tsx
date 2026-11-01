import { CircleNotch } from '@phosphor-icons/react'
import { useOutboundMail } from '../hooks/useOutboundMail'
import { MailDraftCard } from './MailDraftCard'

/**
 * A mail draft the AI made for a task (its 「AI が用意したもの」), read from the server now: the
 * latest version, checked and sent with the same card as in the consultation (the person sends).
 * The caller keys it by the draft's id.
 */
export function PreparedMailCard({ companyId, messageId }: { companyId: string; messageId: string }) {
  const result = useOutboundMail(companyId, messageId)
  if (result === null) return <p className="flex items-center gap-1.5 text-[11px] text-gray-400"><CircleNotch size={12} className="animate-spin" />下書きを読み込んでいます...</p>
  if (!result.success) return <p role="alert" className="text-[11px] text-gray-500">{result.error}</p>
  return <MailDraftCard card={{ id: `task-${messageId}`, companyId, conversationId: null, draft: result.draft, byAi: true, at: result.draft.updatedAt }} />
}
