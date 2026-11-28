// 「返事の下書きを、わたしの書き方に合わせる」 (features/writing-style/service.ts): the check and the member's own
// summaries on this PC.
//   writingStyle:status(companyId)                               what can be read, whether it is on, the summaries
//   writingStyle:setEnabled(companyId, on)                       the check (on makes the summaries in the background)
//   writingStyle:rebuild(companyId)                              「作り直す」
//   writingStyle:update(companyId, connectorId, audience, style) the member's own correction of one summary
//   writingStyle:remove(companyId, connectorId?, audience?)      「消す」 one, or all of them (and the check off)
// The session stays in main; the renderer gets the summaries (the member's own) and plain sentences only.
import { WRITING_STYLE_OFFLINE_TEXT, type WritingStyleResult, type WritingStyleStatus } from '../../../shared/writing-style'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { WritingStyles } from './service'

const OFFLINE: WritingStyleResult = { success: false, offline: true, error: WRITING_STYLE_OFFLINE_TEXT }
const BAD: WritingStyleResult = { success: false, offline: false, error: '入力が正しくありません。' }
const ID = /^[A-Za-z0-9_-]{1,100}$/

const answer = (r: WritingStyleStatus | null | 'bad'): WritingStyleResult => r === 'bad' ? BAD : r ? { success: true, data: r } : OFFLINE

export function registerWritingStyleIpc(ipc: IpcRegistrar, styles: WritingStyles): void {
  const company = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
  ipc.handle('writingStyle:status', async (_event, companyId) => (company(companyId) ? answer(await styles.status(companyId)) : BAD))
  ipc.handle('writingStyle:setEnabled', async (_event, companyId, on) =>
    (company(companyId) && typeof on === 'boolean' ? answer(await styles.setEnabled(companyId, on)) : BAD))
  ipc.handle('writingStyle:rebuild', async (_event, companyId) => (company(companyId) ? answer(await styles.rebuild(companyId)) : BAD))
  ipc.handle('writingStyle:update', async (_event, companyId, connectorId, audience, style) =>
    (company(companyId) ? answer(await styles.update(companyId, connectorId, audience, style)) : BAD))
  ipc.handle('writingStyle:remove', async (_event, companyId, connectorId, audience) =>
    (company(companyId) ? answer(await styles.remove(companyId, connectorId ?? undefined, audience ?? undefined)) : BAD))
}
