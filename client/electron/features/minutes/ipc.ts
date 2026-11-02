// 「議事録が届きました」 (milestone 4 G9, .claude/rules/minutes.md "The app"):
//   minutes:watch     the company the member works in now (starts the 10-minute check)
//   minutes:check     「議事録を確かめる」
//   minutes:notices   the received minutes waiting for the member (no text, ever)
//   minutes:skip      「今は読まない」 (the type's skip, with the session)
//   minutes:linkBundle  「どのまとまりの会議ですか？」 (the session; nothing is written outside)
//   minutes:noBundle    「まとまりはない（社内の会議など）」: the question closed for good
//   minutes:bundleQuestion  the meeting card's question (may a まとまり be chosen)
// Everything goes with the member's session, which stays in main.

import type { IpcRegistrar } from '../../ipc/registrar'
import type { MinutesChecker } from './checker'

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const invalid = { success: false, error: '入力が正しくありません。' } as const

export function registerMinutesIpc(ipc: IpcRegistrar, minutes: MinutesChecker): void {
  ipc.handle('minutes:watch', async (_event, companyId) => {
    if (companyId !== null && !str(companyId)) return
    await minutes.watch(companyId)
  })
  ipc.handle('minutes:check', (_event, companyId) => str(companyId) ? minutes.checkNow(companyId) : invalid)
  ipc.handle('minutes:notices', (_event, companyId) => minutes.notices(str(companyId) ? companyId : ''))
  ipc.handle('minutes:skip', (_event, companyId, minutesId) => str(companyId) && str(minutesId) ? minutes.skip(companyId, minutesId) : invalid)
  ipc.handle('minutes:linkBundle', (_event, companyId, minutesId, bundleId) =>
    str(companyId) && str(minutesId) && str(bundleId) ? minutes.linkBundle(companyId, minutesId, bundleId) : invalid)
  ipc.handle('minutes:noBundle', (_event, companyId, minutesId) => str(companyId) && str(minutesId) ? minutes.noBundle(companyId, minutesId) : invalid)
  ipc.handle('minutes:bundleQuestion', (_event, companyId, minutesId) => str(companyId) && str(minutesId) ? minutes.bundleQuestion(companyId, minutesId) : invalid)
}
