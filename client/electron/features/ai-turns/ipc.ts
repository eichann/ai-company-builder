// 「AI の番」 run automatically (stage 2 S10, .claude/rules/ai-turns.md):
//   aiTurns:settings  the company's 「自動で進める」 and its limits
//   aiTurns:claim     take a record's AI turn for a hidden consultation (one PC wins)
//   aiTurns:settle    after the turn: done / failed / put back to 「AI の番」
//   aiTurns:retry     「もう一度」: the server's run held for a person goes back to the AI (S10b)
// Only the main window runs AI turns: other windows are refused.

import type { IpcRegistrar } from '../../ipc/registrar'
import type { AiTurnClaims } from './claims'

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

export function registerAiTurnsIpc(ipc: IpcRegistrar, deps: { claims: AiTurnClaims; isMainWindow: (senderId: number) => boolean }): void {
  const { claims, isMainWindow } = deps
  ipc.handle('aiTurns:settings', (_event, companyId) => claims.settings(str(companyId) ? companyId : ''))
  ipc.handle('aiTurns:claim', (event, companyId, recordId, expectedVersion, conversationId) => {
    if (!isMainWindow(event.sender.id) || !str(companyId) || !str(recordId) || typeof expectedVersion !== 'number' || !str(conversationId)) {
      return { claimed: false, reason: 'not-allowed' } as const
    }
    return claims.claim(companyId, recordId, expectedVersion, conversationId)
  })
  ipc.handle('aiTurns:settle', (event, companyId, recordId) =>
    isMainWindow(event.sender.id) && str(companyId) && str(recordId) ? claims.settle(companyId, recordId) : { outcome: 'unknown' } as const)
  ipc.handle('aiTurns:retry', (event, companyId, recordId) =>
    isMainWindow(event.sender.id) && str(companyId) && str(recordId) ? claims.retry(companyId, recordId) : { ok: false })
}
