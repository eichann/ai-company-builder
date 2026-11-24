/**
 * The landing-route line `landing_create` on Lステップ's map 1.0.3 (generalization PR 8; agent-browser.md "Creating on the
 * new path"): copy a route with its name, the end of its reception and its action replaced by a copy whose tag is
 * replaced — two creates, the second pointing at what the first made. Data and words only: nothing writes with it.
 *
 * Guards (each test fails when its guard is removed):
 * - the line is written `pending` on 1.0.3, holds no business word, and the map's reads and writes never name `copy`;
 *   the two writes go only where stage 0 saw them (`POST /api/action/register`, `POST /api/landings`);
 * - the plan: the person confirms name / day / time (never the AI alone); the tag must not be one of the source action's;
 * - the judgement, end to end on answers made up from stage 0's key sets: a good copy is "as predicted"; the new route
 *   still on the source's action, the new action keeping the source's tag too, a stop or template dropped, a field the
 *   line does not set moving, the source route or the source action changing (an action edited in place reaches every
 *   route sharing it), a "new" object that is the source itself, the account moving or a created object not read →
 *   never "as predicted";
 * - a stop after write 1 leaves only the new action, which nothing the line read points at (the harmless prefix);
 * - the lock is the source route's; the tag's read address stays unconfirmed (nothing reads it).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readBrowserThing, type BrowserThingResult } from '../../shared/core/browser-map'
import { browserLineValuesProblem, type BrowserReadFacts, type BrowserSuppliedValue } from '../../shared/core/browser-read-line'
import {
  browserLineWriteLocks, browserWritesPlanProblem, judgeBrowserWrites, predictBrowserWrites, type BrowserCreatedRead,
} from '../../shared/core/browser-write-line'
import { browserObjectLockKey } from '../../shared/core/browser-plans'
import type { BrowserOpenedFile } from '../../shared/core/browser-opened'
import { lstepMap } from '../connector-maps/lstep'
import { LSTEP_MAP_WRITES } from '../connector-maps/lstep/map'
import { LINES } from '../browser-lines/lstep'
import { OPENED_FILE } from '../scripts/browser-opened'

const { map, reads, readers } = lstepMap()
const line = LINES.find(l => l.name === 'landing_create')!
const writes = line.writes!
const ACCOUNT = '90171'

const SOURCE = '400'
const SOURCE_ACTION = '7001'
const NEW_ACTION = '7009'
const NEW_ROUTE = '409'
const OLD_TAG = 21
const TAG = '22'

// --- made-up answers of stage 0's shapes (R4, R11, 追記2: key names and kinds only) ---

const NO_CONDITION = { member_query_id: null, send_member_query_id: null }
function landingAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '見本の流入経路 A', qr_text: null, action_id: Number(SOURCE_ACTION), action_texts: ['見本'], prevent_default: 0, only_welcome: false,
    cv_head: '', cv_body: null, group_id: 9, from_date: '', from_time: '', to_date: '2026-11-26', to_time: '17:00',
    out_of_period_message: '受付は終わりました', latitude: null, longitude: null, radius: null,
    custom_params: [{ name: 'a', var_id: 11 }], only_once_param_sync: true, ...over,
  }
}
function actionAnswer(tags: number[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aid: 0, a_name: null, a_twice_type: 1, funnel_descriptions: {}, group_id: null,
    inputs: [
      { type: 13, tag_ids: tags, ...NO_CONDITION },
      ...['101', '102'].map(e => ({ type: 15, episode_id: e, firetype: 1, ...NO_CONDITION })),
      { type: 12, egg_id: '300', ...NO_CONDITION },
    ],
    ...over,
  }
}
const tagAnswer = (over: Record<string, unknown> = {}) => ({ id: Number(TAG), name: '見本のタグ', ...over })

const read = (thing: string, answer: unknown, address?: string): BrowserThingResult => readBrowserThing(map, thing, answer, readers[thing], address)

const confirmed = (value: string): BrowserSuppliedValue => ({ value, from: { kind: 'person', confirmed: true } })
const site = (value: string): BrowserSuppliedValue => ({ value, from: { kind: 'site_fact' } })
const VALUES = { source: site(SOURCE), tag: site(TAG), name: confirmed('見本の流入経路 B'), to_date: confirmed('2026-12-03'), to_time: confirmed('17:00') }

function facts(o: { source?: Record<string, unknown>; action?: Record<string, unknown>; account?: string } = {}): BrowserReadFacts {
  const account = o.account ?? ACCOUNT
  return {
    reads: {
      source: read('landing', o.source ?? landingAnswer(), SOURCE),
      source_action_set: read('action_set', o.action ?? actionAnswer([OLD_TAG]), SOURCE_ACTION),
      tag: read('tag', tagAnswer()),
    },
    values: VALUES,
    account: { before: account, after: account },
  }
}
/** What main read of the two created objects, by the ids the site gave. */
function created(o: { route?: Record<string, unknown>; action?: Record<string, unknown>; routeId?: string; actionId?: string } = {}): Record<string, BrowserCreatedRead> {
  const routeId = o.routeId ?? NEW_ROUTE
  const actionId = o.actionId ?? NEW_ACTION
  return {
    new_action_set: { id: actionId, read: read('action_set', o.action ?? actionAnswer([Number(TAG)]), actionId) },
    new_landing: {
      id: routeId,
      read: read('landing', o.route ?? landingAnswer({ name: '見本の流入経路 B', to_date: '2026-12-03', action_id: Number(actionId) }), routeId),
    },
  }
}
const judge = (after = facts(), made = created(), before = facts()) => judgeBrowserWrites(line.read, writes, map, before, after, ACCOUNT, made)

