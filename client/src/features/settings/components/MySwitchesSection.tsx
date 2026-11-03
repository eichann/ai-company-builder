// 設定 → 自分の設定: the member's own 「受信を読む」 and 「AI が自動で進める」 (言葉の決まり 5c).
// The company decides whether each may be used (管理画面の「詳しい設定」); one it stops is greyed
// with 「会社の設定で止まっています」. The server decides; this only shows and asks.
import { SpinnerGap } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader } from '../../../shared/ui/primitives'
import { companyHasMailOrChat, CONNECT_MAIL_CHAT_TEXT, WORK_SWITCH_COMPANY_OFF_TEXT, type WorkSwitch } from '../../../../shared/work-switches'
import { CALM } from '../../../../shared/thing-words'
import { useWorkSwitches } from '../hooks/useWorkSwitches'

const SWITCHES: Array<{ key: WorkSwitch; title: string; text: string }> = [
  {
    key: 'readIncoming', title: '受信を読む',
    text: 'あなたのメール・Slack に来た連絡を AI が読み、返事が要るものを「返事のお願い」としてやることに入れます。',
  },
  {
    key: 'autoRun', title: 'AI が自動で進める',
    text: '会議が終わったときなど、あなたの AI の番を AI が自分で始めます。オフなら「AI に進めてもらう」を押すまで待ちます。送る・承認するは、どちらでも必ず人です。',
  },
]

function Toggle({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'bg-indigo-600' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  )
}

/** `onOpenGoogle`: 受信を読む is on but Google has not let ACB read the mail yet — the way to 「Google で許可」. */
export function MySwitchesSection({ companyId, onOpenGoogle }: { companyId: string; onOpenGoogle?: () => void }) {
  const { loadRef, switches, error, busy, change } = useWorkSwitches(companyId)
  return (
    <div ref={loadRef} className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader title="自分の設定" description="あなたの分だけの設定です。ほかの人には変わりません。" />
      {!switches && !error ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-zinc-500"><SpinnerGap size={16} className="animate-spin" />{CALM.loading}</div>
      ) : !switches ? (
        <Callout tone="warning" role="alert">{error}</Callout>
      ) : (
        <>
          <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
            {SWITCHES.map(w => {
              const s = switches[w.key]
              // No mail or chat in the company (owner decision 2026-11-03): one line on what connecting does, no switch.
              if (w.key === 'readIncoming' && !companyHasMailOrChat(switches)) {
                return (
                  <div key={w.key} data-connect-mail-chat className="p-5">
                    <p className="text-[13.5px] font-medium">{CONNECT_MAIL_CHAT_TEXT.title}</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">{CONNECT_MAIL_CHAT_TEXT.body}</p>
                  </div>
                )
              }
              return (
                <div key={w.key} data-my-switch={w.key} className={`flex items-start gap-4 p-5 ${s.allowed ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium">{w.title}</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">{w.text}</p>
                    {!s.allowed && <p className="mt-1 text-[12px] font-medium text-amber-700 dark:text-amber-300">{WORK_SWITCH_COMPANY_OFF_TEXT}</p>}
                    {w.key === 'readIncoming' && s.on && !switches.readIncoming.connected.mail && (
                      <p data-needs-google className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-amber-700 dark:text-amber-300">
                        メールを読むには、Google で許可が要ります。
                        {onOpenGoogle && <Button size="sm" onClick={onOpenGoogle}>Google で許可する</Button>}
                      </p>
                    )}
                  </div>
                  <Toggle on={s.on} label={w.title} disabled={!s.allowed || busy !== null} onChange={on => void change(w.key, on)} />
                </div>
              )
            })}
          </Card>
          {error && <Callout tone="warning" role="alert">{error}</Callout>}
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">会社が使ってよいか・初めの値は、管理者が管理画面の「詳しい設定」で決めています。</p>
        </>
      )}
    </div>
  )
}
