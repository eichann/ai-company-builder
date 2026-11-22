import { CODEX_LOGIN_HELP } from '../../../../shared/agent'
import type { AuthMode, CodexStatus } from '../../../../shared/agent'
import type { ApiKeyStatus, ClaudeCodeStatus } from '../../../../shared/ipc-contract'
import { ClaudeSignInCard } from './ClaudeSignInCard'
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../../../../shared/permission-mode'
import { VoiceShortcutSettings } from '../../voice/components/VoiceShortcutSettings'
import { getApiKeyStatus, getCodexStatus, getPermissionMode, saveApiKey, saveAuthMode, savePermissionMode } from '../api'
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GearSix, Check, Lightning, CaretDown } from '@phosphor-icons/react'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

// The chat's settings follow the theme (design-system.md, P2d): an option card is the plain card
// on the page, the chosen one the `selected` set; its icon tile is primary when chosen.
const OPTION = 'w-full text-left rounded-card border transition-colors'
const OPTION_ON = 'border-selected-border bg-selected-bg'
const OPTION_OFF = 'border-[color:var(--color-border)] bg-bg hover:border-border-control'
const option = (on: boolean) => `${OPTION} ${on ? OPTION_ON : OPTION_OFF}`
const TILE = (on: boolean) => `w-8 h-8 rounded-control flex items-center justify-center ${on ? 'bg-primary' : 'bg-surface-sunken'}`
const TILE_ICON = (on: boolean) => on ? 'text-on-primary' : 'text-text-muted'

// ============================================================================
// Auth Settings Component
// ============================================================================

interface AuthSettingsProps {
  authMode: AuthMode
  claudeCodeAvailable: boolean
  claudeCodeError?: string | null
  claudeStatus: ClaudeCodeStatus | null
  claudeRoot: string | undefined
  onRecheck: () => void
  onClose: () => void
}

