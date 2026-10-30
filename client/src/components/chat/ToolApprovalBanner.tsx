import { useTranslation } from 'react-i18next'
import { ShieldWarning } from '@phosphor-icons/react'
import { getToolDisplayName } from './toolRows'
import type { ToolApprovalRequest } from '../../../shared/ipc-contract'

// ============================================================================
// Tool Approval Banner
// ============================================================================

export function ToolApprovalBanner({
  request,
  onRespond,
}: {
  request: ToolApprovalRequest
  onRespond: (toolUseId: string, approved: boolean) => void
}) {
  const { t } = useTranslation()

  const displayName = getToolDisplayName(request.toolName) || request.toolName
  let inputSummary = ''
  if (request.toolInput) {
    const input = request.toolInput
    const first = [input.command, input.file_path, input.notebook_path, input.path, input.url, input.query].find(v => typeof v === 'string' && v)
    if (first) inputSummary = String(first)
  }

  return (
    <div className="flex-shrink-0 px-4 py-3 bg-amber-500/10 border-b border-amber-500/20 animate-fade-in">
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
          <div className="text-xs text-gray-600 dark:text-zinc-300 font-medium">
            {displayName}
          </div>
          {inputSummary && (
            <div className="text-xs text-gray-500 dark:text-zinc-400 font-mono truncate mt-0.5">
              {inputSummary}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onRespond(request.toolUseId, false)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
          >
            {t('chat.toolApprovalDeny')}
          </button>
          <button
            onClick={() => onRespond(request.toolUseId, true)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            {t('chat.toolApprovalAllow')}
          </button>
        </div>
      </div>
    </div>
  )
}
