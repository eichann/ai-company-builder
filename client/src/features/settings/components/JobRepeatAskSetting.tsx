// 設定 → AI に任せること: 「AI から定期の仕事を提案してもらう」 (jobs.md "Asking after repeats (PR D)"). This PC's own setting for
// the member in this company (main keeps it beside the count, features/jobs/repeat-asks.ts); on unless turned off.
import { useCallback, useId, useRef, useState } from 'react'
import { CalendarCheck } from '@phosphor-icons/react'
import { Card, Switch } from '../../../shared/ui/primitives'
import { getJobRepeatAsk, setJobRepeatAsk } from '../api'

export const JOB_REPEAT_ASK_TITLE = 'AI から定期の仕事を提案してもらう'
export const JOB_REPEAT_ASK_TEXT =
  '同じ Skill を使った仕事を、別々の日に3回 AI に頼むと、AI が1回だけ「毎週同じ時間にやりましょうか？」と聞きます。' +
  '「いいえ」と答えた仕事は、もう聞きません。数えているのはこの PC の中だけで、会話の中身は残しません。この PC だけの設定です。'

export function JobRepeatAskSetting({ companyId }: { companyId: string }) {
  const descriptionId = useId()
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  // Read when the row mounts (a callback ref, committed like an effect: renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void getJobRepeatAsk(companyId).then(r => (r?.success ? setOn(r.on) : setError('読み込めませんでした。')), () => setError('読み込めませんでした。'))
  }, [companyId])
  const toggle = async () => {
    if (on === null) return
    try {
      const r = await setJobRepeatAsk(companyId, !on)
      if (r?.success) { setOn(r.on); setError('') } else setError('保存できませんでした。もう一度お試しください')
    } catch { setError('保存できませんでした。もう一度お試しください') }
  }
  return (
    <div ref={loadRef} data-job-repeat-ask-setting><Card className="p-5">
      <div className="flex items-start gap-4">
        <CalendarCheck size={18} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium">{JOB_REPEAT_ASK_TITLE}</p>
          <p id={descriptionId} className="mt-0.5 text-small leading-relaxed text-text-muted">{JOB_REPEAT_ASK_TEXT}</p>
          {error && <p role="alert" className="mt-1 text-small text-text-muted">{error}</p>}
        </div>
        <Switch on={on === true} onToggle={() => void toggle()} label={JOB_REPEAT_ASK_TITLE} describedBy={descriptionId} disabled={on === null} />
      </div>
    </Card></div>
  )
}
