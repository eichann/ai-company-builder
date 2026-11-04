// 設定 → Google 「スプレッドシートを中継で使う」 (google-connector.md "The relay"): what the card
// offers must match what the server would do — no ［許可する］ for a relay the company does not
// offer (the server refuses the consent), no second Google consent for a member who only turned it
// off (the permission is kept; the button turns it back on), and the admin's stop shown only to a
// member who allowed it. The records' words say why ACB refused.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { googleRelayCardView, googleRelayRecordWords, type MyGoogleRelay } from '../shared/google'

const base: MyGoogleRelay = {
  available: true, reason: null,
  services: [{ service: 'sheets', offered: true, allowed: false, turnedOff: false }],
  stopped: null, capPerDay: 500, usedToday: 37, records: [],
}
const withSheets = (s: Partial<MyGoogleRelay['services'][number]>, more: Partial<MyGoogleRelay> = {}): MyGoogleRelay =>
  ({ ...base, ...more, services: [{ ...base.services[0], ...s }] })

describe('the relay card', () => {
  it('is not shown when the company does not offer the relay or Google is unavailable', () => {
    assert.equal(googleRelayCardView(withSheets({ offered: false })), null)
    assert.equal(googleRelayCardView({ ...base, available: false, reason: 'off' }), null)
  })

  it('asks Google only when the member never allowed it; a member who turned it off gets it back without a consent', () => {
    assert.equal(googleRelayCardView(base)!.state, 'allow')
    assert.equal(googleRelayCardView(withSheets({ turnedOff: true }))!.state, 'resume')
    assert.equal(googleRelayCardView(withSheets({ allowed: true }))!.state, 'allowed')
  })

  it('says the admin stopped it only to a member who allowed it', () => {
    assert.match(googleRelayCardView(withSheets({ allowed: true }, { stopped: 'member' }))!.notice!, /あなたの Google の中継を止めて/)
    assert.match(googleRelayCardView(withSheets({ allowed: true }, { stopped: 'company' }))!.notice!, /全員/)
    assert.equal(googleRelayCardView(withSheets({}, { stopped: 'company' }))!.notice, null)
    assert.equal(googleRelayCardView(withSheets({ allowed: true }))!.usage, '今日 37回 ／ 上限 500回')
  })

  it('a record says why ACB refused (a deletion is named as such), and Google\'s refusal apart from ACB\'s', () => {
    assert.deepEqual(googleRelayRecordWords({ operation: 'spreadsheets.batchUpdate', range: null, result: 'refused', reason: 'deletion' }),
      { action: '行・列を足す、整える', result: '中継しませんでした', note: '消す操作は中継しません' })
    assert.equal(googleRelayRecordWords({ operation: null, range: null, result: 'refused', reason: 'deletion' }).action, '消す操作')
    assert.equal(googleRelayRecordWords({ operation: 'values.append', range: 'A:E', result: 'google-refused', reason: null }).result, 'Google が断りました')
    assert.equal(googleRelayRecordWords({ operation: 'values.append', range: 'A:E', result: 'ok', reason: null }).note, null)
  })
})
