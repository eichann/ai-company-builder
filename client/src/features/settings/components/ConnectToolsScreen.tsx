// 「仕事の道具をつなぐ」: what connecting Google and Slack lets ACB do, in plain words, with one
// button per service. Opens by itself once per member and company (`firstRun`, until connected
// or put off with 「あとで」; again only for what the company adds later). In 設定 it is
// 「つないでいるサービス」's list, each card with 詳しく to that service's own section.
import { useState } from 'react'
import { CheckCircle, Circle, GoogleLogo, SlackLogo, SpinnerGap } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Button, Callout, Card } from '../../../shared/ui/primitives'
import { GOOGLE_PRACTICE_TEXT } from '../../../../shared/google'
import { connectToolsOffer, connectToolsView, type ConnectToolItem, type ConnectToolsOffer } from '../connectTools'
import { useConnectTools } from '../hooks/useConnectTools'
import { useWritingStyle } from '../hooks/useWritingStyle'
import { writingCheckOffered } from '../writingStyle'
import { WritingStyleSection } from './WritingStyleSection'
import { Dialog } from '../../../shared/ui/Dialog'

interface Props {
  companyId: string
  /** Opened by itself after sign-in: shown only when something is new, as a dialog with 「あとで」. */
  firstRun?: boolean
  /** In 設定: opens a service's own section from its card. */
  onOpenService?: (service: 'google' | 'slack') => void
}

export function ConnectToolsScreen({ companyId, firstRun = false, onOpenService }: Props) {
  const writing = useWritingStyle(companyId)
  const tools = useConnectTools(companyId, () => { void writing.afterConnect() })
  // First run: decided once, when the state has loaded, and kept while the member connects
  // (the server marks things shown at once; the screen must not change under them).
  const [offer, setOffer] = useState<ConnectToolsOffer | 'undecided' | 'closed'>(firstRun ? 'undecided' : { only: null })
  if (offer === 'undecided' && tools.loaded) setOffer(connectToolsOffer(tools.google, tools.slack) ?? 'closed')

  if (offer === 'undecided' || offer === 'closed' || offer === null) return firstRun ? <span ref={tools.loadRef} hidden /> : null
  const view = connectToolsView(tools.google, tools.slack, offer.only)

  const title = view.onlyNew ? '新しくつなぐもの' : firstRun ? '仕事の道具をつなぐ' : 'つないでいるサービス'
  const connectedNow = [...(view.google?.items ?? []), ...(view.slack?.items ?? [])].some(i => i.state === 'connected')
  const body = (
    <div ref={tools.loadRef} className="space-y-4">
      <div>
        <h2 className="text-heading font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
        <p className="mt-1 text-body leading-relaxed text-zinc-600 dark:text-zinc-300">
          {view.onlyNew
            ? '会社で使えるものが増えました。つなぐと、次のことができるようになります。'
            : !firstRun
            ? 'サービスごとに、いまの状態と、つなぐとできることが1か所にあります。やめ方や細かい設定は［詳しく］から。'
            : 'ふだん使っている Google や Slack とつなぐと、ACB でできることが増えます。つなぐのは一度だけで、いつでも設定から止められます。'}
        </p>
      </div>
      {!tools.loaded ? (
        <div className="flex items-center gap-2 py-6 text-body text-zinc-500"><SpinnerGap size={16} className="animate-spin" />読み込み中…</div>
      ) : !view.google && !view.slack ? (
        <Callout tone="info">いまは、会社でつなげるものがありません。管理者が Google や Slack を用意すると、ここからつなげます。</Callout>
      ) : (
        <>
          {tools.google?.practice && <Callout tone="info">{GOOGLE_PRACTICE_TEXT}</Callout>}
          {view.google && (
            <ServiceCard
              icon={<GoogleLogo size={18} weight="bold" />}
              name="Google"
              account={view.google.account}
              items={view.google.items}
              hint={view.google.canConnect ? view.google.domainHint : null}
              action={view.google.canConnect
                ? <Button variant="primary" disabled={tools.busy || tools.waiting} onClick={() => void tools.connectGoogle()}>Google でつなぐ</Button>
                : null}
              onDetail={onOpenService && (() => onOpenService('google'))}
            />
          )}
          {view.slack && (
            <ServiceCard
              icon={<SlackLogo size={18} weight="bold" />}
              name="Slack"
              account={null}
              items={view.slack.items}
              hint={view.slack.canConnect ? 'ACB に登録しているのと同じメールアドレスの Slack アカウントでつないでください。' : null}
              action={view.slack.canConnect
                ? <Button variant="primary" disabled={tools.busy || tools.waiting} onClick={() => void tools.connectSlack()}>Slack でつなぐ</Button>
                : null}
              onDetail={onOpenService && (() => onOpenService('slack'))}
            />
          )}
        </>
      )}
      {tools.loaded && (view.google || view.slack) && (
        <div ref={writing.loadRef}>
          {writingCheckOffered(writing.status) && <WritingStyleSection writing={writing} status={writing.status} />}
        </div>
      )}
      {tools.message && <p role="status" className="text-small leading-relaxed text-zinc-600 dark:text-zinc-300">{tools.message}</p>}
      {firstRun && (
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={tools.busy} onClick={async () => { await tools.later(); setOffer('closed') }}>
            {connectedNow ? '閉じる' : 'あとで'}
          </Button>
        </div>
      )}
      {firstRun && !connectedNow && (
        <p className="text-right text-caption font-normal text-zinc-500">あとからでも、設定の「つないでいるサービス」からつなげます。</p>
      )}
    </div>
  )

  if (!firstRun) return <div className="px-8 pb-8 pt-7">{body}</div>
  return (
    // Answered only with its buttons (「あとで」 records the choice): Esc and the scrim do nothing.
    <Dialog onClose={() => {}} label={title} dismissible={false} closeOnScrim={false} className="max-h-[90vh] overflow-y-auto">{body}</Dialog>
  )
}

function ServiceCard({ icon, name, account, items, hint, action, onDetail }: {
  icon: ReactNode
  name: string
  account: string | null
  items: ConnectToolItem<string>[]
  hint: string | null
  action: ReactNode
  onDetail?: () => void
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-[14px] font-medium text-zinc-900 dark:text-zinc-100">
        {icon}<span>{name}</span>
        {account && <span className="ml-auto truncate text-small font-normal text-zinc-500">{account}</span>}
      </div>
      <ul className="space-y-1.5">
        {items.map(item => (
          <li key={item.feature} className="flex items-start gap-2 text-body text-zinc-700 dark:text-zinc-200">
            {item.state === 'connected'
              ? <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-emerald-600" aria-label="つながっています" />
              : <Circle size={16} className="mt-0.5 shrink-0 text-zinc-400" aria-label="まだつないでいません" />}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
      {hint && <p className="text-small text-zinc-500">{hint}</p>}
      <div className="flex items-center gap-3">
        {action ?? <p className="text-small text-emerald-700 dark:text-emerald-400">つながっています</p>}
        {onDetail && <Button variant="secondary" size="sm" className="ml-auto" aria-label={`${name}を詳しく`} onClick={onDetail}>詳しく</Button>}
      </div>
    </Card>
  )
}
