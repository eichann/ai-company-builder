import { useTranslation } from 'react-i18next'
import { GearSix, Lightning, CircleNotch } from '@phosphor-icons/react'

/** While the agent's sign-in (and the chat server) are being checked. */
export function ChatAuthChecking() {
  const { t } = useTranslation()
  return (
    <div className="h-full flex flex-col items-center justify-center p-8">
      <div className="relative">
        <div className="w-12 h-12 rounded-2xl bg-surface-elevated border border-white/[0.06] flex items-center justify-center">
          <CircleNotch size={20} className="text-accent animate-spin" />
        </div>
      </div>
      <p className="mt-4 text-sm text-ink-muted">{t('auth.checkingAuth')}</p>
    </div>
  )
}

/** The chosen agent cannot start: what is missing, and the way to the settings. */
export function ChatSetupNeeded({ claudeCodeAvailable, claudeCodeError, onOpenSettings }: { claudeCodeAvailable: boolean; claudeCodeError: string | null; onOpenSettings: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-elevated border border-white/[0.06] flex items-center justify-center mb-6 shadow-glass">
        <Lightning size={28} weight="fill" className="text-accent" />
      </div>
      <h3 className="text-lg font-medium text-ink mb-2">
        {t('auth.setupAssistant')}
      </h3>
      <p className="text-sm text-ink-muted mb-6 max-w-[240px]">
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
          bg-accent hover:bg-accent/90
          text-white text-sm font-medium
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
