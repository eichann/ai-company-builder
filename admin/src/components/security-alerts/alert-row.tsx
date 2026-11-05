import { WarningCircle } from '@phosphor-icons/react'

import type { SecurityAlertView } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

/** One 「気になる動き」: what happened, the numbers behind it, and what to do (words from the server). */
export function SecurityAlertRow({ alert }: { alert: SecurityAlertView }) {
  return (
    <li className="flex gap-3 px-5 py-3">
      <WarningCircle size={18} weight="bold" className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium">{alert.title}</div>
        <p className="text-sm text-muted-foreground">{alert.detail}</p>
        <p className="text-sm">
          <span className="font-medium">すること：</span>
          {alert.action}
        </p>
        <p className="text-xs text-muted-foreground">{formatDateTime(alert.createdAt)}</p>
      </div>
    </li>
  )
}
