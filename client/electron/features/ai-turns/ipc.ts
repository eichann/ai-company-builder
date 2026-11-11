// 「AI の番」 run automatically (stage 2 S10, .claude/rules/ai-turns.md):
//   aiTurns:settings  the company's 「自動で進める」 and its limits
//   aiTurns:stopConfirmed  the stop policy is confirmed by the server (else nothing starts by itself)
//   aiTurns:claim     take a record's AI turn for a hidden consultation (one PC wins)
//   aiTurns:settle    after the turn: done / failed / put back to 「AI の番」
//   aiTurns:retry     「もう一度」: the server's run held for a person goes back to the AI (S10b)
//   aiTurns:pluginTurns  the member's records at a business plugin's ai_turn step (C5, plugin-steps.md)
//   aiTurns:jobTurns  the member's scheduled jobs' occurrences this app can run (jobs.md, B PR 5a-2)
// Only the main window runs AI turns: other windows are refused.

import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'
import type { AiTurnClaims } from './claims'

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

export function registerAiTurnsIpc(ipc: IpcRegistrar, deps: { claims: AiTurnClaims; isMainWindow: (senderId: number) => boolean; paths: PathGuard }): void {
  const { claims, isMainWindow, paths } = deps
  ipc.handle('aiTurns:settings', (_event, companyId) => claims.settings(str(companyId) ? companyId : ''))
  ipc.handle('aiTurns:stopConfirmed', (event, companyId) =>
    isMainWindow(event.sender.id) && str(companyId) ? claims.stopPolicyConfirmed(companyId) : false)
  ipc.handle('aiTurns:claim', (event, companyId, recordId, expectedVersion, conversationId, companyRoot) => {
    // The company folder: where a company Skill pinned as a plugin step's procedure is read (plugin-steps.md).
    let root: string | null = null
    if (companyRoot !== undefined && companyRoot !== null) {
      try { root = paths.validate(String(companyRoot)) } catch { return { claimed: false, reason: 'not-allowed' } as const }
    }
    if (!isMainWindow(event.sender.id) || !str(companyId) || !str(recordId) || typeof expectedVersion !== 'number' || !str(conversationId)) {
      return { claimed: false, reason: 'not-allowed' } as const
    }
    return claims.claim(companyId, recordId, expectedVersion, conversationId, root)
  })
  ipc.handle('aiTurns:settle', (event, companyId, recordId) =>
    isMainWindow(event.sender.id) && str(companyId) && str(recordId) ? claims.settle(companyId, recordId) : { outcome: 'unknown' } as const)
  ipc.handle('aiTurns:retry', (event, companyId, recordId) =>
    isMainWindow(event.sender.id) && str(companyId) && str(recordId) ? claims.retry(companyId, recordId) : { ok: false })
  ipc.handle('aiTurns:pluginTurns', (event, companyId) =>
    isMainWindow(event.sender.id) && str(companyId) ? claims.pluginTurns(companyId) : [])
  ipc.handle('aiTurns:jobTurns', (event, companyId) =>
    isMainWindow(event.sender.id) && str(companyId) ? claims.jobTurns(companyId) : [])
}