test('the line is written pending on maps 1.0.3 and 1.0.4, holds no business word, and nothing in the map names a copy read', () => {
  const opened = JSON.parse(readFileSync(OPENED_FILE, 'utf8')) as BrowserOpenedFile
  const rows = opened.lines.filter(l => l.name === 'landing_create')
  assert.deepEqual(rows.map(r => [r.mapVersion, r.status]), [['1.0.3', 'pending'], ['1.0.4', 'pending']])
  const text = JSON.stringify({ map, line, LSTEP_MAP_WRITES, reads })
  for (const word of ['参加者', '18:20', '新方式', 'クロチャレ', 'crochalle']) assert.ok(!text.includes(word), word)
  // Never `GET /api/landings/<id>?copy=1` (it may create on the site's side): no read or write names `copy`.
  assert.doesNotMatch(JSON.stringify({ reads, LSTEP_MAP_WRITES }), /copy/)
})

test('the two writes go only where stage 0 saw them, and what is not confirmed is listed', () => {
  assert.equal(LSTEP_MAP_WRITES.action_set.create_from.method, 'POST')
  assert.equal(LSTEP_MAP_WRITES.action_set.create_from.path, '/api/action/register')
  assert.equal(LSTEP_MAP_WRITES.landing.create_from.method, 'POST')
  assert.equal(LSTEP_MAP_WRITES.landing.create_from.path, '/api/landings')
  assert.ok(LSTEP_MAP_WRITES.action_set.create_from.unconfirmed.length > 0)
  assert.ok(LSTEP_MAP_WRITES.landing.create_from.unconfirmed.length > 0)
  // The tag is a placeholder (stage 0 R6): no address, so nothing reads it until it is confirmed.
  assert.equal(reads.tag.path, null)
  assert.deepEqual(writes.map(w => [w.verb, w.read]), [['create_from', 'source_action_set'], ['create_from', 'source']])
})

test('name, day and time come only from the person, one by one; the source and the tag only from what the site showed', () => {
  assert.equal(browserLineValuesProblem(line.read, VALUES), null)
  assert.deepEqual(browserLineValuesProblem(line.read, { ...VALUES, name: { value: 'x', from: { kind: 'ai' } } }), { problem: 'source', value: 'name' })
  assert.deepEqual(browserLineValuesProblem(line.read, { ...VALUES, to_date: { value: '2026-12-03', from: { kind: 'person', confirmed: false } } }), { problem: 'unconfirmed', value: 'to_date' })
  assert.deepEqual(browserLineValuesProblem(line.read, { ...VALUES, to_time: confirmed('18:61') }), { problem: 'shape', value: 'to_time' })
  assert.deepEqual(browserLineValuesProblem(line.read, { ...VALUES, tag: confirmed(TAG) }), { problem: 'source', value: 'tag' })
  assert.deepEqual(browserLineValuesProblem(line.read, { ...VALUES, to_date: { value: '2026-12-03', from: { kind: 'record_field', aiWroteLast: false } } }), { problem: 'source', value: 'to_date' })
})

test('the plan: the new tag is none of the source action\'s tags (the previous round\'s tag kept is never planned)', () => {
  assert.equal(browserWritesPlanProblem(line.read, writes, map, facts(), ACCOUNT), null)
  assert.equal(browserWritesPlanProblem(line.read, writes, map, facts({ action: actionAnswer([Number(TAG)]) }), ACCOUNT), 'same-as-original')
  // Also when the source carries it beside another tag (independent review L4).
  assert.equal(browserWritesPlanProblem(line.read, writes, map, facts({ action: actionAnswer([OLD_TAG, Number(TAG)]) }), ACCOUNT), 'same-as-original')
  // The same end time as the source is fine (a plain value).
  assert.equal(browserWritesPlanProblem(line.read, writes, map, facts({ source: landingAnswer({ to_time: '17:00' }) }), ACCOUNT), null)
  assert.equal(browserWritesPlanProblem(line.read, writes, map, facts({ account: '1' }), ACCOUNT), 'reads')
})

