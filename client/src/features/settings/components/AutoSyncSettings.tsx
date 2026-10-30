import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { Card, SubHeading } from '../../../components/settings/ui'
import {
  autoSyncSettings,
  normalizeTimes,
  RECEIVE_INTERVALS,
  SEND_INTERVALS,
  type AutoSyncSettings as Settings,
} from '../../../shared/lib/autoSyncSettings'

// Settings → 同期 → 自動同期 (.claude/rules/sync.md "Automatic sync"): per member on this PC.

const SELECT = 'h-8 rounded-lg border border-zinc-200 bg-white px-2 text-[13px] text-zinc-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100'
const MUTED = 'text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400'

function Switch({ checked, label, describedBy, onChange }: { checked: boolean; label: string; describedBy: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={onChange}
      className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900 ${checked ? 'bg-indigo-600 dark:bg-indigo-500' : 'bg-zinc-300 dark:bg-white/20'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function Toggle({ title, description, checked, onChange, children }: { title: string; description: ReactNode; checked: boolean; onChange: () => void; children: ReactNode }) {
  const descriptionId = useId()
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <SubHeading>{title}</SubHeading>
          <p id={descriptionId} className={`mt-1 ${MUTED}`}>{description}</p>
        </div>
        <Switch checked={checked} label={title} describedBy={descriptionId} onChange={onChange} />
      </div>
      {children}
    </Card>
  )
}

export function AutoSyncSettings() {
  const settings = useSyncExternalStore(autoSyncSettings.subscribe, autoSyncSettings.getSnapshot)
  const [error, setError] = useState('')
  const [newTime, setNewTime] = useState('15:00')

  const save = (next: Settings) => {
    try { autoSyncSettings.set(next); setError('') } catch { setError('保存できませんでした。もう一度お試しください') }
  }
  const setReceive = (patch: Partial<Settings['receive']>) => save({ ...settings, receive: { ...settings.receive, ...patch } })
  const setSend = (patch: Partial<Settings['send']>) => save({ ...settings, send: { ...settings.send, ...patch } })
  const { receive, send } = settings

  return (
    <div className="space-y-4">
      <Toggle
        title="自動で受け取る"
        description="ほかのメンバーの変更を、決まった間隔で受け取ります。あなたの変更は送りません。あなたも変更しているファイルは、「サーバーと同期」を押したときに受け取ります。"
        checked={receive.enabled}
        onChange={() => setReceive({ enabled: !receive.enabled })}
      >
        <label className="flex items-center gap-3 text-[13px] text-zinc-700 dark:text-zinc-300">
          間隔
          <select
            className={SELECT}
            value={receive.intervalMinutes}
            disabled={!receive.enabled}
            onChange={e => setReceive({ intervalMinutes: Number(e.target.value) })}
          >
            {RECEIVE_INTERVALS.map(m => <option key={m} value={m}>{m}分ごと</option>)}
          </select>
        </label>
      </Toggle>

      <Toggle
        title="自動で送る"
        description="あなたの変更も含めて、「サーバーと同期」と同じことを自動で行います。確認が必要なこと（ファイルの削除など）があれば何も変えずに止まり、お知らせします。"
        checked={send.enabled}
        onChange={() => setSend({ enabled: !send.enabled, enabledAt: send.enabled ? send.enabledAt : Date.now() })}
      >
        <fieldset disabled={!send.enabled} className="space-y-3 disabled:opacity-50">
          <legend className="sr-only">送るタイミング</legend>
          <label className="flex items-center gap-2 text-[13px] text-zinc-700 dark:text-zinc-300">
            <input type="radio" name="auto-send-mode" checked={send.mode === 'times'} onChange={() => setSend({ mode: 'times' })} />
            決まった時刻に送る
          </label>
          {send.mode === 'times' && (
            <div className="ml-6 flex flex-wrap items-center gap-2" role="group" aria-label="送る時刻">
              {send.times.map(t => (
                <span key={t} className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 px-2 text-[13px] tabular-nums text-zinc-800 dark:border-white/10 dark:text-zinc-200">
                  {t}
                  {send.times.length > 1 && (
                    <button type="button" aria-label={`${t} を削除`} onClick={() => setSend({ times: send.times.filter(x => x !== t) })} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100">
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
              <input type="time" aria-label="追加する時刻" value={newTime} onChange={e => setNewTime(e.target.value)} className={SELECT} />
              <button
                type="button"
                onClick={() => setSend({ times: normalizeTimes([...send.times, newTime]) })}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-white/[0.06]"
              >
                <Plus size={12} />時刻を追加
              </button>
            </div>
          )}
          <label className="flex items-center gap-2 text-[13px] text-zinc-700 dark:text-zinc-300">
            <input type="radio" name="auto-send-mode" checked={send.mode === 'interval'} onChange={() => setSend({ mode: 'interval' })} />
            一定の間隔で送る
          </label>
          {send.mode === 'interval' && (
            <select
              aria-label="送る間隔"
              className={`ml-6 ${SELECT}`}
              value={send.intervalMinutes}
              onChange={e => setSend({ intervalMinutes: Number(e.target.value) })}
            >
              {SEND_INTERVALS.map(m => <option key={m} value={m}>{m >= 60 ? `${m / 60}時間ごと` : `${m}分ごと`}</option>)}
            </select>
          )}
        </fieldset>
      </Toggle>

      <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
        アプリを開いている間だけ動きます。保存していない編集があるとき、AIが作業しているとき、前回の同期で確認が必要なことが残っているときは、次の機会まで待ちます。アプリを閉じていた間の分は、開いたときに1回だけまとめて行います。設定はこのPCに自動保存されます。
      </p>
      {error && <p role="alert" className="text-[13px] text-amber-600 dark:text-amber-400">{error}</p>}
    </div>
  )
}
