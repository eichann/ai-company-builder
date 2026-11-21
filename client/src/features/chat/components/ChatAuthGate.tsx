import { useTranslation } from 'react-i18next'
import { GearSix, Lightning, CircleNotch } from '@phosphor-icons/react'
import type { ClaudeCodeStatus } from '../../../../shared/ipc-contract'
import { ClaudeSignInCard } from './ClaudeSignInCard'

/** While the agent's sign-in (and the chat server) are being checked. */
export function ChatAuthChecking() {
  const { t } = useTranslation()
  return (
    <div className="h-full flex flex-col items-center justify-center p-8">
      <div className="relative">
        <div className="w-12 h-12 rounded-2xl bg-surface-raised border border-[color:var(--color-border)] flex items-center justify-center">
          <CircleNotch size={20} className="text-primary animate-spin" />
        </div>
      </div>
      <p className="mt-4 text-sm text-text-muted">{t('auth.checkingAuth')}</p>
    </div>
  )
}

interface SetupNeededProps {
  /** The chosen AI is Claude Code: its install and sign-in are done here (useAgentAuth). */
  claudeSetupShown: boolean
  claudeStatus: ClaudeCodeStatus | null
  /** The folder the chat runs in, where Claude Code's sign-in is checked and started. */
  claudeRoot: string | undefined
  claudeCodeAvailable: boolean
  claudeCodeError: string | null
  onOpenSettings: () => void
  onRecheck: () => void
}

/** The chosen agent cannot start: what is missing, and the way to the settings. */
export function ChatSetupNeeded({ claudeSetupShown, claudeStatus, claudeRoot, claudeCodeAvailable, claudeCodeError, onOpenSettings, onRecheck }: SetupNeededProps) {
  const { t } = useTranslation()
  if (claudeSetupShown) {
    // Claude Code: everything happens here (install guidance, the browser sign-in); no terminal.
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
        <h3 className="text-lg font-medium text-text">AI に相談する準備</h3>
        <div className="w-full max-w-[360px]"><ClaudeSignInCard status={claudeStatus} root={claudeRoot} onRecheck={onRecheck} /></div>
        <button type="button" onClick={onOpenSettings} className="text-xs text-text-muted hover:text-text">ほかの AI を選ぶ（設定）</button>
      </div>
    )
  }
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-[color:var(--color-border)] flex items-center justify-center mb-6 shadow-glass">
        <Lightning size={28} weight="fill" className="text-primary" />
      </div>
      <h3 className="text-lg font-medium text-text mb-2">
        {t('auth.setupAssistant')}
      </h3>
      <p className="text-sm text-text-muted mb-6 max-w-[240px]">
        {claudeCodeAvailable
          ? t('auth.connectOptions')
          : t('auth.apiKeyRequired')}
      </p>
      {claudeCodeError && (
        <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 max-w-[320px]">
          <p className="text-xs text-amber-400">{claudeCodeError}</p>
        </div>
      )}
      <button
        onClick={onOpenSettings}
        className="
          flex items-center gap-2
          bg-primary hover:bg-primary-hover
          text-on-primary text-sm font-medium
          rounded-xl px-5 py-2.5
          transition-all duration-200
          hover:shadow-glow hover:scale-[1.02]
          active:scale-[0.98]
        "
      >
        <GearSix size={16} weight="bold" />
        {t('auth.openSettings')}
      </button>
    </div>
  )
}
