import { useState } from 'react'
import { ArrowRight, Check, CloudArrowDown } from '@phosphor-icons/react'
import { NOTHING_PICKED, pickedDownload, togglePick, type DepartmentPick, type PickableDepartment } from '../model'
import { BACK_BUTTON, ScreenHeading } from './SelectorParts'

/**
 * Which departments a first setup puts on this PC; the rest can be added later. 「すべての部署」 is a
 * choice of its own: with nothing chosen the button waits (never 「すべて」 by itself). Rendered only
 * while shown, so every visit starts with nothing chosen.
 */
export function DepartmentPicker({ departments, onBack, onDownload }: {
  departments: PickableDepartment[]
  onBack: () => void
  /** 'all' = every department; else the chosen folders in the list's order. */
  onDownload: (folders: 'all' | string[]) => void
}) {
  const [pick, setPick] = useState<DepartmentPick>(NOTHING_PICKED)
  const download = pickedDownload(departments, pick)

  return (
    <div className="space-y-6">
      <ScreenHeading icon={CloudArrowDown} title="この PC に置く部署を選ぶ">
        この PC にダウンロードする部署を選んでください。選ばなかった部署も一覧には出ていて、あとからいつでもダウンロードできます
      </ScreenHeading>

      <div role="group" aria-label="この PC に置く部署" className="space-y-2 max-h-80 overflow-y-auto">
        <Option label="すべての部署" detail={`${departments.length} 部署`} picked={pick.all} onPress={() => setPick(p => togglePick(p, { all: true }))} />
        {departments.map(dept => (
          <Option key={dept.id} label={dept.name} detail={`${dept.folder}/`} mono picked={!pick.all && pick.folders.has(dept.folder)}
            onPress={() => setPick(p => togglePick(p, { folder: dept.folder }))} />
        ))}
      </div>

      <p className="text-xs text-text-muted">
        全社で共有しているファイル（Skill など）は、どれを選んでもダウンロードされます。
      </p>

      <div className="flex gap-3">
        <button onClick={onBack} className={BACK_BUTTON}>
          戻る
        </button>
        <button
          disabled={download === null}
          onClick={() => { if (download !== null) onDownload(download) }}
          className="flex-1 flex items-center justify-center gap-2 bg-primary enabled:hover:bg-primary-hover text-on-primary rounded-control px-4 py-3 transition-colors disabled:opacity-disabled disabled:cursor-not-allowed"
        >
          {download === 'all' ? 'すべての部署をダウンロード'
            : download ? `選んだ部署をダウンロード（${download.length}）`
            : '部署を選んでください'}
          {download !== null && <ArrowRight size={18} />}
        </button>
      </div>
    </div>
  )
}

function Option({ label, detail, mono, picked, onPress }: { label: string; detail: string; mono?: boolean; picked: boolean; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={picked}
      className={`w-full flex items-center gap-3 p-3 rounded-control border transition-colors text-left ${
        picked ? 'border-primary bg-selected-bg' : 'border-[color:var(--color-border)] hover:border-selected-border'
      }`}
    >
      <div className={`w-5 h-5 rounded-small border flex items-center justify-center flex-shrink-0 ${
        picked ? 'bg-primary border-primary' : 'border-[color:var(--color-border)]'
      }`}>
        {picked && <Check size={14} className="text-on-primary" weight="bold" />}
      </div>
      <span className="flex-1 text-text">{label}</span>
      <span className={`text-xs text-text-muted ${mono ? 'font-mono' : ''}`}>{detail}</span>
    </button>
  )
}
