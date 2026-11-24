/**
 * Lステップ's map 1.0.2 and the first write line `step_template_add` (generalization PR 6; agent-browser.md "The write words
 * and the first write line"): today's 「リマインダの段にテンプレートを足す」 (`lstep@0.6.x`) as map + one line.
 *
 * Guards (each test fails when its guard is removed):
 * - the new things list exactly the key names the old path recorded (§36, §39, §40) and read whole from answers of those
 *   shapes (made up, no real value); a key more, a hidden reminder, a step of another reminder, a template that is not
 *   text, a step not on the reminder's page → not read;
 * - the step's templates are read exactly as the old checker reads them (the same page gives the same templates);
 * - the line opens, is written `pending` and no business word is in it;
 * - the prediction: exactly the one template added to that step, nothing else changed — a second template, none, another
 *   one, a template removed, the reminder / timing / template changed, the account moving, the step moving to another
 *   reminder → never "as predicted";
 * - the must-hold facts: the account on every read, the shared-reminder note always on the card;
 * - the new path's lock key for the step equals the old path's for the same step (the old path's files themselves are
 *   held to their approved hash by browser-lstep-map.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBrowserThing, type BrowserThingResult } from '../../shared/core/browser-map'
import { evaluateBrowserReadLine, type BrowserReadFacts } from '../../shared/core/browser-read-line'
import { buildBrowserReadCard } from '../../shared/core/browser-card'
import { browserLineWriteLocks, judgeBrowserWrites, predictBrowserWrites } from '../../shared/core/browser-write-line'
import { browserLockKey, type BrowserFieldKind } from '../../shared/core/browser-plans'
import { parsePluginManifest } from '../../shared/core/plugins'
import type { BrowserOpenedFile } from '../../shared/core/browser-opened'
import { lstepMap } from '../connector-maps/lstep'
import { LSTEP_MAP_WRITES } from '../connector-maps/lstep/map'
import { LINES } from '../browser-lines/lstep'
import { createLstepReminderStepChecker } from '../connectors/lstep/reminder-step'
import { LSTEP_DECLARATION } from '../connectors/lstep/declaration'
import { MAPS_DIR, OPENED_FILE, mapReadersHash } from '../scripts/browser-opened'
import { CONNECTORS_DIR } from '../scripts/browser-connectors'

const { map, readers } = lstepMap()
const line = LINES.find(l => l.name === 'step_template_add')!
const writes = line.writes!

const REMINDER = '7100002'
const STEP = '7200003'
const FOLDER = '7300004'
const TEMPLATE = '7400005'

// --- made-up answers of the recorded shapes (§36, §39, §40, §41: key names only) ---

function reminderAnswer(over: Record<string, unknown> = {}, steps: unknown[] = [stepEntry(STEP)]): Record<string, unknown> {
  return { id: Number(REMINDER), name: '見本のリマインダ', order: 1, type: 1, hid_at: null, steps, ...over }
}
function stepEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(id), order: 0, step_days: 0, step_time: '09:00:00', step_type: 1, step_minutes: null, skip: 1, initial: 0,
    egg_id: null, member_query_id: null, action_id: null, episode_id: Number(REMINDER), ...over,
  }
}
const timingAnswer = (over: Record<string, unknown> = {}) => ({
  episode_id: Number(REMINDER), episode_group_id: 7100001, episode_name: '見本のリマインダ', episode_step_id: Number(STEP),
  step_timing_text: '当日 09:00', ...over,
})
const templateAnswer = (over: Record<string, unknown> = {}) => ({
  id: Number(TEMPLATE), name: '見本のテンプレート', content_text: '見本の本文', created_at: 'x', form_type: 8,
  group: { id: Number(FOLDER), name: '見本のフォルダ' }, editor_version: 2, ...over,
})
const folderAnswer = (over: Record<string, unknown> = {}) => ({ id: Number(FOLDER), name: '見本のフォルダ', order: 1, item_count: 3, ...over })

/** The reminder's page as the server sends it (§41): one row per attached template, the step's box after its table. */
function reminderPage(templates: string[], reminder = REMINDER): string {
  const rows = templates.map((t, i) => `<tr><th><small>#${i + 1}</small></th><td>テンプレート 見本</td><td><button type="button" @click="openModal(${reminder}, ${STEP}, ${16100001 + i}, ${t}, 8)">編集</button></td><td><form method="POST" action="https://manager.linestep.net/line/episode/step/pack"><input type="hidden" name="_method" value="DELETE"><input type="hidden" name="hole_id" value="${16100001 + i}"><input type="hidden" name="content_id" value="${STEP}"></form></td></tr>`).join('')
  return `<!doctype html><html><head><meta name="lm-account-id" content="90171"><meta name="csrf-token" content="tok"></head><body>`
    + `<input type="hidden" name="_token" value="tok"><input type="hidden" name="_lm_user_id" value="u1">`
    + (templates.length ? `<div id="template_confirm_${STEP}"><table>${rows}<tr><td></td></tr></table></div>` : '')
    + `<div class="step" id="templateStep${STEP}"><span>当日</span></div></body></html>`
}

