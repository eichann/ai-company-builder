import { Lightning, FileText, Gear } from '@phosphor-icons/react'
import type { Skill } from '../../types'

interface SkillCardProps {
  skill: Skill
  color: string
  isSelected: boolean
  onSelect: () => void
  onExecute: () => void
}

export function SkillCard({ skill, color, isSelected, onSelect, onExecute }: SkillCardProps) {
  return (
    <div
      onClick={onSelect}
      className={`
        group relative p-5 rounded-2xl cursor-pointer
        transition-all duration-200 ease-out
        ${isSelected
          ? 'bg-gray-100 dark:bg-white/[0.08] scale-[1.02]'
          : 'bg-gray-50 dark:bg-white/[0.03] hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:scale-[1.01]'
        }
      `}
      style={{
        boxShadow: isSelected ? `0 0 0 2px ${color}` : undefined,
      }}
    >
      {/* Skill Icon/Indicator */}
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
        style={{ backgroundColor: `${color}20` }}
      >
        <FileText size={20} weight="fill" style={{ color }} />
      </div>

      {/* Skill Name */}
      <div className="flex items-center gap-2 mb-1.5">
        <h3 className="text-base font-semibold text-gray-900 dark:text-zinc-100">
          {skill.name}
        </h3>
        {skill.isNurturing && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
            育て中
          </span>
        )}
      </div>

      {/* Description */}
      <p className="text-sm text-gray-500 dark:text-zinc-500 line-clamp-2 mb-4">
        {skill.description}
      </p>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onExecute()
          }}
          className="
            flex items-center gap-1.5 px-3 py-1.5 rounded-lg
            text-xs font-medium
            transition-all duration-150
            hover:scale-105 active:scale-95
          "
          style={{
            backgroundColor: color,
            color: 'white',
          }}
        >
          <Lightning size={12} weight="fill" />
          実行
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation()
            onSelect()
          }}
          className="
            flex items-center gap-1.5 px-3 py-1.5 rounded-lg
            text-xs font-medium text-gray-500 dark:text-zinc-400
            bg-gray-200 dark:bg-white/[0.05] hover:bg-gray-300 dark:hover:bg-white/[0.08]
            transition-all duration-150
          "
        >
          <Gear size={12} />
          設定
        </button>
      </div>

      {/* Subtle glow on hover */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        style={{
          boxShadow: `inset 0 0 30px ${color}10`,
        }}
      />
    </div>
  )
}
