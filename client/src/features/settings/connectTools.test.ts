// 「仕事の道具をつなぐ」 opens by itself only for what the company offers and the member was
// never shown; once shown (connected, declined or 「あとで」) it stays closed until the company
// adds something — so it never pops up again and again, and never offers a company-off feature.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MyGoogle } from '../../../shared/google'
import type { MySlack } from '../../../shared/slack'
import { connectToolsOffer, connectToolsView, googleDeclined, googleDeclinedText } from './connectTools'

const google = (over: Partial<MyGoogle> = {}): MyGoogle => ({
  available: true, reason: null, connected: false, status: null, googleEmail: null, features: [], featuresOff: [],
  domain: 'div.example', practice: false, companyFeatures: ['minutes', 'mail', 'inbox'], seen: [], ...over,
})
const slack = (over: Partial<MySlack> = {}): MySlack => ({
  available: true, reason: null, connected: false, status: null, features: [], featuresOff: [], practice: false, seen: [], ...over,
})

test('a new member is offered every connection the company has, and only those', () => {
  const offer = connectToolsOffer(google(), slack())
  assert.deepEqual(offer, { only: null })
  const v = connectToolsView(google(), slack(), offer!.only)
  assert.equal(v.onlyNew, false)
  assert.deepEqual(v.google?.items.map(i => i.feature), ['minutes', 'mail', 'inbox'])
  assert.equal(v.google?.canConnect, true)
  assert.deepEqual(v.slack?.items.map(i => i.feature), ['read', 'notices'])
})

test('Slack appears only when the company registered it; Google only when it is set up', () => {
  assert.equal(connectToolsView(google(), slack({ available: false, reason: 'not-configured' })).slack, null)
  assert.equal(connectToolsView(google(), null).slack, null)
  const noGoogle = google({ available: false, reason: 'not-configured', companyFeatures: [] })
  assert.equal(connectToolsOffer(noGoogle, slack({ available: false })), null)
  assert.equal(connectToolsView(noGoogle, null).google, null)
})

test('once shown it does not open again — after connecting, after declining some, after 「あとで」', () => {
  const connected = google({ connected: true, features: ['minutes', 'mail', 'inbox'], seen: ['minutes', 'mail', 'inbox'] })
  assert.equal(connectToolsOffer(connected, slack({ connected: true, features: ['read', 'notices'], seen: ['read', 'notices'] })), null)
  // Unticked mail and inbox on Google's page: seen, so no loop.
  const declined = google({ connected: true, features: ['minutes'], seen: ['minutes', 'mail', 'inbox'] })
  assert.equal(connectToolsOffer(declined, slack({ seen: ['read', 'notices'] })), null)
  // 「あとで」 for both.
  assert.equal(connectToolsOffer(google({ seen: ['minutes', 'mail', 'inbox'] }), slack({ seen: ['read', 'notices'] })), null)
})

test('a feature the company adds later opens it once more, listing only what is new', () => {
  const g = google({ connected: true, features: ['minutes', 'mail'], seen: ['minutes', 'mail'] })
  const s = slack({ seen: ['read', 'notices'] })
  const offer = connectToolsOffer(g, s)
  assert.deepEqual(offer, { only: { google: ['inbox'], slack: false } })
  const v = connectToolsView(g, s, offer!.only)
  assert.equal(v.onlyNew, true)
  assert.deepEqual(v.google?.items.map(i => i.feature), ['inbox'])
  assert.equal(v.slack, null)
  // After connecting it, the latched list still shows it (now connected): the screen does not change under the member.
  const after = connectToolsView({ ...g, features: ['minutes', 'mail', 'inbox'], seen: ['minutes', 'mail', 'inbox'] }, s, offer!.only)
  assert.deepEqual(after.google?.items.map(i => [i.feature, i.state]), [['inbox', 'connected']])
  // Slack registered later: only Slack is new.
  assert.deepEqual(connectToolsOffer(google({ seen: ['minutes', 'mail', 'inbox'] }), slack()), { only: { google: [], slack: true } })
})

test('from 設定 it always lists everything the company offers, with what is connected', () => {
  const v = connectToolsView(google({ connected: true, googleEmail: 'sato@div.example', features: ['minutes'], seen: ['minutes', 'mail', 'inbox'] }), slack({ connected: true, features: ['read', 'reply', 'notices'] }))
  assert.equal(v.onlyNew, false)
  assert.deepEqual(v.google?.items.map(i => [i.feature, i.state]), [['minutes', 'connected'], ['mail', 'not-connected'], ['inbox', 'not-connected']])
  assert.equal(v.google?.canConnect, true)
  assert.equal(v.google?.account, 'sato@div.example')
  assert.equal(v.slack?.canConnect, false)
})

test('declined on Google\'s page: what does not work is said plainly; nothing declined says nothing', () => {
  const after = google({ connected: true, features: ['minutes'] })
  assert.deepEqual(googleDeclined(['minutes', 'mail', 'inbox'], after), ['mail', 'inbox'])
  const text = googleDeclinedText(['mail', 'inbox'])!
  assert.match(text, /許可されなかったため使えません/)
  assert.match(text, /メールを、あなたが確かめてから送れる/)
  assert.match(text, /やることを作れる/)
  assert.doesNotMatch(text, /スコープ|OAuth|トークン/)
  assert.equal(googleDeclinedText([]), null)
})

test('an older server without the new fields offers nothing by itself (no screen built on guesses)', () => {
  const old = { ...google(), companyFeatures: undefined, seen: undefined } as unknown as MyGoogle
  assert.equal(connectToolsOffer(old, null), null)
})
