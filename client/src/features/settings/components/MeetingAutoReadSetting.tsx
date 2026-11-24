// 設定 → 自分の設定 →「届いた議事録を AI が自動で読む」 (4b-4 design memo 1.1, minutes.md): the member's
// own choice of which arriving meetings their AI reads without a press. Hidden when the server does
// not answer it (an older server, records off). A member who never chose and starts at 「自動では読まない」
// is told what is recommended (D1-1); picking 「全部」 says once that past per-series 「読まない」 are gone (D1-4).
import { useState } from 'react'
import type { MeetingAutoReadMode } from '../../../../../shared/core/minutes'
import {
  MEETING_AUTO_READ_ALL_HINT, MEETING_AUTO_READ_CHOICES, MEETING_AUTO_READ_NOTE, MEETING_AUTO_READ_TITLE, showsAutoReadAllHint, suggestsAutoRead,
} from '../../../../shared/minutes-app'
import { Callout, Card } from '../../../shared/ui/primitives'
import { useMeetingAutoRead } from '../hooks/useMeetingAutoRead'

const hintKey = (companyId: string) => `meeting-auto-read-all-hint:${companyId}`
function hintSaid(companyId: string): boolean {
  try { return localStorage.getItem(hintKey(companyId)) === '1' } catch { return false }
}

export function MeetingAutoReadSetting({ companyId }: { companyId: string }) {
  const { loadRef, setting, error, busy, choose } = useMeetingAutoRead(companyId)
  const [hint, setHint] = useState(false)
  const pick = async (mode: MeetingAutoReadMode) => {
    if (!setting || mode === setting.mode) return
    const previous = setting.mode
    if (!(await choose(mode))) return
    const say = showsAutoReadAllHint(previous, mode, hintSaid(companyId))
    setHint(say)
    if (say) try { localStorage.setItem(hintKey(companyId), '1') } catch { /* memory only */ }
  }
  return (
    <div ref={loadRef}>
      {setting && (
        <Card className="p-5">
          <fieldset data-auto-read disabled={busy} className="space-y-2">
            <legend className="text-body font-medium">{MEETING_AUTO_READ_TITLE}</legend>
            <p className="text-small leading-relaxed text-text-muted">{MEETING_AUTO_READ_NOTE}</p>
            {suggestsAutoRead(setting) && (
              <p data-auto-read-suggestion className="text-small text-text-muted">今は自動では読みません。おすすめは「社外の人がいる会議だけ」です。</p>
            )}
            <div className="space-y-1.5 pt-1">
              {MEETING_AUTO_READ_CHOICES.map(c => (
                <label key={c.mode} className="flex items-center gap-2 text-body">
                  <input type="radio" name={`meeting-auto-read-${companyId}`} checked={setting.mode === c.mode} onChange={() => void pick(c.mode)} />
                  {c.label}{c.note && <span className="text-small text-text-muted">（{c.note}）</span>}
                </label>
              ))}
            </div>
          </fieldset>
          {hint && <Callout tone="info" role="status" className="mt-3">{MEETING_AUTO_READ_ALL_HINT}</Callout>}
          {error && <Callout tone="danger" role="alert" className="mt-3">{error}</Callout>}
        </Card>
      )}
    </div>
  )
}
