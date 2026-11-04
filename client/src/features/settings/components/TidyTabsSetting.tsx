// 設定 → 自分の設定: 「前の日のタブを自動で片づける」 (per Mac, on unless turned off). The screen
// (AppShell) gives the switch's state and saves it (features/editor/tidyTabs.ts).
import { useId } from 'react'
import { Broom } from '@phosphor-icons/react'
import { Card, Switch } from '../../../shared/ui/primitives'

export function TidyTabsSetting({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const descriptionId = useId()
  return (
    <div data-tidy-tabs-setting><Card className="p-5">
      <div className="flex items-start gap-4">
        <Broom size={18} className="mt-0.5 shrink-0 text-indigo-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">前の日のタブを自動で片づける</p>
          <p id={descriptionId} className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            その日はじめてアプリを開いたとき、前の日までに開いていたタブ（固定したもの以外）を「片づけたタブ」にしまいます。タブの右の「…」からいつでも開き直せます。この Mac だけの設定です。
          </p>
        </div>
        <Switch on={on} onToggle={() => onChange(!on)} label="前の日のタブを自動で片づける" describedBy={descriptionId} />
      </div>
    </Card></div>
  )
}
