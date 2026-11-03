// Settings → 「Slack」: the member allows ACB to receive their DMs and mentions
// (and later to send replies they confirmed) with their own Slack account, and
// chooses whether 「あなたの番」 notices come as a DM from the company's bot.
// The browser does the allowing; the app never holds anything of it.
import { useState } from 'react'
import { SpinnerGap } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader } from '../../../shared/ui/primitives'
import { SLACK_PRACTICE_TEXT, slackSectionView } from '../../../../shared/slack'
import { useSlack } from '../hooks/useSlack'

export function SlackSection({ companyId }: { companyId: string }) {
  const { loadRef, data, error, message, busy, waiting, connect, disconnect, setNotices } = useSlack(companyId)
  const [confirming, setConfirming] = useState(false)
  const view = data ? slackSectionView(data) : null

  return (
    <div ref={loadRef} className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader
        title="Slack"
        description="会社の Slack で「Slack で許可」をすると、あなたあての DM とメンションが届いたことを ACB が受け取ります（中身は ACB に残しません）。「あなたの番」になったときは、会社の Slack のボットが DM で知らせます（件名だけ）。いつでも「許可をやめる」で止められます。"
      />
      {!data && !error ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-zinc-500"><SpinnerGap size={16} className="animate-spin" />読み込み中…</div>
      ) : !data || !view ? (
        <Callout tone="warning" role="alert">{error}</Callout>
      ) : (
        <>
          {data.practice && <Callout tone="info">{SLACK_PRACTICE_TEXT}</Callout>}
          {view.notice && <Callout tone="warning">{view.notice}</Callout>}
          <Card className="space-y-3 p-5">
            {view.connected ? (
              <div className="text-[13px]">
                <p className="text-zinc-500">許可していること</p>
                <ul className="mt-1 list-disc pl-5">
                  {view.allowed.map(label => <li key={label}>{label}</li>)}
                </ul>
              </div>
            ) : (
              <p className="text-[13px] text-zinc-600 dark:text-zinc-300">まだ許可していません。</p>
            )}
            {view.notices && (
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={view.notices.on} disabled={busy} onChange={e => void setNotices(e.target.checked)} />
                「あなたの番」になったら Slack の DM で知らせてもらう
              </label>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {view.connectFeatures && (
                <Button size="sm" variant="primary" disabled={busy || waiting} onClick={() => void connect(view.connectFeatures!)}>Slack で許可</Button>
              )}
              {view.canAddReply && (
                <Button size="sm" disabled={busy || waiting} onClick={() => void connect(['reply'])}>返事を送る許可も足す</Button>
              )}
              {view.canDisconnect && !confirming && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>許可をやめる</Button>
              )}
            </div>
            {confirming && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-3 text-[13px] dark:bg-white/[0.04]">
                <span>Slack の許可をやめますか？ ACB は DM やメンションを受け取れなくなり、Slack への知らせも止まります。</span>
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
