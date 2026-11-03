// 「詳しい設定」 (管理画面の見直し 3): each heading says 「初期値のまま」 or 「変えています」 by comparing
// with the shared rules' starting values.
import { describe, expect, it } from 'vitest'

import { aiSafetyChanged, calendarChanged, inboxChanged, workChanged } from '@/lib/advanced'
import { DEFAULT_AGENT_SANDBOX_SETTINGS } from '../../shared/core/agent-sandbox'
import { defaultIntakeSettings } from '../../shared/core/intake-settings'
import { defaultTaskSettings } from '../../shared/core/task-settings'
import type { AgentSandboxView } from '../../shared/types/agent-sandbox'

const sandbox = (over: Partial<AgentSandboxView> = {}): AgentSandboxView => ({
  settings: { ...DEFAULT_AGENT_SANDBOX_SETTINGS, allowedDomains: [...DEFAULT_AGENT_SANDBOX_SETTINGS.allowedDomains].reverse() },
  defaultAllowedDomains: [...DEFAULT_AGENT_SANDBOX_SETTINGS.allowedDomains],
  overrides: [],
  updatedAt: '2026-11-01T00:00:00.000Z',
  updatedBy: 'u_owner',
  history: [],
  ...over,
})

describe('「初期値のまま」 or 「変えています」', () => {
  it('仕事の進め方 ignores the holidays (会社の暦 has them); one changed answer counts', () => {
    const s = defaultTaskSettings()
    const holidays = [{ date: '2026-12-29', name: '年末' }]
    expect(workChanged(s)).toBe(false)
    expect(workChanged({ ...s, companyHolidays: holidays })).toBe(false)
    expect(calendarChanged(s)).toBe(false)
    expect(calendarChanged({ ...s, companyHolidays: holidays })).toBe(true)
    expect(workChanged({ ...s, teamMode: true })).toBe(true)
    expect(workChanged({ ...s, readIncoming: { allowed: true, memberDefault: true } })).toBe(true)
  })

  it('仕事の進め方: records off is a change (a new company starts with them on); not known judges by the task settings', () => {
    const s = defaultTaskSettings()
    expect(workChanged(s, true)).toBe(false)
    expect(workChanged(s, false)).toBe(true)
    expect(workChanged(s, null)).toBe(false)
    expect(workChanged({ ...s, teamMode: true }, true)).toBe(true)
  })

  it('来た連絡の決まり', () => {
    expect(inboxChanged(defaultIntakeSettings())).toBe(false)
    expect(inboxChanged({ ...defaultIntakeSettings(), ccOnly: 'unsure' })).toBe(true)
    expect(inboxChanged({ ...defaultIntakeSettings(), internalDomains: ['group.example'] })).toBe(true)
  })

  it('AI の安全: the sandbox as it starts (host order aside) is unchanged; a mode, a member override or the log settings are changes', () => {
    expect(aiSafetyChanged({ sandbox: sandbox(), eventsUpdatedAt: null, broker: null })).toBe(false)
    expect(aiSafetyChanged({ sandbox: sandbox({ settings: { ...DEFAULT_AGENT_SANDBOX_SETTINGS, mode: 'observe' } }) })).toBe(true)
    expect(aiSafetyChanged({ sandbox: sandbox({ overrides: [{ userId: 'u_member' }] as unknown as AgentSandboxView['overrides'] }) })).toBe(true)
    expect(aiSafetyChanged({ eventsUpdatedAt: '2026-11-01T00:00:00.000Z' })).toBe(true)
    // 「もう一方の AI に聞く」 starts as 「聞かない」: allowing it is a change.
    expect(aiSafetyChanged({ sandbox: sandbox(), secondOpinion: { allowed: false, updatedAt: null, updatedByName: null } })).toBe(false)
    expect(aiSafetyChanged({ sandbox: sandbox(), secondOpinion: { allowed: true, updatedAt: null, updatedByName: null } })).toBe(true)
  })
})