const read = (thing: string, answer: unknown, address?: string, parent?: string): BrowserThingResult =>
  readBrowserThing(map, thing, answer, readers[thing], address, parent)
const keysOf = (thing: string) => Object.keys(map.things[thing].keys ?? {}).sort()

test('the new things list exactly the key names the old path recorded', () => {
  assert.equal(map.version, '1.0.2')
  assert.deepEqual(keysOf('reminder'), ['hid_at', 'id', 'name', 'order', 'steps', 'steps[].action_id', 'steps[].egg_id', 'steps[].episode_id',
    'steps[].id', 'steps[].initial', 'steps[].member_query_id', 'steps[].order', 'steps[].skip', 'steps[].step_days', 'steps[].step_minutes',
    'steps[].step_time', 'steps[].step_type', 'type'])
  assert.deepEqual(keysOf('step_timing'), ['episode_group_id', 'episode_id', 'episode_name', 'episode_step_id', 'step_timing_text'])
  assert.deepEqual(keysOf('template'), ['content_text', 'created_at', 'editor_version', 'form_type', 'group', 'group.id', 'group.name', 'id', 'name'])
  assert.deepEqual(keysOf('template_folder'), ['id', 'item_count', 'name', 'order'])
  assert.equal(map.things.reminder_step.answer, 'html')
  assert.equal(map.things.reminder_step.keys, undefined)
})

test('each new thing reads whole from an answer of the recorded shape', () => {
  const r = read('reminder', reminderAnswer())
  assert.deepEqual(r.status === 'read' && r.state, { id: REMINDER, name: '見本のリマインダ', steps: [STEP] })
  const s = read('reminder_step', reminderPage(['300', '301']), STEP, REMINDER)
  assert.deepEqual(s.status === 'read' && s.state, { step: STEP, reminder: REMINDER, templates: ['300', '301'] })
  const empty = read('reminder_step', reminderPage([]), STEP, REMINDER)
  assert.deepEqual(empty.status === 'read' && empty.state.templates, [])
  const t = read('step_timing', timingAnswer())
  assert.deepEqual(t.status === 'read' && t.state, { step: STEP, reminder: REMINDER, timing: '当日 09:00' })
  const tp = read('template', templateAnswer())
  assert.deepEqual(tp.status === 'read' && tp.state, { id: TEMPLATE, folder: FOLDER, name: '見本のテンプレート', body: '見本の本文' })
  // 「未分類」: no folder object, read as folder 0 (§40).
  const un = read('template', templateAnswer({ group: null }))
  assert.equal(un.status === 'read' && un.state.folder, '0')
  assert.equal(read('template_folder', folderAnswer({ id: 0, name: '未分類' })).status, 'read')
})

test('a key more, a hidden reminder, a step of another reminder, a template not text, a step not on the page → not read', () => {
  const notRead = (r: BrowserThingResult, why: string) => assert.equal(r.status, 'not_read', why)
  notRead(read('reminder', reminderAnswer({ extra: 1 })), 'a key more')
  notRead(read('reminder', reminderAnswer({ hid_at: '2026-11-01 10:00:00' })), 'hidden')
  notRead(read('reminder', reminderAnswer({}, [stepEntry(STEP, { episode_id: 9 })])), 'a step naming another reminder')
  notRead(read('reminder', reminderAnswer({}, [stepEntry(STEP), stepEntry(STEP)])), 'a step twice')
  notRead(read('reminder', reminderAnswer({}, [stepEntry(STEP, { surprise: 1 })])), 'a step key more')
  notRead(read('step_timing', timingAnswer({ step_timing_text: '当日\n09:00' })), 'two lines')
  notRead(read('step_timing', timingAnswer({ extra: 1 })), 'a key more')
  notRead(read('template', templateAnswer({ form_type: 2 })), 'not a text template')
  notRead(read('template', templateAnswer({ group: { id: Number(FOLDER), name: 'x', order: 1 } })), 'a folder key more')
  notRead(read('template', templateAnswer({ secret: 1 })), 'a key more')
  // The step's page: not the reminder asked, no step box, no ids, too long.
  notRead(read('reminder_step', reminderPage(['300'], '9999999'), STEP, REMINDER), 'rows naming another reminder')
  notRead(read('reminder_step', '<html><body></body></html>', STEP, REMINDER), 'no step on the page')
  notRead(read('reminder_step', reminderPage(['300']), STEP, undefined), 'no reminder asked')
  notRead(read('reminder_step', reminderPage(['300']), undefined, REMINDER), 'no step asked')
  notRead(read('reminder_step', { html: reminderPage(['300']) }, STEP, REMINDER), 'not a page')
  notRead(read('reminder_step', 'x'.repeat(5_000_001), STEP, REMINDER), 'too long')
})

