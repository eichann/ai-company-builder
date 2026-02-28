import { useState, useEffect } from 'react'
import { useAuthStore } from '../../stores/authStore'
import {
  Key,
  EnvelopeSimple,
  ArrowRight,
  Buildings,
  SpinnerGap,
  WarningCircle,
  ArrowSquareOut,
} from '@phosphor-icons/react'

export function LoginScreen() {
  const { signIn, isLoading } = useAuthStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [signupUrl, setSignupUrl] = useState('')

  useEffect(() => {
    window.electronAPI.getServerUrl().then((url) => {
      if (url) setSignupUrl(url)
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!email || !password) {
      setError('メールアドレスとパスワードを入力してください')
      return
    }

    const result = await signIn(email, password)

    if (!result.success) {
      setError(result.error || '認証に失敗しました')
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
            アカウントにログイン
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-2">
              メールアドレス
            </label>
            <div className="relative">
              <EnvelopeSimple
                size={20}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@company.com"
                className="w-full bg-sidebar-bg border border-border rounded-lg pl-10 pr-4 py-3 text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
                autoFocus
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-2">
              パスワード
            </label>
            <div className="relative">
              <Key
                size={20}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-sidebar-bg border border-border rounded-lg pl-10 pr-4 py-3 text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <WarningCircle size={20} className="text-red-400 flex-shrink-0" />
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors font-medium"
          >
            {isLoading ? (
              <SpinnerGap size={20} className="animate-spin" />
            ) : (
              <>
                ログイン
                <ArrowRight size={20} />
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-6 border-t border-border">
          <p className="text-center text-sm text-text-secondary mb-3">
            アカウントをお持ちでない方
          </p>
          <a
            href={signupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors text-sm"
          >
            Webサイトで新規登録
            <ArrowSquareOut size={16} />
          </a>
        </div>
      </div>
    </div>
  )
}
