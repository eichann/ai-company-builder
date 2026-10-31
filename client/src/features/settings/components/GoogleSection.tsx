// Settings → 「Google」: the member allows ACB to read their calendar and the
// meeting notes, and later to send mail, with their own company Google account.
// The browser does the allowing; the app never holds anything of it.
import { useState } from 'react'
import { SpinnerGap } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader } from '../../../shared/ui/primitives'
import { GOOGLE_PRACTICE_TEXT, googleSectionView } from '../../../../shared/google'
import { useGoogle } from '../hooks/useGoogle'

export function GoogleSection({ companyId }: { companyId: string }) {
  const { loadRef, data, error, message, busy, waiting, connect, disconnect } = useGoogle(companyId)
  const [confirming, setConfirming] = useState(false)
  const view = data ? googleSectionView(data) : null

  return (
    <div ref={loadRef} className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader
        title="Google"
        description="あなたの Google アカウントで「Google で許可」をすると、ACB が予定と議事録を読めるようになります。メールは、あなたが画面で送るときだけ送ります。いつでも「許可をやめる」で止められます。"
      />
      {!data && !error ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-zinc-500"><SpinnerGap size={16} className="animate-spin" />読み込み中…</div>
      ) : !data || !view ? (
        <Callout tone="warning" role="alert">{error}</Callout>
      ) : (
        <>
          {data.practice && <Callout tone="info">{GOOGLE_PRACTICE_TEXT}</Callout>}
          {view.notice && <Callout tone="warning">{view.notice}</Callout>}
          <Card className="space-y-3 p-5">
            {view.account ? (
              <>
                <p className="text-[13px]">許可した Google アカウント: <span className="font-medium">{view.account}</span></p>
                <div className="text-[13px]">
                  <p className="text-zinc-500">許可していること</p>
                  <ul className="mt-1 list-disc pl-5">
                    {view.allowed.map(label => <li key={label}>{label}</li>)}
                  </ul>
                </div>
              </>
            ) : (
              <p className="text-[13px] text-zinc-600 dark:text-zinc-300">まだ許可していません。</p>
            )}
            {view.domainHint && (view.connectFeatures || view.canAddMail) && (
              <p className="text-[12px] text-zinc-500">{view.domainHint}</p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {view.connectFeatures && (
                <Button size="sm" variant="primary" disabled={busy || waiting} onClick={() => void connect(view.connectFeatures!)}>Google で許可</Button>
              )}
              {view.canAddMail && (
                <Button size="sm" disabled={busy || waiting} onClick={() => void connect(['mail'])}>メールを送る許可も足す</Button>
              )}
              {view.canDisconnect && !confirming && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>許可をやめる</Button>
              )}
            </div>
            {confirming && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-3 text-[13px] dark:bg-white/[0.04]">
                <span>Google の許可をやめますか？ ACB は予定や議事録を読めなくなり、メールも送れなくなります。</span>
                <Button size="sm" variant="primary" disabled={busy} onClick={async () => { await disconnect(); setConfirming(false) }}>許可をやめる</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>やめない</Button>
              </div>
            )}
            {message && <p role="status" className="text-[12px] text-zinc-600 dark:text-zinc-300">{message}</p>}
          </Card>
        </>
      )}
    </div>
  )
}
