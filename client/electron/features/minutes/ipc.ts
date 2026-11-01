// 「議事録が届きました」 (milestone 4 G9, .claude/rules/minutes.md "The app"):
//   minutes:watch     the company the member works in now (starts the 10-minute check)
//   minutes:check     「議事録を確かめる」
//   minutes:notices   the received minutes waiting for the member (no text, ever)
//   minutes:skip      「今は読まない」 (the type's skip, with the session)
//   minutes:linkDeal  「どの案件の議事録ですか？」 (the session; nothing is written to HubSpot)
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
  ipc.handle('minutes:linkDeal', (_event, companyId, minutesId, dealId) =>
    str(companyId) && str(minutesId) && str(dealId) ? minutes.linkDeal(companyId, minutesId, dealId) : invalid)
}
