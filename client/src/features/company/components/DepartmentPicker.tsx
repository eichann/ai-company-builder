import { useState } from 'react'
import { ArrowRight, Check, CloudArrowDown } from '@phosphor-icons/react'
import type { PickableDepartment } from '../model'
import { BACK_BUTTON, ScreenHeading } from './SelectorParts'

/**
 * Which departments a first setup downloads; the rest can be added later in
 * settings. Rendered only while shown, so every visit starts with none picked.
 */
export function DepartmentPicker({ departments, onBack, onDownload }: {
  departments: PickableDepartment[]
  onBack: () => void
  /** The picked folders in the list's order; none picked = everything. */
  onDownload: (folders: string[]) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set())

  function toggle(folder: string) {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <ScreenHeading icon={CloudArrowDown} title="所属する部署を選択">
        所属する部署を選んでください。他の部署はあとから設定でダウンロードできます
      </ScreenHeading>

      <div className="space-y-2 max-h-80 overflow-y-auto">
        {departments.map(dept => {
          const isPicked = picked.has(dept.folder)
          return (
            <button
              key={dept.id}
              onClick={() => toggle(dept.folder)}
              aria-pressed={isPicked}
              className={`w-full flex items-center gap-3 p-3 rounded-control border transition-colors text-left ${
                isPicked ? 'border-primary bg-selected-bg' : 'border-[color:var(--color-border)] hover:border-selected-border'
              }`}
            >
              <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 ${
                isPicked ? 'bg-primary border-primary' : 'border-[color:var(--color-border)]'
              }`}>
                {isPicked && <Check size={14} className="text-on-primary" weight="bold" />}
              </div>
              <span className="flex-1 text-text">{dept.name}</span>
              <span className="text-xs text-text-muted font-mono">{dept.folder}/</span>
            </button>
          )
        })}
      </div>

      <p className="text-xs text-text-muted">
        全社で共有しているファイル（スキルなど）は常にダウンロードされます。部署を選ばない場合は、すべての部署をダウンロードします。
      </p>

      <div className="flex gap-3">
        <button onClick={onBack} className={BACK_BUTTON}>
          戻る
        </button>
        <button
          onClick={() => onDownload(departments.map(d => d.folder).filter(f => picked.has(f)))}
          className="flex-1 flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary rounded-control px-4 py-3 transition-colors"
        >
          {picked.size > 0
            ? `選んだ部署をダウンロード（${picked.size}）`
            : 'すべての部署をダウンロード'}
          <ArrowRight size={18} />
        </button>
      </div>
    </div>
  )
}
