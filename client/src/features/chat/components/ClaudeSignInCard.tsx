import { useState } from 'react'
import { CircleNotch } from '@phosphor-icons/react'
import { claudeAccountNotice, type ClaudeSignInResult } from '../../../../shared/claude-sign-in'
import type { ClaudeCodeStatus } from '../../../../shared/ipc-contract'
import { cancelClaudeSignIn, openClaudeSignInPage, openInBrowser, startClaudeSignIn } from '../api'
import { claudeSetupStep, CLAUDE_SETUP_GUIDE_URL } from '../claudeSetup'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

/**
 * Getting Claude Code ready without a terminal: install guidance when it is missing, and
 * 「Claude にログインする」, which starts the official CLI's own sign-in in the browser.
 */
export function ClaudeSignInCard({ status, root, onRecheck }: { status: ClaudeCodeStatus | null; root: string | undefined; onRecheck: () => void }) {
  const [waiting, setWaiting] = useState(false)
  const [result, setResult] = useState<ClaudeSignInResult | null>(null)
  const [pageMissing, setPageMissing] = useState(false)
  const step = claudeSetupStep(status)
  const notice = claudeAccountNotice(status?.signIn)

  async function signIn() {
    setWaiting(true)
    setResult(null)
    setPageMissing(false)
    try {
      const answer = await startClaudeSignIn(root)
      setResult(answer)
      // Unverified: the chat's own check decides (an unreadable answer opens it, as before).
      if (answer.outcome === 'signed-in' || answer.outcome === 'unverified') onRecheck()
    } catch {
      setResult({ outcome: 'failed', message: 'ログインを始められませんでした。もう一度お試しください。' })
    } finally {
      setWaiting(false)
    }
  }

  async function openPageAgain() {
    setPageMissing(!(await openClaudeSignInPage().catch(() => false)))
  }

  if (step === 'install') {
    return (
      <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-left">
        <p className="text-sm font-medium text-ink">このパソコンに Claude Code が入っていません</p>
        <p className="text-xs text-ink-muted">AI に相談するには、Anthropic の Claude Code が必要です。入れ方のページを開き、案内のとおりに入れてから「もう一度確かめる」を押してください。</p>
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={() => void openInBrowser(CLAUDE_SETUP_GUIDE_URL)} className="text-xs text-link">入れ方を見る</button>
          <button type="button" onClick={onRecheck} className="text-xs text-link">もう一度確かめる</button>
        </div>
      </div>
    )
  }

  if (step === 'sign-in') {
    return (
      <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-left">
        <p className="text-sm font-medium text-ink">Claude へのログインが必要です</p>
        {waiting ? (
          <>
            <p className="flex items-center gap-2 text-xs text-ink-muted" role="status">
              <CircleNotch size={14} className="animate-spin text-primary" />
              ブラウザで Anthropic のログイン画面を開きました。会社の Claude のアカウントでログインすると、ここに自動で戻ります。
            </p>
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={() => void openPageAgain()} className="text-xs text-link">ブラウザが開かないとき</button>
              <button type="button" onClick={() => void cancelClaudeSignIn()} className="text-xs text-ink-muted">やめる</button>
            </div>
            {pageMissing && <p className="text-xs text-ink-muted">まだログイン画面の準備ができていません。少し待ってからもう一度押してください。</p>}
          </>
        ) : (
          <>
            <p className="text-xs text-ink-muted">ボタンを押すと、ブラウザで Anthropic のログイン画面が開きます。パスワードなどはこのアプリには渡りません。</p>
            {result && result.outcome !== 'signed-in' && <p role="alert" className="text-xs text-amber-400">{result.message}</p>}
            <button type="button" onClick={() => void signIn()} className={`mt-1 rounded-lg px-4 py-2 text-sm font-medium ${PRIMARY_ACTION}`}>
              Claude にログインする
            </button>
          </>
        )}
      </div>
    )
  }

  return notice ? <p className="text-xs text-amber-400">{notice}</p> : null
}
