import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, CircleNotch, Lightning, CaretRight, Flask, Globe, Copy } from '@phosphor-icons/react'
import { SkillCard } from './SkillCard'
import type { Skill } from '../../types'

interface SkillGridProps {
  skills: Skill[]
  color: string
  selectedSkillId: string | null
  onSelectSkill: (id: string) => void
  onExecuteSkill: (id: string) => void
  onAddSkill: () => void
  onCopySkill?: () => void
  isLoading?: boolean
}

/** Group skills by their `group` field, preserving order of first appearance */
function groupSkills(skills: Skill[]): Map<string, Skill[]> {
  const groups = new Map<string, Skill[]>()
  for (const skill of skills) {
    const key = skill.group || ''
    const arr = groups.get(key)
    if (arr) {
      arr.push(skill)
    } else {
      groups.set(key, [skill])
    }
  }
  return groups
}

export function SkillGrid({
  skills,
  color,
  selectedSkillId,
  onSelectSkill,
  onExecuteSkill,
  onAddSkill,
  onCopySkill,
  isLoading = false,
}: SkillGridProps) {
  const { t } = useTranslation()
  const [isPrivateExpanded, setIsPrivateExpanded] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const toggleGroup = useCallback((groupName: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupName)) {
        next.delete(groupName)
      } else {
        next.add(groupName)
      }
      return next
    })
  }, [])

  const publicSkills = useMemo(() => skills.filter(s => !s.isPrivate), [skills])
  const privateSkills = useMemo(() => skills.filter(s => s.isPrivate), [skills])
  const groupedPublic = useMemo(() => groupSkills(publicSkills), [publicSkills])
  const groupedPrivate = useMemo(() => groupSkills(privateSkills), [privateSkills])
  const hasMultipleGroups = groupedPublic.size > 1 || (groupedPublic.size === 1 && !groupedPublic.has(''))

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-zinc-500">
        <CircleNotch size={32} className="animate-spin mb-3" />
        <p className="text-sm">{t('skills.loading')}</p>
      </div>
    )
  }

  if (skills.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6">
        <div className="text-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-zinc-800/50 flex items-center justify-center mx-auto mb-4">
            <Lightning size={32} className="text-gray-400 dark:text-zinc-600" />
          </div>
          <h3 className="text-gray-700 dark:text-zinc-300 font-medium mb-2">{t('skills.empty')}</h3>
          <p className="text-gray-500 dark:text-zinc-500 text-sm">
            {t('skills.emptyDescription')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onAddSkill}
            className="
              flex items-center gap-2 px-4 py-2 rounded-lg
              bg-gray-200 dark:bg-zinc-800 hover:bg-gray-300 dark:hover:bg-zinc-700
              text-gray-700 dark:text-zinc-300 text-sm font-medium
              transition-colors
            "
          >
            <Plus size={16} />
            {t('skills.createNew')}
          </button>
          {onCopySkill && (
            <button
              onClick={onCopySkill}
              className="
                flex items-center gap-2 px-4 py-2 rounded-lg
                bg-gray-200 dark:bg-zinc-800 hover:bg-gray-300 dark:hover:bg-zinc-700
                text-gray-700 dark:text-zinc-300 text-sm font-medium
                transition-colors
              "
            >
              <Copy size={16} />
              {t('skills.copyFromOther', '他からコピー')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-zinc-200">
          {t('skills.title')}
          <span className="ml-2 text-sm font-normal text-gray-500 dark:text-zinc-500">
            {t('skills.count', { count: publicSkills.length })}
          </span>
        </h2>
      </div>

      {/* Published Skills — grouped by hierarchy */}
      {hasMultipleGroups ? (
        // Multiple groups: render with section headers
        Array.from(groupedPublic.entries()).map(([groupName, groupSkills]) => {
          const isCollapsed = collapsedGroups.has(groupName)
          return (
            <div key={groupName} className="mb-6">
              <button
                onClick={() => toggleGroup(groupName)}
                className="flex items-center gap-2 mb-3 w-full text-left hover:opacity-80 transition-opacity"
              >
                <CaretRight
                  size={14}
                  className={`text-gray-400 dark:text-zinc-500 flex-shrink-0 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
                />
                {groupName === '全社' && (
                  <Globe size={14} className="text-gray-400 dark:text-zinc-500 flex-shrink-0" />
                )}
                <span className="text-xs font-semibold tracking-wide uppercase text-gray-500 dark:text-zinc-500">
                  {groupName}
                </span>
                <span className="text-xs text-gray-400 dark:text-zinc-600">({groupSkills.length})</span>
                <div className="flex-1 border-t border-gray-200 dark:border-zinc-800" />
              </button>
              {!isCollapsed && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {groupSkills.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      color={color}
                      isSelected={selectedSkillId === skill.id}
                      onSelect={() => onSelectSkill(skill.id)}
                      onExecute={() => onExecuteSkill(skill.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })
      ) : (
        // Single group or no groups: flat grid (backward compatible)
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {publicSkills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              color={color}
              isSelected={selectedSkillId === skill.id}
              onSelect={() => onSelectSkill(skill.id)}
              onExecute={() => onExecuteSkill(skill.id)}
            />
          ))}
        </div>
      )}

      {/* Add New Skill Cards */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${hasMultipleGroups ? '' : 'mt-4'}`}>
        <button
          onClick={onAddSkill}
          className="
            group p-5 rounded-2xl
            border-2 border-dashed border-gray-300 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500
            flex flex-col items-center justify-center gap-3
            min-h-[180px]
            transition-all duration-200
            hover:bg-gray-50 dark:hover:bg-white/[0.02]
          "
        >
          <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-zinc-800 group-hover:bg-gray-200 dark:group-hover:bg-zinc-700 flex items-center justify-center transition-colors">
            <Plus size={24} className="text-gray-400 dark:text-zinc-500 group-hover:text-gray-600 dark:group-hover:text-zinc-300" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-gray-500 dark:text-zinc-400 group-hover:text-gray-700 dark:group-hover:text-zinc-300">
              {t('skills.addNew')}
            </p>
            <p className="text-xs text-gray-400 dark:text-zinc-600 mt-1">
              {t('skills.addDescription')}
            </p>
          </div>
        </button>

        {onCopySkill && (
          <button
            onClick={onCopySkill}
            className="
              group p-5 rounded-2xl
              border-2 border-dashed border-gray-300 dark:border-zinc-700 hover:border-gray-400 dark:hover:border-zinc-500
              flex flex-col items-center justify-center gap-3
              min-h-[180px]
              transition-all duration-200
              hover:bg-gray-50 dark:hover:bg-white/[0.02]
            "
          >
            <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-zinc-800 group-hover:bg-gray-200 dark:group-hover:bg-zinc-700 flex items-center justify-center transition-colors">
              <Copy size={24} className="text-gray-400 dark:text-zinc-500 group-hover:text-gray-600 dark:group-hover:text-zinc-300" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-gray-500 dark:text-zinc-400 group-hover:text-gray-700 dark:group-hover:text-zinc-300">
                {t('skills.copyFromOther', '他からコピー')}
              </p>
              <p className="text-xs text-gray-400 dark:text-zinc-600 mt-1">
                {t('skills.copyDescription', '他の部署や全社のスキルをコピー')}
              </p>
            </div>
          </button>
        )}
      </div>

      {/* Private Skills (collapsible, grouped) */}
      {privateSkills.length > 0 && (
        <div className="mt-8">
          <button
            onClick={() => setIsPrivateExpanded(!isPrivateExpanded)}
            className="
              flex items-center gap-2 w-full py-2
              text-sm text-gray-500 dark:text-zinc-500
              hover:text-gray-700 dark:hover:text-zinc-300
              transition-colors
            "
          >
            <CaretRight
              size={14}
              className={`transition-transform duration-200 ${isPrivateExpanded ? 'rotate-90' : ''}`}
            />
            <Flask size={14} />
            <span className="font-medium">非公開</span>
            <span className="text-xs text-gray-400 dark:text-zinc-600">({privateSkills.length})</span>
            <div className="flex-1 border-t border-gray-200 dark:border-zinc-800 ml-2" />
          </button>

          {isPrivateExpanded && (
            groupedPrivate.size > 1 ? (
              Array.from(groupedPrivate.entries()).map(([groupName, groupSkills]) => {
                const privateKey = `private:${groupName}`
                const isCollapsed = collapsedGroups.has(privateKey)
                return (
                  <div key={groupName} className="mt-4">
                    <button
                      onClick={() => toggleGroup(privateKey)}
                      className="flex items-center gap-2 mb-3 w-full text-left hover:opacity-80 transition-opacity"
                    >
                      <CaretRight
                        size={14}
                        className={`text-gray-400 dark:text-zinc-500 flex-shrink-0 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
                      />
                      {groupName === '全社' && (
                        <Globe size={14} className="text-gray-400 dark:text-zinc-500 flex-shrink-0" />
                      )}
                      <span className="text-xs font-semibold tracking-wide uppercase text-gray-500 dark:text-zinc-500">
                        {groupName}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-zinc-600">({groupSkills.length})</span>
                      <div className="flex-1 border-t border-gray-200 dark:border-zinc-800" />
                    </button>
                    {!isCollapsed && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {groupSkills.map((skill) => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            color={color}
                            isSelected={selectedSkillId === skill.id}
                            onSelect={() => onSelectSkill(skill.id)}
                            onExecute={() => onExecuteSkill(skill.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                {privateSkills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    color={color}
                    isSelected={selectedSkillId === skill.id}
                    onSelect={() => onSelectSkill(skill.id)}
                    onExecute={() => onExecuteSkill(skill.id)}
                  />
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