test('the step\'s templates are read exactly as the old path\'s checker reads them', () => {
  const view = createLstepReminderStepChecker(() => null).view
  for (const templates of [[], ['300'], ['300', '300'], ['301', '300']]) {
    const page = reminderPage(templates)
    const old = view({ target: { reminder: REMINDER, step: STEP }, change: {} }, [{ path: `/line/episode/show/${REMINDER}`, body: page }])
    const r = read('reminder_step', page, STEP, REMINDER)
    assert.deepEqual(r.status === 'read' && [...(r.state.templates as string[])].sort(), [...(old.state?.templates ?? [])].sort())
  }
})

test('the line opens on map 1.0.2, is written pending, and holds no business word', () => {
  const opened = JSON.parse(readFileSync(OPENED_FILE, 'utf8')) as BrowserOpenedFile
  const rows = opened.lines.filter(l => l.name === 'step_template_add')
  assert.deepEqual(rows.map(r => [r.mapVersion, r.status]), [['1.0.2', 'pending']])
  const text = JSON.stringify({ map, line, LSTEP_MAP_WRITES })
  for (const word of ['参加者', '18:20', '新方式', 'クロチャレ', 'crochalle']) assert.ok(!text.includes(word), word)
})

test('the write is the old declaration\'s write, word for word', () => {
  const parsed = parsePluginManifest(LSTEP_DECLARATION)
  assert.ok(parsed.ok && parsed.value.browser)
  const old = parsed.value.browser.operations.reminder_step_add_template
  const w = LSTEP_MAP_WRITES.reminder_step.add_child.templates
  assert.deepEqual([old.writes[0].method, old.writes[0].path, old.writes[0].ignoreBody], [w.method, w.path, [...w.ignore_body]])
  assert.deepEqual(old.writes[0].body, { content_id: { field: 'step' }, template_id: { field: 'template' } })
  assert.deepEqual(w.form, { content_id: '{id}', template_id: '{value}' })
  // The note is the old declaration's `shared` sentence.
  assert.equal(map.things.reminder_step.must_hold?.note, old.shared)
})

// --- the generic before / after ---

const site = (value: string) => ({ value, from: { kind: 'site_fact' as const } })
interface Answers { reminder?: unknown; page?: string; timing?: unknown; template?: unknown; account?: BrowserReadFacts['account'] }
function facts(a: Answers = {}): BrowserReadFacts {
  return {
    reads: {
      reminder: read('reminder', a.reminder ?? reminderAnswer()),
      step: read('reminder_step', a.page ?? reminderPage(['300']), STEP, REMINDER),
      timing: read('step_timing', a.timing ?? timingAnswer()),
      template: read('template', a.template ?? templateAnswer()),
    },
    values: { reminder: site(REMINDER), step: site(STEP), template_folder: site(FOLDER), template: site(TEMPLATE) },
    account: a.account ?? { before: '90171', after: '90171' },
  }
}
const judge = (after: Answers, before: Answers = {}, account = '90171') => judgeBrowserWrites(line.read, writes, map, facts(before), facts(after), account)

test('exactly the one template added to that step, nothing else changed → as predicted', () => {
  assert.deepEqual(judge({ page: reminderPage(['300', TEMPLATE]) }), { status: 'as_predicted' })
  // Where it lands among the rows does not matter (a list kept in any order).
  assert.deepEqual(judge({ page: reminderPage([TEMPLATE, '300']) }), { status: 'as_predicted' })
  // The same template already on the step: it stands once more (two holes).
  assert.deepEqual(judge({ page: reminderPage(['300', TEMPLATE, TEMPLATE]) }, { page: reminderPage(['300', TEMPLATE]) }), { status: 'as_predicted' })
})

test('anything else after the write is never "as predicted"', () => {
  const notPredicted = (after: Answers, read: string, before: Answers = {}) => {
    const j = judge(after, before)
    assert.equal(j.status, 'not_as_predicted', JSON.stringify(after).slice(0, 80))
    if (j.status === 'not_as_predicted') assert.ok(read in j.differs, read)
  }
  notPredicted({ page: reminderPage(['300']) }, 'step') // nothing added
  notPredicted({ page: reminderPage(['300', TEMPLATE, TEMPLATE]) }, 'step') // added twice
  notPredicted({ page: reminderPage(['300', '301']) }, 'step') // another one
  notPredicted({ page: reminderPage([TEMPLATE]) }, 'step') // one taken away, ours added
  notPredicted({ page: reminderPage(['300', TEMPLATE]), reminder: reminderAnswer({ name: '別の名前' }) }, 'reminder')
  notPredicted({ page: reminderPage(['300', TEMPLATE]), reminder: reminderAnswer({}, [stepEntry(STEP), stepEntry('7200009')]) }, 'reminder')
  notPredicted({ page: reminderPage(['300', TEMPLATE]), timing: timingAnswer({ step_timing_text: '1日後 09:00' }) }, 'timing')
  notPredicted({ page: reminderPage(['300', TEMPLATE]), template: templateAnswer({ content_text: '書き換わった本文' }) }, 'template')
})

