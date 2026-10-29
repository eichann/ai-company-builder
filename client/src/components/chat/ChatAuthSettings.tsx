import { CODEX_LOGIN_HELP } from '../../../shared/agent'
import type { AuthMode, CodexStatus } from '../../../shared/agent'
import type { ApiKeyStatus } from '../../../shared/ipc-contract'
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../../../shared/permission-mode'
import { VoiceShortcutSettings } from '../settings/VoiceShortcutSettings'
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GearSix, Check, Lightning, CaretDown } from '@phosphor-icons/react'

// ============================================================================
// Auth Settings Component
// ============================================================================

interface AuthSettingsProps {
  authMode: AuthMode
  claudeCodeAvailable: boolean
  claudeCodeError?: string | null
  onClose: () => void
}

export function AuthSettings({ authMode: initialAuthMode, claudeCodeAvailable, claudeCodeError, onClose }: AuthSettingsProps) {
  const { t } = useTranslation()
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode)
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [checkingCodex, setCheckingCodex] = useState(false)
  const [saveError, setSaveError] = useState('')
  const refreshCodex = async () => {
    setCheckingCodex(true)
    try { setCodexStatus(await window.electronAPI.getCodexStatus()) }
    catch (e) { setCodexStatus({ available: false, authenticated: false, models: [], error: `${String(e)}\n${CODEX_LOGIN_HELP}` }) }
    finally { setCheckingCodex(false) }
  }
  useEffect(() => { if (authMode === 'codex') void refreshCodex() }, [authMode])
  // A new key typed here; the saved one never comes back to the renderer, only its status.
  const [apiKey, setApiKey] = useState('')
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  // Only persist a mode the user actually picked, so an unset mode keeps following the default.
  const loadedPermissionModeRef = useRef<PermissionMode | null>(null)

  const keyLoadedRef = useRef(false)
  if (!keyLoadedRef.current) {
    keyLoadedRef.current = true
    loadCurrentKey()
    loadPermissionMode()
  }

  async function loadCurrentKey() {
    setApiKeyStatus(await window.electronAPI.getApiKeyStatus())
  }

  async function loadPermissionMode() {
    const mode = await window.electronAPI.getPermissionMode()
    loadedPermissionModeRef.current = mode
    setPermissionMode(mode)
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (authMode === 'api-key' && apiKey.trim()) {
        const saved = await window.electronAPI.setApiKey(apiKey)
        if (!saved.success) {
          setSaveError(saved.error ?? 'APIキーを保存できませんでした。')
          return
        }
      }
      await window.electronAPI.setAuthMode(authMode)
      if (permissionMode !== loadedPermissionModeRef.current) await window.electronAPI.setPermissionMode(permissionMode)
      onClose()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Header */}
      <header className="flex-shrink-0 h-12 flex items-center justify-between px-4 border-b border-white/[0.04]">
        <span className="text-sm font-medium text-ink">{t('chatSettings.title')}</span>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg hover:bg-white/[0.04] flex items-center justify-center transition-colors text-ink-muted hover:text-ink"
        >
          ✕
        </button>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <section className="rounded-xl border border-gray-200 dark:border-zinc-700 p-4"><VoiceShortcutSettings /></section>
        <div className="space-y-3">
          <label className="block text-xs font-medium tracking-wide uppercase text-ink-muted mb-3">
            {t('chatSettings.selectMethod')}
          </label>

          {/* Claude Code Option */}
          <button
            onClick={() => setAuthMode('claude-code')}
            className={`
              w-full text-left p-4 rounded-xl border transition-all duration-200
              ${authMode === 'claude-code'
                ? 'border-accent/50 bg-accent/10 shadow-glow'
                : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
              }
            `}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  authMode === 'claude-code' ? 'bg-accent' : 'bg-white/[0.04]'
                }`}>
                  <Lightning size={16} weight="fill" className={authMode === 'claude-code' ? 'text-white' : 'text-ink-muted'} />
                </div>
                <div>
                  <div className="font-medium text-ink text-sm">{t('chatSettings.claudeMax')}</div>
                  <div className="text-xs text-ink-muted mt-0.5">
                    {claudeCodeAvailable ? t('chatSettings.claudeMaxDesc') : t('chatSettings.cliNotFound')}
                  </div>
                </div>
              </div>
              {authMode === 'claude-code' && (
                <Check size={18} weight="bold" className="text-accent" />
              )}
            </div>
          </button>

          <button onClick={() => setAuthMode('codex')}
            className={`w-full text-left p-4 rounded-xl border transition-colors ${authMode === 'codex' ? 'border-accent/50 bg-accent/10' : 'border-white/[0.06] bg-surface-elevated'}`}>
            <div className="flex items-center justify-between">
              <div><div className="font-medium text-ink text-sm">Codex（ChatGPTプラン）</div>
                <div className="text-xs text-ink-muted mt-1">自分のChatGPTアカウントの利用枠で相談します</div></div>
              {authMode === 'codex' && <Check size={18} className="text-accent" />}
            </div>
          </button>
          {/* API Key Option */}
          <button
            onClick={() => setAuthMode('api-key')}
            className={`
              w-full text-left p-4 rounded-xl border transition-all duration-200
              ${authMode === 'api-key'
                ? 'border-accent/50 bg-accent/10 shadow-glow'
                : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
              }
            `}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  authMode === 'api-key' ? 'bg-accent' : 'bg-white/[0.04]'
                }`}>
                  <GearSix size={16} weight="fill" className={authMode === 'api-key' ? 'text-white' : 'text-ink-muted'} />
                </div>
                <div>
                  <div className="font-medium text-ink text-sm">{t('chatSettings.apiKey')}</div>
                  <div className="text-xs text-ink-muted mt-0.5">{t('chatSettings.apiKeyDesc')}</div>
                </div>
              </div>
              {authMode === 'api-key' && (
                <Check size={18} weight="bold" className="text-accent" />
              )}
            </div>
          </button>
        </div>

        <p className="text-xs text-ink-muted">変更は次の送信から適用されます。AIやモデルを切り替えると、相談の表示履歴を渡して新しいAIセッションで続けます。元のAIの内部状態やツール実行結果は引き継ぎません。</p>
        {authMode === 'codex' && <section className="rounded-xl border border-white/[0.08] p-4 space-y-2 text-sm">
          <p className="text-xs text-ink-muted">作業フォルダ内の通常作業は自動で進めます。フォルダ外への書き込みや、追加権限が必要な操作では確認します。</p>
          <p>{checkingCodex ? 'Codexを確認しています…' : codexStatus?.authenticated && codexStatus.models.length ? 'ChatGPTでログイン済み' : codexStatus?.unsupported ? 'Windowsでは未対応です' : 'Codexの準備が必要です'}</p>
          {codexStatus?.error && <p className="text-xs text-red-500">{codexStatus.error}</p>}
          {!codexStatus?.unsupported && <p className="text-xs text-ink-muted">接続できない場合は、ターミナルを開いて <code>codex login</code> を実行し、ChatGPTアカウントでログインしてください。その後「接続を再確認」を押してください。</p>}
          <button onClick={() => void refreshCodex()} disabled={checkingCodex || codexStatus?.unsupported} className="text-accent text-xs disabled:opacity-50">接続を再確認</button>
        </section>}
        {saveError && <p role="alert" className="text-sm text-red-500">{saveError}</p>}
        {/* API Key Input */}
        {authMode === 'api-key' && (
          <div className="space-y-3 pt-2 animate-fade-in">
            <label className="block text-xs font-medium tracking-wide uppercase text-ink-muted">
              {t('chatSettings.apiKey')}
            </label>
            {apiKeyStatus?.set && (
              <p className="text-xs text-ink-muted">設定済み（…{apiKeyStatus.last4}）。変更するときだけ新しいキーを入力してください。</p>
            )}
            {apiKeyStatus?.unreadable && (
              <p className="text-xs text-amber-400">保存されているキーをこのコンピューターでは読み取れません。もう一度入力してください。</p>
            )}
            {apiKeyStatus?.storedInPlainText && (
              <p className="text-xs text-amber-400">このコンピューターではキーを暗号化できないため、以前のバージョンで保存したキーが暗号化されないまま残っています。</p>
            )}
            {apiKeyStatus && !apiKeyStatus.encryptionAvailable && (
              <p role="alert" className="text-xs text-amber-400">このコンピューターでは APIキーを安全に保存する仕組み（キーチェーン）が使えないため、新しいキーは保存できません。</p>
            )}
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('chatSettings.apiKeyPlaceholder')}
                className="
                  w-full bg-surface-elevated border border-white/[0.06]
                  rounded-xl px-4 py-3 pr-20
                  text-sm text-ink placeholder-ink-faint
                  focus:outline-none focus:border-accent/50
                  transition-colors
                "
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted hover:text-ink transition-colors"
              >
                {showApiKey ? t('chatSettings.hideKey') : t('chatSettings.showKey')}
              </button>
            </div>

            <details className="text-xs text-ink-muted">
              <summary className="cursor-pointer hover:text-ink transition-colors flex items-center gap-1">
                <CaretDown size={12} />
                {t('chatSettings.howToGetKey')}
              </summary>
              <ol className="list-decimal list-inside space-y-1 mt-2 pl-1 text-ink-faint">
                <li>{t('chatSettings.step1')}</li>
                <li>{t('chatSettings.step2')}</li>
                <li>{t('chatSettings.step3')}</li>
              </ol>
            </details>
          </div>
        )}

        {/* Claude Code Setup Instructions */}
        {authMode === 'claude-code' && !claudeCodeAvailable && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 animate-fade-in">
            {claudeCodeError ? (
              <>
                <p className="text-xs font-medium text-amber-400 mb-2">{claudeCodeError}</p>
                <div className="mt-2 pt-2 border-t border-amber-500/20">
                  <p className="text-[11px] text-ink-muted">{t('chatSettings.setupRequired')}</p>
                </div>
              </>
            ) : (
              <p className="text-xs font-medium text-amber-400 mb-2">{t('chatSettings.setupRequired')}</p>
            )}
            <ol className="list-decimal list-inside space-y-1 text-xs text-ink-muted mt-2">
              <li>{t('chatSettings.setupStep1')}</li>
              <li><code className="bg-black/30 px-1.5 py-0.5 rounded font-mono text-[11px]">{t('chatSettings.setupStep2')}</code></li>
              <li><code className="bg-black/30 px-1.5 py-0.5 rounded font-mono text-[11px]">{t('chatSettings.setupStep3')}</code></li>
              <li>{t('chatSettings.setupStep4')}</li>
            </ol>
          </div>
        )}

        {/* Permission Mode Toggle (Claude Code mode only) */}
        {authMode === 'claude-code' && claudeCodeAvailable && (
          <div className="space-y-3 pt-2 animate-fade-in">
            <label className="block text-xs font-medium tracking-wide uppercase text-ink-muted">
              {t('chatSettings.permissionMode')}
            </label>
            <div className="space-y-2">
              {([
                ['auto', 'permissionAuto'],
                ['default', 'permissionDefault'],
                ['bypassPermissions', 'permissionBypass'],
              ] as const).map(([mode, key]) => (
                <button
                  key={mode}
                  onClick={() => setPermissionMode(mode)}
                  className={`w-full text-left p-3 rounded-lg border transition-all duration-200 ${
                    permissionMode === mode
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-ink">{t(`chatSettings.${key}`)}</div>
                      <div className="text-xs text-ink-muted mt-0.5">{t(`chatSettings.${key}Desc`)}</div>
                    </div>
                    {permissionMode === mode && (
                      <Check size={16} weight="bold" className="text-accent flex-shrink-0" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-4 border-t border-white/[0.04]">
        <button
          onClick={handleSave}
          disabled={saving || (authMode === 'api-key' && !apiKey.trim() && !apiKeyStatus?.set) || (authMode === 'codex' && (checkingCodex || !codexStatus?.authenticated || !codexStatus.models.length))}
          className="
            w-full py-3 rounded-xl
            bg-accent hover:bg-accent/90
            disabled:bg-ink-faint disabled:cursor-not-allowed
            text-white text-sm font-medium
            transition-all duration-200
            hover:shadow-glow
          "
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
