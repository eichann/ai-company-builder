// 設定 → 自分の設定: the member's own 「受信を読む」 and 「AI が自動で進める」 (言葉の決まり 5c), 「AI に完了を頼めるようにする」
// (the member's alone, shown only when the server answers it; records.md "The AI at the member's request"), and
// 「届いた議事録を AI が自動で読む」 (MeetingAutoReadSetting).
// The company decides whether each may be used (管理画面の「詳しい設定」); one it stops is greyed
// with 「会社の設定で止まっています」 — in the warning colour, since an admin can turn it back on
// (design-system.md 「止まっている」の色). The server decides; this only shows and asks.
import { SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader, Switch } from '../../../shared/ui/primitives'
import { companyHasMailOrChat, CONNECT_MAIL_CHAT_TEXT, WORK_SWITCH_COMPANY_OFF_TEXT, WORK_SWITCH_NAMES, type WorkSwitch } from '../../../../shared/work-switches'
import { CALM } from '../../../../shared/thing-words'
import { useWorkSwitches } from '../hooks/useWorkSwitches'
import { MeetingAutoReadSetting } from './MeetingAutoReadSetting'
import { STOP_ICON, STOP_TEXT } from '../../../shared/ui/stateStyles'
import { STOP_LOOK } from '../../../../../shared/design-tokens/stop-meaning'

const SWITCHES: Array<{ key: WorkSwitch; title: string; text: string }> = [
  {
    key: 'readIncoming', title: WORK_SWITCH_NAMES.readIncoming,
    text: 'あなたのメール・Slack に来た連絡を AI が読み、返事が要るものを「返事のお願い」としてやることに入れます。',
  },
  {
    key: 'autoRun', title: WORK_SWITCH_NAMES.autoRun,
    text: '会議が終わったときなど、あなたの AI の番を AI が自分で始めます。オフなら「AI に進めてもらう」を押すまで待ちます。送る・承認するは、どちらでも必ず人です。',
  },
  {
    key: 'aiCompletes', title: WORK_SWITCH_NAMES.aiCompletes,
    text: 'AI との相談で「この7件を完了にして」のように頼むと、あなたが担当のやることを AI が完了にし、返事のお願いを「終わりにする」「もう返した」にします。頼んだときだけで、AI が自分の判断ですることはありません。片づけたものは相談の中に一覧で出て、そこから取り消せます。この設定はあなただけのものです。',
  },
]

/** `onOpenGoogle`: 受信を読む is on but Google has not let ACB read the mail yet — the way to 「Google で許可」. */
export function MySwitchesSection({ companyId, onOpenGoogle }: { companyId: string; onOpenGoogle?: () => void }) {
  const { loadRef, switches, error, companyOff, busy, change } = useWorkSwitches(companyId)
  return (
    <div ref={loadRef} className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader title="自分の設定" description="あなたの分だけの設定です。ほかの人には変わりません。" />
      {!switches && !error ? (
        <div className="flex items-center gap-2 py-10 text-body text-zinc-500"><SpinnerGap size={16} className="animate-spin" />{CALM.loading}</div>
      ) : !switches ? (
        <Callout tone="danger" role="alert">{error}</Callout>
      ) : (
        <>
          <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
            {SWITCHES.map(w => {
              const s = switches[w.key]
              // An older server answers no aiCompletes: no such switch then.
              if (!s) return null
              // No mail or chat in the company (owner decision 2026-11-03): one line on what connecting does, no switch.
              if (w.key === 'readIncoming' && !companyHasMailOrChat(switches)) {
                return (
                  <div key={w.key} data-connect-mail-chat className="p-5">
                    <p className="text-body font-medium">{CONNECT_MAIL_CHAT_TEXT.title}</p>
                    <p className="mt-0.5 text-small leading-relaxed text-zinc-500 dark:text-zinc-400">{CONNECT_MAIL_CHAT_TEXT.body}</p>
                  </div>
                )
              }
              return (
                <div key={w.key} data-my-switch={w.key} className="flex items-start gap-4 p-5">
                  <div className="min-w-0 flex-1">
                    {/* Only the switch's own words fade: the notice under them stays readable. */}
                    <div className={s.allowed ? '' : 'opacity-disabled'}>
                      <p className="text-body font-medium">{w.title}</p>
                      <p className="mt-0.5 text-small leading-relaxed text-zinc-500 dark:text-zinc-400">{w.text}</p>
                    </div>
                    {!s.allowed && (
                      <p data-company-off className={`mt-1 flex items-center gap-1 text-small font-strong ${STOP_TEXT.needsAction}`}>
                        <WarningCircle size={13} weight="fill" aria-hidden className={`shrink-0 ${STOP_ICON.needsAction}`} />
                        {WORK_SWITCH_COMPANY_OFF_TEXT}（使いたいときは、管理者に相談してください）
                      </p>
                    )}
                    {w.key === 'readIncoming' && s.on && !switches.readIncoming.connected.mail && (
                      <p data-needs-google className="mt-1.5 flex flex-wrap items-center gap-2 text-small text-warning-text">
                        メールを読むには、Google で許可が要ります。
                        {onOpenGoogle && <Button size="sm" onClick={onOpenGoogle}>Google で許可する</Button>}
                      </p>
                    )}
                  </div>
                  <Switch on={s.on} label={w.title} disabled={!s.allowed || busy !== null} onToggle={() => void change(w.key, !s.on)} className="" />
                </div>
              )
            })}
          </Card>
          {error && <Callout tone={companyOff ? STOP_LOOK.needsAction.variant : 'danger'} role="alert">{error}</Callout>}
          <p className="text-small text-zinc-500 dark:text-zinc-400">会社が使ってよいか・初めの値は、管理者が管理画面の「詳しい設定」で決めています。</p>
        </>
      )}
      <MeetingAutoReadSetting companyId={companyId} />
    </div>
  )
}
