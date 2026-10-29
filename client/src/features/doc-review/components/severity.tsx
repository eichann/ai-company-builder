/* eslint-disable react-refresh/only-export-components -- the severity labels and the badge change together */
import { ChatCircleDots, Info, WarningCircle } from '@phosphor-icons/react'
import type { CommentSeverity } from '../model'

export const SEVERITY_CONFIG: Record<CommentSeverity, { label: string; color: string; bgColor: string; icon: typeof WarningCircle }> = {
  must_fix:   { label: '対応必須', color: 'text-red-400',  bgColor: 'bg-red-500/10',  icon: WarningCircle },
  should_fix: { label: 'できれば', color: 'text-amber-400', bgColor: 'bg-amber-500/10', icon: Info },
  note:       { label: '感想',     color: 'text-zinc-400',  bgColor: 'bg-zinc-500/10',  icon: ChatCircleDots },
}

export const SEVERITY_ORDER: CommentSeverity[] = ['must_fix', 'should_fix', 'note']

export function SeverityBadge({ severity, size = 'sm' }: { severity: CommentSeverity; size?: 'sm' | 'xs' }) {
  const config = SEVERITY_CONFIG[severity]
  const Icon = config.icon
  const textSize = size === 'sm' ? 'text-[11px]' : 'text-[10px]'
  const iconSize = size === 'sm' ? 12 : 10
  return (
    <span className={`inline-flex items-center gap-0.5 ${config.color} ${textSize}`}>
      <Icon size={iconSize} weight={severity === 'must_fix' ? 'fill' : 'regular'} />
      {config.label}
    </span>
  )
}
