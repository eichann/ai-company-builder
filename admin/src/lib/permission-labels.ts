import type { EffectiveSummary, PermissionRule } from './api'

export const SUMMARY_LABELS: Record<EffectiveSummary, string> = {
  'everyone-rw': '全員が閲覧・編集できます',
  'everyone-r': '全員が閲覧できます（編集は一部の人だけ）',
  restricted: '一部の人だけがアクセスできます',
}

export function ruleAccessLabel(rule: Pick<PermissionRule, 'canRead' | 'canWrite'>): string {
  if (rule.canRead && rule.canWrite) return '閲覧・編集'
  if (rule.canRead) return '閲覧のみ'
  if (rule.canWrite) return '編集'
  return 'アクセス不可'
}
