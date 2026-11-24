/**
 * Lステップ's map (1.0.1, now 1.0.3: its new things are browser-step-template-line.test.ts's) and the inspection line (generalization PR 3; agent-browser.md "The first map and the inspection
 * line"): `client/connector-maps/lstep/`, `client/browser-lines/lstep.ts`, `shared/browser-connectors/opened.json`.
 *
 * Guards (each test fails when its guard is removed):
 * - the map holds exactly the keys stage 0 recorded and 追記2 confirmed in full (key names and kinds only; the answers
 *   below are made up from those lists, no real value): each of the four confirmed shapes reads whole — the test route's
 *   null folder and empty end of reception included —; a key more or less, an unknown kind of input, another kind's key,
 *   a condition on who receives it, a value of a shape not seen → not read whole;
 * - no read of the map carries a query but the folder list's `group` / `page` (never `?copy=1`);
 * - the inspection, end to end on made-up answers: a good copy is ✓; the copy still pointing at its source's action, the
 *   tags left as the source's, a template changed, the account moving → ✗ or 「読み取れませんでした」, never ✓;
 * - opened.json is exactly what the script writes; a new line is `pending`; a changed map under the same version is
 *   refused; the old path (`client/connectors/lstep/`, `lstep@0.6.3`) is untouched;
 * - no business word (a round's tag, its time, its source) in the map or the lines.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readBrowserThing, type BrowserThingResult } from '../../shared/core/browser-map'
import { evaluateBrowserReadLine, type BrowserReadFacts } from '../../shared/core/browser-read-line'
import { buildBrowserReadCard } from '../../shared/core/browser-card'
import type { BrowserOpenedFile } from '../../shared/core/browser-opened'
import { lstepMap } from '../connector-maps/lstep'
import { LINES } from '../browser-lines/lstep'
import { OPENED_FILE, currentLines, currentMaps, mergeOpened, openedFileText } from '../scripts/browser-opened'
import { CARRIED_FILE, CONNECTORS_DIR, APPROVED_FILE, folderHash } from '../scripts/browser-connectors'

const { map, reads, readers } = lstepMap()
const line = LINES[0]

// --- the keys stage 0 recorded and 追記2 confirmed whole (「ブラウザ操作の汎用化_段0の結果」 R4, R10, R11, 追記2; names only) ---

const LANDING_KEYS = ['name', 'qr_text', 'action_id', 'action_texts', 'prevent_default', 'only_welcome', 'cv_head', 'cv_body',
  'group_id', 'from_date', 'from_time', 'to_date', 'to_time', 'out_of_period_message', 'latitude', 'longitude', 'radius',
  'custom_params', 'only_once_param_sync']
const ROW_KEYS = ['id', 'created_at', 'updated_at', 'name', 'counter', 'counter_member', 'order', 'only_welcome', 'prevent_default',
  'validity_period_from', 'validity_period_to', 'follow_url', 'qr_url', 'action_texts', 'action_twice_type', 'custom_params_script_tag', 'group']
const ACTION_KEYS = ['inputs', 'aid', 'a_twice_type', 'a_name', 'funnel_descriptions', 'group_id']
const INPUT_KEYS = ['type', 'tag_ids', 'egg_id', 'episode_id', 'firetype', 'member_query_id', 'send_member_query_id']

const topKeys = (thing: string) => Object.keys(map.things[thing].keys).filter(k => !k.includes('.')).sort()

test('the map lists exactly the keys stage 0 recorded', () => {
  assert.deepEqual(topKeys('landing'), [...LANDING_KEYS].sort())
  assert.deepEqual(topKeys('landing_row'), [...ROW_KEYS].sort())
  assert.deepEqual(topKeys('action_set'), [...ACTION_KEYS].sort())
  assert.deepEqual(Object.keys(map.things.action_set.keys).filter(k => k.startsWith('inputs[].')).map(k => k.slice(9)).sort(), [...INPUT_KEYS].sort())
  assert.deepEqual(Object.keys(map.things.landing.keys).filter(k => k.startsWith('custom_params[].')).sort(), ['custom_params[].name', 'custom_params[].var_id'])
  assert.deepEqual(Object.keys(map.things.landing_row.keys).filter(k => k.startsWith('group.')).sort(), ['group.id', 'group.name', 'group.order'])
  assert.equal(map.version, '1.0.4')
})

// --- made-up answers of those shapes ---

function landingAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '見本の流入経路 B', qr_text: null, action_id: 7002, action_texts: ['見本'], prevent_default: 0, only_welcome: false,
    cv_head: '', cv_body: null, group_id: 9, from_date: null, from_time: null, to_date: '2026-12-03', to_time: '17:00',
    out_of_period_message: '受付は終わりました', latitude: null, longitude: null, radius: null,
    custom_params: [{ name: 'a', var_id: 11 }], only_once_param_sync: true, ...over,
  }
}
const sourceAnswer = (over: Record<string, unknown> = {}) => landingAnswer({ name: '見本の流入経路 A', action_id: 7001, to_date: '2026-11-26', ...over })
const rowAnswer = (over: Record<string, unknown> = {}) => ({
  id: 501, created_at: '2026-11-20 10:00:00', updated_at: '2026-11-21 10:00:00', name: '見本の流入経路 B', counter: 3,
  counter_member: 2, order: 1, only_welcome: 0, prevent_default: 0, validity_period_from: null, validity_period_to: '2026-12-03 17:00',
  follow_url: 'https://example.test/follow/x', qr_url: 'https://example.test/qr/x', action_texts: ['見本'], action_twice_type: 1,
  custom_params_script_tag: '', group: { id: 9, name: '見本のフォルダ', order: 1 }, ...over,
})
const NO_CONDITION = { member_query_id: null, send_member_query_id: null }
function actionAnswer(tags: number[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aid: 7002, a_name: '見本のアクション', a_twice_type: 1, funnel_descriptions: {}, group_id: null,
    inputs: [
      { type: 13, tag_ids: tags, ...NO_CONDITION },
      ...['101', '102'].map(e => ({ type: 15, episode_id: e, firetype: 1, ...NO_CONDITION })),
      { type: 12, egg_id: '300', ...NO_CONDITION },
    ],
    ...over,
  }
}

const read = (thing: string, answer: unknown, address?: string): BrowserThingResult => readBrowserThing(map, thing, answer, readers[thing], address)

test('each thing reads whole from an answer of the recorded shape', () => {
  const l = read('landing', landingAnswer(), '501')
  assert.equal(l.status, 'read')
  if (l.status === 'read') {
    assert.equal(l.state.id, '501')
    assert.equal(l.state.cv_head, null)
    assert.equal(l.state.prevent_default, false)
    assert.deepEqual(l.state.params, ['11'])
  }
  assert.equal(read('landing_row', rowAnswer()).status, 'read')
  const a = read('action_set', actionAnswer([21]), '7002')
  assert.equal(a.status, 'read')
  if (a.status === 'read') assert.deepEqual(a.state, { id: '7002', name: '見本のアクション', twice: '1', tags: ['21'], templates: ['300'], stops: ['101_1', '102_1'] })
})

test('a key more, a key less, or a value of an unseen shape → not read whole', () => {
  const notRead = (r: BrowserThingResult) => assert.equal(r.status, 'not_read')
  notRead(read('landing', landingAnswer({ copy_of: 1 }), '501'))
  const missing = landingAnswer(); delete missing.to_time
  notRead(read('landing', missing, '501'))
  notRead(read('landing', landingAnswer(), undefined))
  notRead(read('landing', landingAnswer({ to_date: '2026/12/03' }), '501'))
  notRead(read('landing', landingAnswer({ to_time: '17:00:30' }), '501'))
  notRead(read('landing', landingAnswer({ prevent_default: 'yes' }), '501'))
  notRead(read('landing', landingAnswer({ action_id: 0 }), '501'))
  notRead(read('landing', landingAnswer({ custom_params: [{ name: 'a', var_id: 11, secret: 1 }] }), '501'))
  notRead(read('landing_row', rowAnswer({ copied_from: 'x' })))
  notRead(read('landing_row', rowAnswer({ follow_url: '' })))
  notRead(read('action_set', actionAnswer([21], { extra: 1 }), '7002'))
  notRead(read('action_set', actionAnswer([21], { inputs: [{ type: 14, tag_ids: [1], ...NO_CONDITION }] }), '7002'))
  notRead(read('action_set', actionAnswer([21], { inputs: [{ type: 13, tag_ids: [1], egg_id: '3', ...NO_CONDITION }] }), '7002'))
  notRead(read('action_set', actionAnswer([21], { inputs: [{ type: 13, tag_ids: [], ...NO_CONDITION }] }), '7002'))
  notRead(read('action_set', actionAnswer([21], { inputs: [{ type: 13, tag_ids: [1], member_query_id: 2, send_member_query_id: null }] }), '7002'))
  notRead(read('action_set', actionAnswer([21], { inputs: [{ type: 12, egg_id: '3', member_query_id: null, send_member_query_id: 5 }] }), '7002'))
  notRead(read('action_set', actionAnswer([21], { inputs: [{ type: 13, tag_ids: [1] }] }), '7002'))
  notRead(read('action_set', actionAnswer([21], { funnel_descriptions: { unknown: 1 } }), '7002'))
  notRead(read('landing_row', rowAnswer({ group: { id: 9, name: 'x', order: 1, extra: 1 } })))
  // 1.0.1: exactly each kind's keys — another kind's key, even null, is not read.
  notRead(read('action_set', actionAnswer([21], { inputs: [{ type: 13, tag_ids: [1], egg_id: null, ...NO_CONDITION }] }), '7002'))
})

// --- 追記2's four confirmed shapes (key names and kinds as recorded; every value made up) ---

test('the confirmed shapes read whole: a round\'s route, the test route (no folder, no end), the row and each kind of input', () => {
  // A round's route: a folder, an end of reception, empty starts, null place, no variables.
  const round = landingAnswer({ group_id: 12, from_date: '', from_time: '', to_date: '2026-11-26', to_time: '18:20',
    latitude: null, longitude: null, radius: null, custom_params: [], cv_head: '', cv_body: '', qr_text: '見本', out_of_period_message: '' })
  const r = read('landing', round, '601')
  assert.equal(r.status, 'read')
  if (r.status === 'read') assert.deepEqual([r.state.from_date, r.state.to_date, r.state.to_time, r.state.group_id], [null, '2026-11-26', '18:20', '12'])
  // The test route: no folder (null) and no end (empty strings) — read whole, the card shows 「なし」.
  const testRoute = read('landing', landingAnswer({ group_id: null, from_date: '', from_time: '', to_date: '', to_time: '', custom_params: [] }), '602')
  assert.equal(testRoute.status, 'read')
  if (testRoute.status === 'read') assert.deepEqual([testRoute.state.group_id, testRoute.state.to_date, testRoute.state.to_time], [null, null, null])
  assert.equal(Object.keys(round).length, 19)
  // The row with its folder object; also one whose folder is null (未分類, not seen but harmless: never compared).
  assert.equal(read('landing_row', rowAnswer()).status, 'read')
  assert.equal(Object.keys(rowAnswer()).length, 17)
  assert.equal(read('landing_row', rowAnswer({ group: null })).status, 'read')
  // An action: 6 keys, aid a number, funnel_descriptions an empty object, a_name / group_id null; ids as strings / numbers.
  const action = actionAnswer([21, 22], { a_name: null })
  assert.equal(Object.keys(action).length, 6)
  const a = read('action_set', action, '7002')
  assert.equal(a.status, 'read')
  if (a.status === 'read') assert.deepEqual(a.state, { id: '7002', name: null, twice: '1', tags: ['21', '22'], templates: ['300'], stops: ['101_1', '102_1'] })
})

test('no read carries a query but the folder list\'s own (never ?copy=1)', () => {
  const all = JSON.stringify(reads)
  assert.doesNotMatch(all, /copy/)
  for (const [thing, r] of Object.entries(reads)) {
    // The one page read (1.0.2): the reminder's page, where the step's templates are (the old checker's read).
    if ('html' in r) { assert.equal(r.path, '/line/episode/show/{parent}', thing); continue }
    // PR 8: the tag's address is not confirmed (stage 0 R6): none, so nothing reads it.
    if (r.path === null) { assert.equal(thing, 'tag'); continue }
    assert.match(r.path, /^\/api\/[a-z-]+(\/\{id\})?$/, thing)
    assert.ok(!r.path.includes('?'))
    if ('query' in r) assert.deepEqual([...r.query], ['group', 'page'])
  }
})

// --- the inspection, end to end ---

const site = (value: string) => ({ value, from: { kind: 'site_fact' as const } })

function facts(over: { landing?: unknown; row?: unknown; action?: unknown; source?: unknown; sourceAction?: unknown; account?: BrowserReadFacts['account'] } = {}): BrowserReadFacts {
  const landing = (over.landing ?? landingAnswer()) as Record<string, unknown>
  const source = (over.source ?? sourceAnswer()) as Record<string, unknown>
  return {
    reads: {
      landing: read('landing', landing, '501'),
      landing_row: read('landing_row', over.row ?? rowAnswer()),
      action_set: read('action_set', over.action ?? actionAnswer([22]), String(landing.action_id)),
      source: read('landing', source, '400'),
      source_action_set: read('action_set', over.sourceAction ?? actionAnswer([21]), String(source.action_id)),
    },
    values: { landing: site('501'), source: site('400') },
    account: over.account ?? { before: '90171', after: '90171' },
  }
}
const inspect = (f: BrowserReadFacts) => {
  const outcome = evaluateBrowserReadLine(line.read, map, f)
  return { outcome, card: buildBrowserReadCard(line, map, f, outcome) }
}
const marks = (f: BrowserReadFacts) => inspect(f).card.checks.map(c => c.mark)

test('the line opens against the map (no business word in either)', () => {
  const text = JSON.stringify({ map, LINES })
  for (const word of ['参加者', '18:20', '新方式', 'クロチャレ', 'crochalle']) assert.ok(!text.includes(word), word)
})

test('a good copy: every check ✓, the URL and the action\'s note on the card', () => {
  const { outcome, card } = inspect(facts())
  assert.equal(outcome.problem, null)
  assert.equal(card.state, 'all_ok')
  assert.deepEqual(card.checks.map(c => c.mark), ['ok', 'ok', 'ok', 'ok', 'ok'])
  assert.deepEqual(card.sections[1].rows.map(r => 'value' in r && r.value), [
    { status: 'read', text: 'https://example.test/follow/x' }, { status: 'read', text: 'https://example.test/qr/x' }])
  assert.ok(card.notes.some(n => n.includes('共有')))
  assert.deepEqual(card.account, { label: 'LINE アカウント', value: { status: 'read', text: '90171' } })
})

test('the copy still pointing at its source\'s action (stage 0\'s accident) → ✗', () => {
  const f = facts({ landing: landingAnswer({ action_id: 7001 }), action: actionAnswer([21]) })
  const { card } = inspect(f)
  assert.equal(card.state, 'ng')
  // account ✓, the route as its source ✓, its action changed ✗, its tags changed ✗, the action as its source's ✓
  assert.deepEqual(card.checks.map(c => c.mark), ['ok', 'ok', 'ng', 'ng', 'ok'])
  assert.deepEqual(card.checks[2].fields, ['アクション'])
  assert.deepEqual(card.checks[3].fields, ['つけるタグ'])
})

test('a new action with the source\'s tags → ✗ on the tags only', () => {
  assert.deepEqual(marks(facts({ action: actionAnswer([21]) })), ['ok', 'ok', 'ok', 'ng', 'ok'])
})

test('a template or a cancel changed, or the route\'s folder → ✗ naming it', () => {
  const changed = actionAnswer([22], { inputs: [{ type: 13, tag_ids: [22], ...NO_CONDITION }, { type: 15, episode_id: '101', firetype: 1, ...NO_CONDITION }, { type: 12, egg_id: '301', ...NO_CONDITION }] })
  const { card } = inspect(facts({ action: changed }))
  assert.equal(card.checks[4].mark, 'ng')
  assert.deepEqual(card.checks[4].fields, ['送るテンプレート', '止めるリマインダ（番号_止め方）'])
  const moved = inspect(facts({ landing: landingAnswer({ group_id: 10 }) })).card
  assert.deepEqual(moved.checks[1].fields, ['フォルダ'])
})

test('the account moving during the reads, or not read → nothing ✓', () => {
  for (const account of [{ before: '90171', after: '90172' }, { before: null, after: '90171' }]) {
    const { card } = inspect(facts({ account }))
    assert.ok(card.checks.every(c => c.mark !== 'ok'), JSON.stringify(account))
    assert.notEqual(card.state, 'all_ok')
  }
})

test('a row of a shape not recorded: the URL 「読み取れませんでした」, the rest still judged, never all ✓', () => {
  const { card } = inspect(facts({ row: rowAnswer({ copied_from: 'x' }) }))
  assert.deepEqual(card.sections[1].rows.map(r => 'value' in r && r.value), [{ status: 'unreadable' }, { status: 'unreadable' }])
  assert.notEqual(card.state, 'all_ok')
  assert.deepEqual(card.checks.map(c => c.mark), ['ok', 'ok', 'ok', 'ok', 'ok'])
})

test('a source action not read whole: its checks 「読み取れませんでした」, not ✓', () => {
  const { card } = inspect(facts({ sourceAction: actionAnswer([21], { surprise: 1 }) }))
  assert.deepEqual(card.checks.slice(3).map(c => c.mark), ['unreadable', 'unreadable'])
  assert.equal(card.state, 'not_read')
})

// --- opened.json and the old path ---

test('opened.json is what the script writes for the map and line files now', async () => {
  const existing = readFileSync(OPENED_FILE, 'utf8')
  assert.equal(await openedFileText(existing), existing, 'run `cd client && npx tsx scripts/browser-opened.ts` and review the new rows')
})

test('a new line is written pending; a reviewed status is kept; a changed map under the same version is refused', async () => {
  const maps = await currentMaps()
  const lines = await currentLines(maps)
  const fresh = JSON.parse(mergeOpened(null, maps, lines)) as BrowserOpenedFile
  assert.ok(fresh.lines.length >= 2 && fresh.lines.every(l => l.status === 'pending'))
  assert.equal(fresh.provisional, true)
  const approved = { ...fresh, lines: fresh.lines.map(l => ({ ...l, status: 'approved' as const })) }
  const again = JSON.parse(mergeOpened(JSON.stringify(approved), maps, lines)) as BrowserOpenedFile
  assert.ok(again.lines.every(l => l.status === 'approved'))
  assert.throws(() => mergeOpened(JSON.stringify(fresh), [{ ...maps[0], readersHash: `sha256:${'0'.repeat(64)}` }], lines), /raise the map's version/)
  assert.throws(() => mergeOpened(JSON.stringify(fresh), maps, [{ ...lines[0], meaningHash: `sha256:${'1'.repeat(64)}` }]), /raise the line's version/)
})

test('a stored row edited by hand with its hashes left as they were is refused, not kept as reviewed', async () => {
  const maps = await currentMaps()
  const lines = await currentLines(maps)
  const fresh = JSON.parse(mergeOpened(null, maps, lines)) as BrowserOpenedFile
  const lineEdited = JSON.parse(JSON.stringify(fresh)) as BrowserOpenedFile
  const withChecks = lineEdited.lines.find(l => l.line.read.checks.length > 1)!
  withChecks.line.read.checks = withChecks.line.read.checks.slice(0, 1)
  assert.throws(() => mergeOpened(JSON.stringify(lineEdited), maps, lines), /does not match its hashes/)
  const mapEdited = JSON.parse(JSON.stringify(fresh)) as BrowserOpenedFile
  delete (mapEdited.maps[0].map.things.action_set as { must_hold?: unknown }).must_hold
  assert.throws(() => mergeOpened(JSON.stringify(mapEdited), maps, lines), /does not match its hash/)
  const statusOdd = JSON.parse(JSON.stringify(fresh)) as { lines: { status: string }[] }
  statusOdd.lines[0].status = 'open'
  assert.throws(() => mergeOpened(JSON.stringify(statusOdd), maps, lines), /no known status/)
})

test('the old path is untouched: the connector folder is still lstep@0.6.3\'s approved checker', () => {
  const carried = JSON.parse(readFileSync(CARRIED_FILE, 'utf8')) as { combinations: { version: string; checkerHash: string }[] }
  const approved = JSON.parse(readFileSync(APPROVED_FILE, 'utf8')) as { combinations: { version: string; checkerHash: string; status: string }[] }
  const hash = folderHash(join(CONNECTORS_DIR, 'lstep'))
  assert.deepEqual(carried.combinations.map(c => [c.version, c.checkerHash]), [['0.6.3', hash]])
  assert.equal(approved.combinations.find(c => c.version === '0.6.3' && c.checkerHash === hash)?.status, 'approved')
  // The map is not in the connector folder (its fingerprint would move the approved checker hash).
  assert.ok(!resolve(CONNECTORS_DIR, 'lstep').startsWith(resolve(CONNECTORS_DIR, '..', 'connector-maps')))
})
