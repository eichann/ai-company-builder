// 「仕事の道具をつなぐ」: what connecting Google and Slack lets ACB do, in plain words, with one
// button per service. Opens by itself once per member and company (`firstRun`, until connected
// or put off with 「あとで」; again only for what the company adds later), and from 設定.
import { useState } from 'react'
import { CheckCircle, Circle, GoogleLogo, SlackLogo, SpinnerGap } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Button, Callout, Card } from '../../../shared/ui/primitives'
import { GOOGLE_PRACTICE_TEXT } from '../../../../shared/google'
import { connectToolsOffer, connectToolsView, type ConnectToolItem, type ConnectToolsOffer } from '../connectTools'
import { useConnectTools } from '../hooks/useConnectTools'

interface Props {
  companyId: string
  /** Opened by itself after sign-in: shown only when something is new, as a dialog with 「あとで」. */
  firstRun?: boolean
}

export function ConnectToolsScreen({ companyId, firstRun = false }: Props) {
  const tools = useConnectTools(companyId)
  // First run: decided once, when the state has loaded, and kept while the member connects
  // (the server marks things shown at once; the screen must not change under them).
  const [offer, setOffer] = useState<ConnectToolsOffer | 'undecided' | 'closed'>(firstRun ? 'undecided' : { only: null })
  if (offer === 'undecided' && tools.loaded) setOffer(connectToolsOffer(tools.google, tools.slack) ?? 'closed')

  if (offer === 'undecided' || offer === 'closed' || offer === null) return firstRun ? <span ref={tools.loadRef} hidden /> : null
  const view = connectToolsView(tools.google, tools.slack, offer.only)

  const title = view.onlyNew ? '新しくつなぐもの' : '仕事の道具をつなぐ'
  const connectedNow = [...(view.google?.items ?? []), ...(view.slack?.items ?? [])].some(i => i.state === 'connected')
  const body = (
    <div ref={tools.loadRef} className="space-y-4">
      <div>
        <h2 className="text-[17px] font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          {view.onlyNew
            ? '会社で使えるものが増えました。つなぐと、次のことができるようになります。'
            : 'ふだん使っている Google や Slack とつなぐと、ACB でできることが増えます。つなぐのは一度だけで、いつでも設定から止められます。'}
        </p>
      </div>
      {!tools.loaded ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-zinc-500"><SpinnerGap size={16} className="animate-spin" />読み込み中…</div>
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
            />
          )}
        </>
      )}
      {tools.message && <p role="status" className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">{tools.message}</p>}
      {firstRun && (
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={tools.busy} onClick={async () => { await tools.later(); setOffer('closed') }}>
            {connectedNow ? '閉じる' : 'あとで'}
          </Button>
        </div>
      )}
      {firstRun && !connectedNow && (
        <p className="text-right text-[11px] text-zinc-500">あとからでも、設定の「仕事の道具をつなぐ」からつなげます。</p>
      )}
    </div>
  )

  if (!firstRun) return <div className="px-8 pb-8 pt-7">{body}</div>
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900">{body}</div>
    </div>
  )
}

function ServiceCard({ icon, name, account, items, hint, action }: {
  icon: ReactNode
  name: string
  account: string | null
  items: ConnectToolItem<string>[]
  hint: string | null
  action: ReactNode
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-[14px] font-medium text-zinc-900 dark:text-zinc-100">
        {icon}<span>{name}</span>
        {account && <span className="ml-auto truncate text-[12px] font-normal text-zinc-500">{account}</span>}
      </div>
      <ul className="space-y-1.5">
        {items.map(item => (
          <li key={item.feature} className="flex items-start gap-2 text-[13px] text-zinc-700 dark:text-zinc-200">
            {item.state === 'connected'
              ? <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-emerald-600" aria-label="つながっています" />
              : <Circle size={16} className="mt-0.5 shrink-0 text-zinc-400" aria-label="まだつないでいません" />}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
      {hint && <p className="text-[12px] text-zinc-500">{hint}</p>}
      {action ?? <p className="text-[12px] text-emerald-700 dark:text-emerald-400">つながっています</p>}
    </Card>
  )
}
