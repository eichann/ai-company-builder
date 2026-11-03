// 設定 → 自分の設定: which department's 自分だけのフォルダ (.personal) holds 今日のフォルダ, on this PC
// (client/shared/today-folder.ts). The screen (AppShell) gives the departments and saves the choice.
import { useState } from 'react'
import { CalendarBlank } from '@phosphor-icons/react'
import { Card } from '../../../shared/ui/primitives'

export interface TodayFolderSettingProps {
  /** Departments downloaded on this PC, in the tabs' order. */
  choices: Array<{ id: string; name: string }>
  /** The member's choice; null = おまかせ. */
  chosenId: string | null
  /** What おまかせ uses now (the first 所属 department downloaded here); null = none. */
  defaultName: string | null
  /** The member chose a department that is not downloaded now (おまかせ is used meanwhile). */
  chosenMissingName: string | null
  /** Today's folder as it is now (company path), to show where it is. */
  folderNow: string | null
  onChoose: (departmentId: string | null) => void
}

const SELECT = 'h-8 max-w-[16rem] rounded-lg border border-zinc-200 bg-white px-2 text-[13px] text-zinc-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100'

export function TodayFolderSetting({ choices, chosenId, defaultName, chosenMissingName, folderNow, onChoose }: TodayFolderSettingProps) {
  const [error, setError] = useState<string | null>(null)
  const choose = (value: string) => {
    try { onChoose(value || null); setError(null) } catch { setError('保存できませんでした。もう一度お試しください') }
  }
  return (
    <div data-today-folder-setting><Card className="p-5">
      <div className="flex items-start gap-4">
        <CalendarBlank size={18} className="mt-0.5 shrink-0 text-indigo-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">今日のフォルダ</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            日付ごとのメモの置き場所です。あなたの Mac だけにあり、同期されません。ファイルの欄の「今日のフォルダを開く」と、自分だけのやることの「＋新しいファイル」がここを使います。
          </p>
          {folderNow && <p className="mt-1 truncate font-mono text-[11.5px] text-zinc-500 dark:text-zinc-400" title={folderNow}>{folderNow}/</p>}
          {chosenMissingName && <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">「{chosenMissingName}」はこのPCにダウンロードしていないため、{defaultName ? `「${defaultName}」を使っています。` : '今日のフォルダを作れません。'}</p>}
          {!defaultName && choices.length === 0 && <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">ダウンロードしている部署がありません。</p>}
          {error && <p role="alert" className="mt-1 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <label className="shrink-0">
          <span className="sr-only">今日のフォルダを置く部署</span>
          <select className={SELECT} value={chosenId && choices.some(c => c.id === chosenId) ? chosenId : ''} onChange={e => choose(e.target.value)}>
            <option value="">おまかせ{defaultName ? `（${defaultName}）` : ''}</option>
            {choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
    </Card></div>
  )
}