test('after the write: the account moving, a read not whole or another reminder → unreadable, never as predicted', () => {
  const unreadable = (after: Answers, before: Answers = {}) => assert.equal(judge(after, before).status, 'unreadable', JSON.stringify(after).slice(0, 80))
  const good = reminderPage(['300', TEMPLATE])
  unreadable({ page: good, account: { before: '90172', after: '90172' } })
  // Before and after agree with each other but not with the plan's account.
  assert.equal(judge({ page: good, account: { before: '90172', after: '90172' } }, { account: { before: '90172', after: '90172' } }).status, 'unreadable')
  unreadable({ page: good, account: { before: '90171', after: '90172' } })
  unreadable({ page: good, account: { before: null, after: null } })
  unreadable({ page: good, reminder: reminderAnswer({ extra: 1 }) })
  unreadable({ page: good, timing: timingAnswer({ episode_id: 9 }) })
  unreadable({ page: '<html></html>' })
  unreadable({ page: good, template: templateAnswer({ form_type: 2 }) })
  // Before the write the reads must have made a plan.
  unreadable({ page: good }, { account: { before: '90171', after: '90172' } })
  unreadable({ page: good }, { template: templateAnswer({ group: { id: 9, name: 'x' } }) })
})

test('the prediction cannot be made from a state that is not one of its thing', () => {
  assert.equal(predictBrowserWrites(line.read, writes, map, {}, { template: TEMPLATE }), null)
})

test('before the write: the must-hold facts hold on every read and the shared note is on the card', () => {
  const f = facts()
  const outcome = evaluateBrowserReadLine(line.read, map, f)
  assert.equal(outcome.problem, null)
  const card = buildBrowserReadCard(line, map, f, outcome)
  assert.ok(card.notes.some(n => n.startsWith('全部の回で共有のリマインダです')))
  for (const account of [{ before: '90171', after: '90172' }, { before: null, after: '90171' }]) {
    const o = evaluateBrowserReadLine(line.read, map, facts({ account }))
    assert.ok(Object.values(o.reads).every(s => s !== 'ok'), JSON.stringify(account))
    assert.notEqual(o.problem, null)
  }
  // The step's timing of another reminder: wrong parent.
  assert.equal(evaluateBrowserReadLine(line.read, map, facts({ timing: timingAnswer({ episode_id: 9 }) })).reads.timing, 'wrong-parent')
  // A template of another folder than the one the site showed: wrong parent.
  assert.equal(evaluateBrowserReadLine(line.read, map, facts({ template: templateAnswer({ group: { id: 9, name: 'x' } }) })).reads.template, 'wrong-parent')
})

test('the new path holds the old path\'s lock key for the same step', () => {
  const parsed = parsePluginManifest(LSTEP_DECLARATION)
  assert.ok(parsed.ok && parsed.value.browser)
  const op = parsed.value.browser.operations.reminder_step_add_template
  const where = { company: 'c1', host: parsed.value.browser.host, account: '90171' }
  const old = browserLockKey({
    ...where, kind: op.lock!.kind, fields: op.target as Record<string, BrowserFieldKind>, target: { reminder: REMINDER, step: STEP },
  })
  const keys = browserLineWriteLocks(line.read, writes, map, { reminder: REMINDER, step: STEP, template: TEMPLATE, template_folder: FOLDER }, where)
  assert.deepEqual(keys, [old])
})

test('the map\'s reader fingerprint covers the old checker it reads with (a change there needs a new map version)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acb-map-readers-'))
  try {
    cpSync(join(CONNECTORS_DIR, 'lstep'), join(dir, 'lstep'), { recursive: true })
    const before = mapReadersHash(join(MAPS_DIR, 'lstep'), 'lstep', dir)
    assert.equal(before, mapReadersHash(join(MAPS_DIR, 'lstep'), 'lstep'))
    writeFileSync(join(dir, 'lstep', 'reminder-step.ts'), `${readFileSync(join(dir, 'lstep', 'reminder-step.ts'), 'utf8')}\n// changed\n`)
    assert.notEqual(mapReadersHash(join(MAPS_DIR, 'lstep'), 'lstep', dir), before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