test('a good copy is "as predicted": the new route is the source with the three set fields and the new action', () => {
  assert.deepEqual(judge(), { status: 'as_predicted' })
})

test('anything else after the writes is never "as predicted"', () => {
  const differs = (got: ReturnType<typeof judge>) => (got.status === 'not_as_predicted' ? got.differs : got.status)
  // The new route still on the source's action (the most common accident).
  assert.deepEqual(differs(judge(facts(), created({ route: landingAnswer({ name: '見本の流入経路 B', to_date: '2026-12-03' }) }))), { new_landing: ['action_id'] })
  // The new action keeps the old tag too, or lost a stop or the template.
  assert.deepEqual(differs(judge(facts(), created({ action: actionAnswer([OLD_TAG, Number(TAG)]) }))), { new_action_set: ['tags'] })
  const noStop = actionAnswer([Number(TAG)]); (noStop.inputs as unknown[]).splice(1, 1)
  assert.deepEqual(differs(judge(facts(), created({ action: noStop }))), { new_action_set: ['stops'] })
  // A field the line does not set moved on the copy (here: only for new friends; stage 0 saw the save not send it).
  assert.deepEqual(differs(judge(facts(), created({ route: landingAnswer({ name: '見本の流入経路 B', to_date: '2026-12-03', action_id: Number(NEW_ACTION), only_welcome: true }) }))), { new_landing: ['only_welcome'] })
  // The source route changed, or the source action was edited in place (every route sharing it would change).
  assert.deepEqual(differs(judge(facts({ source: landingAnswer({ name: '変わった' }) }))), { source: ['name'] })
  assert.deepEqual(differs(judge(facts({ action: actionAnswer([Number(TAG)]) }))), { source_action_set: ['tags'] })
  // The "new" action is the source's own: nothing new was made.
  assert.deepEqual(differs(judge(facts(), created({ actionId: SOURCE_ACTION, route: landingAnswer({ name: '見本の流入経路 B', to_date: '2026-12-03' }) }))), { new_action_set: ['id'] })
  assert.deepEqual(differs(judge(facts(), created({ routeId: SOURCE }))), { new_landing: ['id'] })
  // The account moved, a created object not read whole, another object read, none given.
  assert.equal(judge(facts({ account: '1' })).status, 'unreadable')
  assert.equal(judge(facts(), { ...created(), new_landing: { id: NEW_ROUTE, read: read('landing', landingAnswer({ extra: 1 }), NEW_ROUTE) } }).status, 'unreadable')
  assert.equal(judge(facts(), { ...created(), new_landing: { id: '410', read: created().new_landing.read } }).status, 'unreadable')
  assert.equal(judge(facts(), { new_action_set: created().new_action_set }).status, 'unreadable')
})

test('a stop after write 1 leaves only the new action, which nothing the line read points at (the harmless prefix, §4-1)', () => {
  const state = (r: BrowserThingResult) => (r.status === 'read' ? r.state : {})
  const before = facts()
  const beforeStates = Object.fromEntries(Object.entries(before.reads).map(([k, r]) => [k, state(r)]))
  const plain = Object.fromEntries(Object.entries(VALUES).map(([k, v]) => [k, v.value]))
  const afterOne = predictBrowserWrites(line.read, writes.slice(0, 1), map, beforeStates, plain, { new_action_set: NEW_ACTION })!
  for (const name of Object.keys(beforeStates)) assert.deepEqual(afterOne[name], beforeStates[name], name)
  assert.ok(!JSON.stringify(beforeStates).includes(NEW_ACTION))
  // Only the last write may change what existed, and here none does: both are creates.
  assert.ok(writes.every(w => w.verb === 'create_from'))
})

test('the lock is the source route\'s (both creates are reached from it); the created objects\' keys are taken when recorded', () => {
  const where = { company: 'c1', host: 'manager.linestep.net', account: ACCOUNT }
  const plain = Object.fromEntries(Object.entries(VALUES).map(([k, v]) => [k, v.value]))
  assert.deepEqual(browserLineWriteLocks(line.read, writes, map, plain, where), [
    browserObjectLockKey({ ...where, site: 'lstep', thing: 'landing', id: { field: 'id', value: SOURCE } }),
  ])
})
