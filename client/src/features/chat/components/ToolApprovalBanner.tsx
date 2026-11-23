import { useTranslation } from 'react-i18next'
import { ShieldWarning } from '@phosphor-icons/react'
import { approvalWordsOf } from '../../../../shared/tool-approval-words'
import type { ToolApprovalRequest } from '../../../../shared/ipc-contract'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

// ============================================================================
// Tool Approval Banner
// ============================================================================

/**
 * Asks the member before the AI makes a call. It says what will happen in plain Japanese
 * (tool-approval-words.ts); the tool's own name and the exact command stay behind 「くわしく」.
 */
export function ToolApprovalBanner({
  request,
  rootPath,
  onRespond,
}: {
  request: ToolApprovalRequest
  /** The company folder: a path inside it is shown relative to it. */
  rootPath?: string
  onRespond: (toolUseId: string, approved: boolean) => void
}) {
  const { t } = useTranslation()
  const words = approvalWordsOf(request.toolName, request.toolInput, rootPath)

  return (
    <div className="flex-shrink-0 px-4 py-3 bg-amber-500/10 border-b border-amber-500/20 animate-fade-in" role="group" aria-label={t('chat.toolApprovalTitle')}>
      <div className="flex items-start gap-3">
        <ShieldWarning size={18} weight="fill" className="text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-amber-300 mb-1">
            {t('chat.toolApprovalTitle')}
          </div>
          {request.reason && (
            <div className="text-xs text-amber-700 dark:text-amber-200 mb-1 whitespace-pre-wrap">
              {request.reason}
            </div>
          )}
          <div className="text-xs text-gray-600 dark:text-zinc-300 font-medium" data-approval-action>
            {words.action}
          </div>
          {words.detail && (
            <div className="text-small text-text-muted truncate mt-0.5">
              {words.detail}
            </div>
          )}
          <details className="mt-1 text-small text-text-muted">
            <summary className="cursor-pointer select-none">くわしく</summary>
            <div className="mt-1">道具の名前：{words.technical}</div>
            {words.exact && (
              <div className="font-mono whitespace-pre-wrap break-all mt-0.5">{words.exact}</div>
            )}
          </details>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onRespond(request.toolUseId, false)}
            className="px-3 py-1.5 text-xs font-medium rounded-control border border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
          >
            {t('chat.toolApprovalDeny')}
          </button>
          <button
            onClick={() => onRespond(request.toolUseId, true)}
            className={`px-3 py-1.5 text-xs font-medium rounded-control transition-colors ${PRIMARY_ACTION}`}
          >
            {t('chat.toolApprovalAllow')}
          </button>
        </div>
      </div>
    </div>
  )
}
