import { useState } from 'react'
import {
  Globe,
  ArrowRight,
  SpinnerGap,
  WarningCircle,
  CheckCircle,
  Buildings,
} from '@phosphor-icons/react'

interface Props {
  onComplete: () => void
}

export function ServerSetupScreen({ onComplete }: Props) {
  const [url, setUrl] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validated, setValidated] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsValidating(true)

    try {
      let normalizedUrl = url.trim()
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = 'https://' + normalizedUrl
      }
      normalizedUrl = normalizedUrl.replace(/\/+$/, '')

      const result = await window.electronAPI.validateServerUrl(normalizedUrl)

      if (result.valid) {
        await window.electronAPI.setServerUrl(normalizedUrl)
        setValidated(true)
        setTimeout(() => onComplete(), 500)
      } else {
        setError(result.error || 'Validation failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setIsValidating(false)
    }
  }

  return (
    <div className="h-full bg-editor-bg flex items-center justify-center">
      <div className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <Buildings size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
          <h1 className="text-2xl font-bold text-text-primary mb-2">
            AI Company Builder
          </h1>
          <p className="text-text-secondary">
            接続先サーバーのURLを入力してください
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-2">
              サーバーURL
            </label>
            <div className="relative">
              <Globe
                size={20}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
              />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full bg-sidebar-bg border border-border rounded-lg pl-10 pr-4 py-3 text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
                autoFocus
              />
            </div>
            <p className="mt-2 text-xs text-text-secondary">
              管理者から共有されたサーバーのURLを入力してください
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <WarningCircle size={20} className="text-red-400 flex-shrink-0" />
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )}

          {validated && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle size={20} className="text-green-400 flex-shrink-0" />
              <span className="text-sm text-green-400">接続確認完了</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isValidating || !url.trim() || validated}
            className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors font-medium"
          >
            {isValidating ? (
              <SpinnerGap size={20} className="animate-spin" />
            ) : validated ? (
              <>
                <CheckCircle size={20} />
                接続完了
              </>
            ) : (
              <>
                接続
                <ArrowRight size={20} />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
