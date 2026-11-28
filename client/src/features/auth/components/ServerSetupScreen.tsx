// The first screen while the app has no server (UX review 20, owner decisions 2026-11-28):
// it waits for the invitation's 「アプリを開く」; typing the address is the side path for when
// the mail cannot be found. An address a link brought is shown on the sign-in form, and
// ［ログイン］ is the member's press that connects to it (ipc-and-main-process.md "The
// invitation's 「アプリを開く」"): main uses only the address it holds, and only while it is
// still the one this screen shows.
import { useCallback, useRef, useState } from 'react'
import { ArrowRight, Buildings, CheckCircle, Globe, SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { useAuthStore } from '../../../stores/authStore'
import { acceptAppLinkServer, dismissAppLinkServer, getAppLinkServerOffer, setServerUrl, validateServerUrl } from '../api'
import { SignInForm } from './SignInForm'

const OFFER_CHECK_MS = 1500

interface Props {
  onComplete: () => void
}

export function ServerSetupScreen({ onComplete }: Props) {
  const signIn = useAuthStore(s => s.signIn)
  // The address an invitation's 「アプリを開く」 brought (main holds it; asked again every 1.5 s
  // while this screen shows, so a link clicked now appears without a restart).
  const [offer, setOffer] = useState<string | null>(null)
  // The offered address once ［ログイン］ connected to it: the form stays on it while sign-in is retried.
  const [accepted, setAccepted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [typing, setTyping] = useState(false)
  const offerTimer = useRef<number | null>(null)
  const watchOffer = useCallback((node: HTMLDivElement | null) => {
    if (offerTimer.current !== null) {
      window.clearInterval(offerTimer.current)
      offerTimer.current = null
    }
    if (!node) return
    const check = () => { getAppLinkServerOffer().then(o => setOffer(o?.server ?? null)).catch(() => {}) }
    check()
    offerTimer.current = window.setInterval(check, OFFER_CHECK_MS)
  }, [])

  async function connectAndSignIn(shown: string, email: string, password: string): Promise<string | null> {
    setBusy(true)
    try {
      if (accepted !== shown) {
        const result = await acceptAppLinkServer(shown).catch(() => null)
        if (!result?.success) return result?.error ?? 'つなげませんでした。もう一度押してください。'
        setAccepted(shown)
      }
      const signedIn = await signIn(email, password)
      if (!signedIn.success) return signedIn.error || 'ログインできませんでした'
      onComplete()
      return null
    } finally {
      setBusy(false)
    }
  }

  async function declineOffer() {
    await dismissAppLinkServer().catch(() => {})
    setOffer(null)
  }

  const server = accepted ?? offer
  if (server) {
    return (
      // Once connected the offer is gone from main: nothing more to watch.
      <div ref={accepted ? undefined : watchOffer} className="h-full bg-[var(--color-surface)] flex items-center justify-center" data-app-link-offer>
        <SignInForm
          server={server}
          title="ログインして参加"
          note="招待されたメールアドレスでログインします"
          busy={busy}
          aside={accepted ? null : (
            <>
              心当たりがないときは
              <button type="button" onClick={() => void declineOffer()} disabled={busy} className="text-link hover:underline">つながない</button>
              を押してください。
            </>
          )}
          onSignIn={(email, password) => connectAndSignIn(server, email, password)}
        />
      </div>
    )
  }

  return (
    <div ref={watchOffer} className="h-full bg-[var(--color-surface)] flex items-center justify-center">
      {typing
        ? <TypedAddress onBack={() => setTyping(false)} onComplete={onComplete} />
        : <WaitForInvitation onNoMail={() => setTyping(true)} />}
    </div>
  )
}

function WaitForInvitation({ onNoMail }: { onNoMail: () => void }) {
  const steps = ['届いた招待のメールを開きます', 'メールのページで［アプリを開く］を押します', 'この画面が、自分で次に進みます']
  return (
    <div className="w-full max-w-md p-8 space-y-5">
      <div className="text-center">
        <Buildings size={56} className="mx-auto mb-3 text-primary" weight="duotone" />
        <h1 className="text-page font-bold text-text mb-1">AI Company Builder へようこそ</h1>
        <p className="text-text-muted">招待のメールから始めます</p>
      </div>
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <li key={step} className="flex items-center gap-3 rounded-control border border-[color:var(--color-border)] px-4 py-3 text-body text-text">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-selected-bg text-selected-text">{i + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <p role="status" className="flex items-center justify-center gap-2 text-body text-text-muted">
        <SpinnerGap size={16} className="animate-spin" />
        招待のリンクを待っています
      </p>
      <div className="border-t border-[color:var(--color-border)] pt-4 text-center">
        <button type="button" onClick={onNoMail} className="text-body text-link hover:underline">
          招待のメールが見当たらないとき
        </button>
      </div>
    </div>
  )
}

/** The side path: the member types the address (main checks it answers as ACB before it is saved). */
function TypedAddress({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
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
      const result = await validateServerUrl(normalizedUrl)
      if (result.valid) {
        await setServerUrl(normalizedUrl)
        setValidated(true)
        setTimeout(() => onComplete(), 500)
      } else {
        setError(result.error || 'このアドレスにつながりませんでした')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'このアドレスにつながりませんでした')
    } finally {
      setIsValidating(false)
    }
  }

  return (
    <div className="w-full max-w-md p-8">
      <div className="text-center mb-8">
        <Buildings size={56} className="mx-auto mb-3 text-primary" weight="duotone" />
        <h1 className="text-page font-bold text-text mb-1">会社のアドレスを入れます</h1>
        <p className="text-text-muted">招待のメールのページか、管理者から聞いたアドレスを入れてください</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="block text-body text-text-muted mb-2">会社のアドレス</span>
          <span className="relative block">
            <Globe size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full bg-bg border border-border-control rounded-control pl-10 pr-4 py-3 text-text placeholder:text-text-subtle focus:outline-none focus:border-focus-border"
              autoFocus
            />
          </span>
        </label>

        {error && (
          <div role="alert" className="flex items-center gap-2 p-3 rounded-control bg-danger-bg border border-danger-border">
            <WarningCircle size={20} className="text-danger-text flex-shrink-0" />
            <span className="text-body text-danger-text">{error}</span>
          </div>
        )}

        {validated && (
          <div className="flex items-center gap-2 p-3 rounded-control bg-success-bg border border-success-border">
            <CheckCircle size={20} className="text-success-text flex-shrink-0" />
            <span className="text-body text-success-text">つながりました</span>
          </div>
        )}

        <div className="flex gap-3">
          <button type="button" onClick={onBack} className="flex-1 rounded-control bg-bg hover:bg-surface-sunken text-text px-4 py-3">
            戻る
          </button>
          <button
            type="submit"
            disabled={isValidating || !url.trim() || validated}
            className="flex-1 flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover disabled:opacity-disabled disabled:cursor-not-allowed text-on-primary rounded-control px-4 py-3 transition-colors font-medium"
          >
            {isValidating ? <SpinnerGap size={20} className="animate-spin" /> : <>次へ<ArrowRight size={20} /></>}
          </button>
        </div>
      </form>
    </div>
  )
}
