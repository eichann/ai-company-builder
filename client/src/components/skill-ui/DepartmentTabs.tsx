import {
  Storefront,
  ChartPie,
  Users,
  Article,
  Code,
  Buildings,
  Globe,
  Folder,
  Briefcase,
  Heart,
  Lightning,
  Star,
  Shield,
  Gear,
  House,
  Cloud,
  IconProps
} from '@phosphor-icons/react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { DepartmentConfig } from '../../types'

// Special ID for the company-wide tab
export const COMPANY_TAB_ID = '__company__'

// Icon mapping - must match Admin UI's ICON_OPTIONS
const iconMap: Record<string, React.ComponentType<IconProps>> = {
  Storefront,
  ChartPie,
  Users,
  Article,
  Code,
  Buildings,
  Globe,
  Folder,
  Briefcase,
  Heart,
  Lightning,
  Star,
  Shield,
  Gear,
}

interface DepartmentTabsProps {
  departments: DepartmentConfig[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Folders not checked out via sparse checkout (shown as unsynced) */
  unsyncedFolders?: Set<string>
}

const COMPANY_COLOR = '#6366f1' // indigo

export const DepartmentTabs = memo(function DepartmentTabs({ departments, selectedId, onSelect, unsyncedFolders }: DepartmentTabsProps) {
  const { t } = useTranslation()
  const isCompanySelected = selectedId === COMPANY_TAB_ID

  return (
    <div className="flex items-center gap-2 px-6 py-4 overflow-x-auto scrollbar-hide">
      {/* Company-wide tab (fixed, always first) */}
      <button
        onClick={() => onSelect(COMPANY_TAB_ID)}
        className={`
          group relative flex items-center gap-2.5 px-4 py-2.5 rounded-xl
          font-medium text-sm whitespace-nowrap
          transition-all duration-200 ease-out
          ${isCompanySelected
            ? 'text-white shadow-lg'
            : 'text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-white/[0.04]'
          }
        `}
        style={{
          backgroundColor: isCompanySelected ? COMPANY_COLOR : undefined,
          boxShadow: isCompanySelected ? `0 4px 20px ${COMPANY_COLOR}40` : undefined,
        }}
      >
        <House
          size={18}
          weight={isCompanySelected ? 'fill' : 'regular'}
          className="transition-transform group-hover:scale-110"
        />
        <span>{t('departments.companyWide', '全社')}</span>
        {isCompanySelected && (
          <div
            className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full"
            style={{ backgroundColor: COMPANY_COLOR }}
          />
        )}
      </button>

      {/* Separator */}
      <div className="w-px h-6 bg-gray-200 dark:bg-zinc-700 flex-shrink-0" />

      {departments.map((dept) => {
        const Icon = iconMap[dept.icon] || Buildings
        const isSelected = selectedId === dept.id
        const isUnsynced = unsyncedFolders?.has(dept.folder) ?? false

        return (
          <button
            key={dept.id}
            onClick={() => onSelect(dept.id)}
            className={`
              group relative flex items-center gap-2.5 px-4 py-2.5 rounded-xl
              font-medium text-sm whitespace-nowrap
              transition-all duration-200 ease-out
              ${isUnsynced
                ? isSelected
                  ? 'text-white/80 shadow-lg'
                  : 'text-gray-400 dark:text-zinc-500 hover:text-gray-500 dark:hover:text-zinc-400 hover:bg-gray-50 dark:hover:bg-white/[0.02]'
                : isSelected
                  ? 'text-white shadow-lg'
                  : 'text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-white/[0.04]'
              }
            `}
            style={{
              backgroundColor: isSelected ? (isUnsynced ? `${dept.color}99` : dept.color) : undefined,
              boxShadow: isSelected ? `0 4px 20px ${dept.color}40` : undefined,
            }}
          >
            <Icon
              size={18}
              weight={isSelected ? 'fill' : 'regular'}
              className={`transition-transform group-hover:scale-110 ${isUnsynced && !isSelected ? 'opacity-50' : ''}`}
            />
            <span>{dept.name}</span>
            {isUnsynced && (
              <Cloud size={12} className={isSelected ? 'text-white/60' : 'text-gray-400 dark:text-zinc-600'} />
            )}

            {/* Active indicator line */}
            {isSelected && (
              <div
                className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full"
                style={{ backgroundColor: dept.color }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
})
