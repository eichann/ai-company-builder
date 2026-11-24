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

  it('the Docs card is its own: shown only when the company offers ドキュメント, with its own state', () => {
    const both: MyGoogleRelay = { ...base, services: [base.services[0], { service: 'docs', offered: false, allowed: false, turnedOff: false }] }
    assert.equal(googleRelayCardView(both, 'docs'), null)
    assert.equal(googleRelayCardView(both, 'sheets')!.state, 'allow')
    const docsOn: MyGoogleRelay = { ...base, stopped: 'member', services: [{ ...base.services[0], allowed: true }, { service: 'docs', offered: true, allowed: false, turnedOff: true }] }
    assert.equal(googleRelayCardView(docsOn, 'docs')!.state, 'resume')
    assert.equal(googleRelayCardView(docsOn, 'docs')!.notice, null)
    assert.equal(googleRelayCardView(docsOn, 'sheets')!.state, 'allowed')
    assert.match(googleRelayCardView({ ...docsOn, services: [docsOn.services[0], { ...docsOn.services[1], allowed: true, turnedOff: false }] }, 'docs')!.notice!, /ドキュメントに届きません/)
  })

  it('a Docs record names the Doc in Docs words', () => {
    assert.deepEqual(googleRelayRecordWords({ service: 'docs', operation: 'documents.batchUpdate', range: null, result: 'refused', reason: 'outside' }),
      { action: 'ドキュメントに書き足す、整える', result: '中継しませんでした', note: '会社の外の人が持っているドキュメントでした' })
    assert.equal(googleRelayRecordWords({ service: 'docs', operation: 'documents.get', range: null, result: 'google-refused', reason: null }).note, '編集する権限がないか、ドキュメントが見つかりません')
  })

  it('a record says why ACB refused (a deletion is named as such), and Google\'s refusal apart from ACB\'s', () => {
    assert.deepEqual(googleRelayRecordWords({ operation: 'spreadsheets.batchUpdate', range: null, result: 'refused', reason: 'deletion' }),
      { action: '行・列を足す、整える', result: '中継しませんでした', note: '消す操作は中継しません' })
    assert.equal(googleRelayRecordWords({ operation: null, range: null, result: 'refused', reason: 'deletion' }).action, '消す操作')
    assert.equal(googleRelayRecordWords({ operation: 'values.append', range: 'A:E', result: 'google-refused', reason: null }).result, 'Google が断りました')
    assert.equal(googleRelayRecordWords({ operation: 'values.append', range: 'A:E', result: 'ok', reason: null }).note, null)
  })
})
