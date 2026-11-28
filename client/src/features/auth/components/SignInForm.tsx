// The sign-in form both start screens share: the server it connects to (the host, large) above
// the email and password, so the member checks where the password goes before pressing ログイン
// (UX review 20, owner decision 2026-11-28: ［つなぐ］ is part of ［ログイン］). No company name
// is shown here: before sign-in the app knows only the address (decision 6).
import { useState, type ReactNode } from 'react'
import { ArrowRight, Buildings, EnvelopeSimple, Key, ShieldCheck, SpinnerGap, WarningCircle } from '@phosphor-icons/react'

function hostOf(server: string): string {
  try { return new URL(server).host } catch { return server }
}

export function SignInForm({ server, title, note, notice, aside, busy, onSignIn }: {
  /** The server's origin (https://…): its host is shown large. */
  server: string
  title: string
  /** Under the title. */
  note: string
  /** Said above the address (it changed since the screen first showed). */
  notice?: string | null
  /** Under the host's explanation (つながない on an invitation's address). */
  aside?: ReactNode
  busy: boolean
  /** Resolves with the message to show, or null when signed in. */
  onSignIn: (email: string, password: string) => Promise<string | null>
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email || !password) {
      setError('メールアドレスとパスワードを入れてください')
      return
    }
    setError(await onSignIn(email, password))
  }

  return (
    <div className="w-full max-w-md p-8">
      <div className="text-center mb-6">
        <Buildings size={56} className="mx-auto mb-3 text-primary" weight="duotone" />
        <h1 className="text-page font-bold text-text mb-1">{title}</h1>
        <p className="text-text-muted">{note}</p>
      </div>

      {notice && (
        <div role="status" data-server-changed className="mb-3 rounded-control border border-warning-border bg-warning-bg p-3 text-body text-warning-text">{notice}</div>
      )}

      <section aria-label="つなぎ先" className="mb-5 rounded-control border border-[color:var(--color-border)] bg-bg p-4">
        <div className="flex items-center gap-1.5 text-small text-text-muted">
          <ShieldCheck size={14} />
          つなぎ先
        </div>
        <div data-server-host className="mt-1 text-heading font-semibold text-text break-all">{hostOf(server)}</div>
        <p className="mt-1 text-small text-text-muted">
          招待のメールのページに書かれたアドレスと同じか確かめてください。{aside}
        </p>
      </section>

      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="block text-body text-text-muted mb-2">メールアドレス</span>
          <span className="relative block">
            <EnvelopeSimple size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@company.com"
              className="w-full bg-bg border border-border-control rounded-control pl-10 pr-4 py-3 text-text placeholder:text-text-subtle focus:outline-none focus:border-focus-border"
              autoFocus
            />
          </span>
        </label>

        <label className="block">
          <span className="block text-body text-text-muted mb-2">パスワード</span>
          <span className="relative block">
            <Key size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-bg border border-border-control rounded-control pl-10 pr-4 py-3 text-text placeholder:text-text-subtle focus:outline-none focus:border-focus-border"
            />
          </span>
        </label>

        {error && (
          <div role="alert" className="flex items-center gap-2 p-3 rounded-control bg-danger-bg border border-danger-border">
            <WarningCircle size={20} className="text-danger-text flex-shrink-0" />
            <span className="text-body text-danger-text">{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover disabled:opacity-disabled disabled:cursor-not-allowed text-on-primary rounded-control px-4 py-3 transition-colors font-medium"
        >
          {busy ? <SpinnerGap size={20} className="animate-spin" /> : <>ログイン<ArrowRight size={20} /></>}
        </button>
        <p className="text-center text-small text-text-muted">パスワードは、招待のメールのページで決めたものです</p>
      </form>
    </div>
  )
}
