/**
 * 「詳しい設定」 (管理画面の見直し 2-3, 3): five headings, each saying whether the company still
 * has the starting values (「初期値のまま」) or changed something (「変えています」). The starting
 * values are the shared rules' own (shared/core); this file only compares.
 */
import { DEFAULT_AGENT_SANDBOX_SETTINGS } from '../../../shared/core/agent-sandbox'
import { DEFAULT_INTAKE_SETTINGS, type IntakeSettings } from '../../../shared/core/intake-settings'
import { DEFAULT_TASK_SETTINGS, type TaskSettings } from '../../../shared/core/task-settings'
import type { AgentSandboxView } from '../../../shared/types/agent-sandbox'
import type { BrokerView } from '../../../shared/types/key-broker'

export type AdvancedSection = 'work' | 'calendar' | 'inbox' | 'ai-safety' | 'info'

export const ADVANCED_SECTIONS: Array<{ id: AdvancedSection; title: string; description: string; path: string }> = [
  { id: 'work', title: '仕事の進め方', description: '受信を読む・AI が自動で進める・チームの進め方・会議から AI が作るやること・呼び名・返事の目安', path: 'advanced/work' },
  { id: 'calendar', title: '会社の暦', description: '夏休み・年末年始など、会社の休み（土日・祝日は自動）', path: 'advanced/calendar' },
  { id: 'inbox', title: '来た連絡の決まり', description: '宛先が何人もいるとき・CC だけのとき・メルマガ・共有の受付アドレスなど', path: 'advanced/inbox' },
  { id: 'ai-safety', title: 'AI の安全', description: 'AI を止める・AI の操作の記録・AI の囲い・API キー', path: 'advanced/ai-safety' },
  { id: 'info', title: '会社の情報', description: '会社名・この会社から退出・組み込みのルールと止められた同期', path: 'advanced/info' },
]

const sorted = <T,>(xs: readonly T[]) => [...xs].map(String).sort()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 仕事の進め方: every task setting but the holidays (those are 会社の暦). */
export function workChanged(s: TaskSettings): boolean {
  const { companyHolidays: _a, ...mine } = s
  const { companyHolidays: _b, ...defaults } = DEFAULT_TASK_SETTINGS
  void _a
  void _b
  return !same(
    { ...mine, taskListDepartmentIds: mine.taskListDepartmentIds ? sorted(mine.taskListDepartmentIds) : null },
    { ...defaults, taskListDepartmentIds: defaults.taskListDepartmentIds }
  )
}

/** 会社の暦: the company added days off of its own. */
export function calendarChanged(s: TaskSettings): boolean {
  return s.companyHolidays.length > 0
}

export function inboxChanged(s: IntakeSettings): boolean {
  return !same(
    { ...s, internalDomains: sorted(s.internalDomains), sharedAddresses: s.sharedAddresses.length },
    { ...DEFAULT_INTAKE_SETTINGS, internalDomains: [], sharedAddresses: 0 }
  )
}

/**
 * AI の安全: the sandbox is not as it starts (company or a member), the AI action log's settings
 * were changed, or the company holds keys / turned members' own keys off.
 */
export function aiSafetyChanged(parts: {
  sandbox?: AgentSandboxView | null
  eventsUpdatedAt?: string | null
  broker?: BrokerView | null
}): boolean {
  const { sandbox, eventsUpdatedAt, broker } = parts
  if (sandbox) {
    const d = DEFAULT_AGENT_SANDBOX_SETTINGS
    const s = sandbox.settings
    if (s.mode !== d.mode || s.onUnavailable !== d.onUnavailable || s.deniedReadPaths.length > 0) return true
    if (!same(sorted(s.allowedDomains), sorted(d.allowedDomains))) return true
    if (sandbox.overrides.length > 0) return true
  }
  if (eventsUpdatedAt) return true
  if (broker && (broker.keys.some((k) => k.scope === 'company') || !broker.settings.memberKeysAllowed)) return true
  return false
}