export function AuthSettings({ authMode: initialAuthMode, claudeCodeAvailable, claudeStatus, claudeRoot, onRecheck, onClose }: AuthSettingsProps) {
  const { t } = useTranslation()
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode)
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [checkingCodex, setCheckingCodex] = useState(false)
  const [saveError, setSaveError] = useState('')
  const refreshCodex = async () => {
    setCheckingCodex(true)
    try { setCodexStatus(await getCodexStatus()) }
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
    setApiKeyStatus(await getApiKeyStatus())
  }

  async function loadPermissionMode() {
    const mode = await getPermissionMode()
    loadedPermissionModeRef.current = mode
    setPermissionMode(mode)
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (authMode === 'api-key' && apiKey.trim()) {
        const saved = await saveApiKey(apiKey)
        if (!saved.success) {
          setSaveError(saved.error ?? 'APIキーを保存できませんでした。')
          return
        }
      }
      await saveAuthMode(authMode)
      if (permissionMode !== loadedPermissionModeRef.current) await savePermissionMode(permissionMode)
      onClose()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-[var(--color-surface)] text-text">
      {/* Header */}
      <header className="flex-shrink-0 h-12 flex items-center justify-between px-4 border-b border-[color:var(--color-border)]">
        <span className="text-sm font-medium text-text">{t('chatSettings.title')}</span>
        <button
          onClick={onClose}
          aria-label="閉じる"
          className="w-8 h-8 rounded-control hover:bg-surface-sunken flex items-center justify-center transition-colors text-text-muted hover:text-text"
        >
          ✕
        </button>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <section className="rounded-card border border-[color:var(--color-border)] p-4"><VoiceShortcutSettings /></section>
        <div className="space-y-3">
          <label className="block text-xs font-medium tracking-wide uppercase text-text-muted mb-3">
            {t('chatSettings.selectMethod')}
          </label>

          {/* Claude Code Option */}
          <button
            onClick={() => setAuthMode('claude-code')}
            aria-pressed={authMode === 'claude-code'}
            className={`p-4 ${option(authMode === 'claude-code')}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={TILE(authMode === 'claude-code')}>
                  <Lightning size={16} weight="fill" className={TILE_ICON(authMode === 'claude-code')} />
                </div>
                <div>
                  <div className="font-medium text-text text-sm">{t('chatSettings.claudeMax')}</div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {claudeCodeAvailable ? t('chatSettings.claudeMaxDesc') : t('chatSettings.cliNotFound')}
                  </div>
                </div>
              </div>
              {authMode === 'claude-code' && (
                <Check size={18} weight="bold" className="text-selected-icon" />
              )}
            </div>
          </button>

          <button onClick={() => setAuthMode('codex')} aria-pressed={authMode === 'codex'}
            className={`p-4 ${option(authMode === 'codex')}`}>
            <div className="flex items-center justify-between">
              <div><div className="font-medium text-text text-sm">Codex（ChatGPTプラン）</div>
                <div className="text-xs text-text-muted mt-1">自分のChatGPTアカウントの利用枠で相談します</div></div>
              {authMode === 'codex' && <Check size={18} className="text-selected-icon" />}
            </div>
          </button>
          {/* API Key Option */}
          <button
            onClick={() => setAuthMode('api-key')}
            aria-pressed={authMode === 'api-key'}
            className={`p-4 ${option(authMode === 'api-key')}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={TILE(authMode === 'api-key')}>
                  <GearSix size={16} weight="fill" className={TILE_ICON(authMode === 'api-key')} />
                </div>
                <div>
                  <div className="font-medium text-text text-sm">{t('chatSettings.apiKey')}</div>
                  <div className="text-xs text-text-muted mt-0.5">{t('chatSettings.apiKeyDesc')}</div>
                </div>
              </div>
              {authMode === 'api-key' && (
                <Check size={18} weight="bold" className="text-selected-icon" />
              )}
            </div>
          </button>
        </div>

        <p className="text-xs text-text-muted">変更は次の送信から適用されます。AIやモデルを切り替えると、相談の表示履歴を渡して新しいAIセッションで続けます。元のAIの内部状態やツール実行結果は引き継ぎません。</p>
        {authMode === 'codex' && <section className="rounded-card border border-[color:var(--color-border)] p-4 space-y-2 text-sm">
          <p className="text-xs text-text-muted">作業フォルダ内の通常作業は自動で進めます。フォルダ外への書き込みや、追加権限が必要な操作では確認します。</p>
          <p>{checkingCodex ? 'Codexを確認しています…' : codexStatus?.authenticated && codexStatus.models.length ? 'ChatGPTでログイン済み' : codexStatus?.unsupported ? 'Windowsでは未対応です' : 'Codexの準備が必要です'}</p>
          {codexStatus?.error && <p className="text-xs text-danger-text">{codexStatus.error}</p>}
          {!codexStatus?.unsupported && <p className="text-xs text-text-muted">接続できない場合は、ターミナルを開いて <code>codex login</code> を実行し、ChatGPTアカウントでログインしてください。その後「接続を再確認」を押してください。</p>}
          <button onClick={() => void refreshCodex()} disabled={checkingCodex || codexStatus?.unsupported} className="text-link hover:text-link-hover text-xs disabled:opacity-disabled">接続を再確認</button>
        </section>}
        {saveError && <p role="alert" className="text-sm text-danger-text">{saveError}</p>}
        {/* API Key Input */}
        {authMode === 'api-key' && (
          <div className="space-y-3 pt-2 animate-fade-in">
            <label className="block text-xs font-medium tracking-wide uppercase text-text-muted">
              {t('chatSettings.apiKey')}
            </label>
            {apiKeyStatus?.set && (
              <p className="text-xs text-text-muted">設定済み（…{apiKeyStatus.last4}）。変更するときだけ新しいキーを入力してください。</p>
            )}
            {apiKeyStatus?.unreadable && (
              <p className="text-xs text-warning-text">保存されているキーをこのコンピューターでは読み取れません。もう一度入力してください。</p>
            )}
            {apiKeyStatus?.storedInPlainText && (
              <p className="text-xs text-warning-text">以前のバージョンで保存したキーを安全な形に移せなかったため、このキーは使っていません。キーをもう一度入力して保存し直してください。</p>
            )}
            {apiKeyStatus && !apiKeyStatus.encryptionAvailable && (
              <p role="alert" className="text-xs text-warning-text">このコンピューターでは APIキーを安全に保存する仕組み（キーチェーン）が使えないため、新しいキーは保存できません。</p>
            )}
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('chatSettings.apiKeyPlaceholder')}
                className="
                  w-full bg-bg border border-border-control
                  rounded-control px-4 py-3 pr-20
                  text-sm text-text placeholder:text-text-subtle
                  focus:outline-none focus:border-focus-border
                  transition-colors
                "
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted hover:text-text transition-colors"
              >
                {showApiKey ? t('chatSettings.hideKey') : t('chatSettings.showKey')}
              </button>
            </div>

            <details className="text-xs text-text-muted">
              <summary className="cursor-pointer hover:text-text transition-colors flex items-center gap-1">
                <CaretDown size={12} />
                {t('chatSettings.howToGetKey')}
              </summary>
              <ol className="list-decimal list-inside space-y-1 mt-2 pl-1 text-text-subtle">
                <li>{t('chatSettings.step1')}</li>
                <li>{t('chatSettings.step2')}</li>
                <li>{t('chatSettings.step3')}</li>
              </ol>
            </details>
          </div>
        )}

        {/* Claude Code: install guidance, the browser sign-in, or a notice about the account */}
        {authMode === 'claude-code' && <ClaudeSignInCard status={claudeStatus} root={claudeRoot} onRecheck={onRecheck} />}

        {/* Permission Mode Toggle (Claude Code mode only) */}
        {authMode === 'claude-code' && claudeCodeAvailable && (
          <div className="space-y-3 pt-2 animate-fade-in">
            <label className="block text-xs font-medium tracking-wide uppercase text-text-muted">
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
                  aria-pressed={permissionMode === mode}
                  className={`w-full text-left p-3 rounded-control border transition-colors ${
                    permissionMode === mode
                      ? OPTION_ON
                      : OPTION_OFF
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-text">{t(`chatSettings.${key}`)}</div>
                      <div className="text-xs text-text-muted mt-0.5">{t(`chatSettings.${key}Desc`)}</div>
                    </div>
                    {permissionMode === mode && (
                      <Check size={16} weight="bold" className="text-selected-icon flex-shrink-0" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-4 border-t border-[color:var(--color-border)]">
        <button
          onClick={handleSave}
          disabled={saving || (authMode === 'api-key' && !apiKey.trim() && !apiKeyStatus?.set) || (authMode === 'codex' && (checkingCodex || !codexStatus?.authenticated || !codexStatus.models.length))}
          className={`
            w-full py-3 rounded-control
            disabled:cursor-not-allowed
            text-sm font-medium
            transition-colors
            ${PRIMARY_ACTION}
          `}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
