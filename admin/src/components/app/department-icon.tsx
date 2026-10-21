import {
  Article,
  Briefcase,
  Buildings,
  ChartPie,
  Code,
  Folder,
  Gear,
  Globe,
  Heart,
  Lightning,
  Shield,
  Star,
  Storefront,
  Users,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

// Icon names are stored in the DB and also read by the desktop app; keep the
// set and the names unchanged.
export const DEPARTMENT_ICONS: Record<string, Icon> = {
  Buildings,
  Storefront,
  ChartPie,
  Users,
  Article,
  Code,
  Folder,
  Briefcase,
  Globe,
  Heart,
  Lightning,
  Star,
  Shield,
  Gear,
}

export const DEPARTMENT_COLORS = [
  '#f59e0b',
  '#3b82f6',
  '#10b981',
  '#ec4899',
  '#8b5cf6',
  '#6366f1',
  '#ef4444',
  '#14b8a6',
  '#f97316',
  '#84cc16',
  '#06b6d4',
  '#a855f7',
]

export function DepartmentIcon({
  icon,
  color,
  size = 'md',
  className,
}: {
  icon: string
  color: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const IconComponent = DEPARTMENT_ICONS[icon] ?? Folder
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md text-white',
        size === 'sm' ? 'size-6' : 'size-8',
        className
      )}
      style={{ backgroundColor: color }}
    >
      <IconComponent size={size === 'sm' ? 14 : 17} weight="fill" />
    </span>
  )
}
