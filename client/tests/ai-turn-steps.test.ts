/**
 * The kinds of 「AI の番」 (`client/shared/ai-turn-steps/`, `.claude/rules/ai-turns.md` "Steps") and
 * the connectors' tool providers (`electron/records/tool-providers.ts`).
 *
 * Guards:
 * - a record runs under the one step its id belongs to; a kind without a step is never run;
 * - the runner's queue holds exactly the waiting records whose kind has a step, each from the list
 *   its step names (minutes only from main's minutes check), once;
 * - least privilege: a step whose tools are not exact (an ending matching every tool, a wildcard)
 *   or a step listed twice is refused; a connector's tools are not given to the minutes step;
 * - providers: several connectors' tools ride on one token, none replaces a record tool or an
 *   earlier provider's, a failing provider costs only its own tools, each call reaches its owner.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { aiTurnQueue, aiTurnStepAllowsRecordTool, aiTurnStepForRecord, checkAiTurnSteps } from '../shared/ai-turn-steps/registry'
import { minutesReading } from '../shared/ai-turn-steps/minutes-reading'
import type { AiTurnStepDefinition } from '../shared/ai-turn-steps/types'
import type { TaskListItem } from '../shared/tasks'
import { createRecordTools, type ExtraRecordTools, type RecordToolProvider } from '../electron/records/tools'
import type { RecordTurnAccess } from '../electron/records/api'

test('a record runs under its kind\'s step; a kind without a step is never run', () => {
  assert.equal(aiTurnStepForRecord('meeting-abcdef12')?.step, 'minutes-reading')
  assert.equal(aiTurnStepForRecord('minutes-abcdef12')?.step, 'minutes-reading')
  assert.equal(aiTurnStepForRecord('task-abcdef12'), null)
  assert.equal(aiTurnStepForRecord('meeting-abcdef12/../x'), null)
})

const item = (id: string, turn: TaskListItem['turn'], extra: Partial<TaskListItem> = {}): TaskListItem => ({
  id, type: id.split('-')[0], typeLabel: '', title: id, state: 'received', stateLabel: '', version: 4, due: null, tags: [],
  turn, waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null, ...extra,
})

test('the queue: received minutes from main\'s check, other kinds only when their step exists, each once', () => {
  const notice = { id: 'meeting-aaaaaaaa', title: '定例', meetingAt: '2026-11-01T01:00:00Z', version: 3 }
  const queue = aiTurnQueue({
    minutes: [notice, notice],
    tasks: [
      // A meeting is listed by the minutes check (only while Google may read minutes), not by the task list.
      item('meeting-bbbbbbbb', 'ai'),
      // No step for tasks (yet): shown in the list, never run.
      item('task-cccccccc', 'ai', { due: '2026-11-02T09:00' }),
      item('meeting-aaaaaaaa', 'ai'),
    ],
  })
  assert.deepEqual(queue, [{ id: 'meeting-aaaaaaaa', title: '定例', version: 3, meetingAt: '2026-11-01T01:00:00Z' }])
  assert.deepEqual(aiTurnQueue({ minutes: [], tasks: [item('meeting-bbbbbbbb', 'ai')] }), [])
})

const step = (over: Partial<AiTurnStepDefinition> & { tools?: Partial<AiTurnStepDefinition['tools']> }): AiTurnStepDefinition => ({
  ...minutesReading, ...over, tools: { ...minutesReading.tools, ...over.tools },
})

test('a step whose tools are not exact, or a step listed twice, is refused', () => {
  assert.equal(checkAiTurnSteps([minutesReading]), null)
  assert.match(checkAiTurnSteps([minutesReading, minutesReading]) ?? '', /twice/)
  assert.match(checkAiTurnSteps([step({ tools: { recordToolEndings: [''] } })]) ?? '', /not one exact tool/)
  assert.match(checkAiTurnSteps([step({ tools: { recordToolEndings: ['_deal'] } })]) ?? '', /not one exact tool/)
  assert.match(checkAiTurnSteps([step({ tools: { recordTools: ['records_*'] } })]) ?? '', /not one exact tool/)
  assert.match(checkAiTurnSteps([step({ tools: { builtinTools: ['*'] } })]) ?? '', /not one exact tool/)
  assert.match(checkAiTurnSteps([step({ step: 'x', recordId: /.*/ })]) ?? '', /matches any id/)
})

test('a connector\'s tools (Google Drive) are not given to an unattended minutes reading', () => {
  for (const name of ['drive_pick_folder', 'drive_read', 'drive_put', 'records_get', 'records_my_turn']) {
    assert.ok(!aiTurnStepAllowsRecordTool('minutes-reading', name), name)
  }
})

function fakeAccess(): RecordTurnAccess & { calls: string[] } {
  const calls: string[] = []
  return {
    scope: 'read',
    calls,
    async call(method: string, path: string) {
      calls.push(`${method} ${path}`)
      if (path === '/types') return { types: [] }
      if (path === '/plugins') return { plugins: [] }
      return {}
    },
    async close() {},
  } as unknown as RecordTurnAccess & { calls: string[] }
}

function provider(names: string[], instructions: string, ran: string[]): RecordToolProvider {
  return async (): Promise<ExtraRecordTools> => ({
    specs: names.map(name => ({ name, description: name, schema: z.object({}), readOnly: true })),
    instructions,
    async execute(name) { ran.push(`${instructions}:${name}`); return name },
  })
}

test('providers: tools of several connectors on one token; no replacing; a failure costs only its own tools', async () => {
  const ran: string[] = []
  const failing: RecordToolProvider = async () => { throw new Error('offline') }
  const tools = await createRecordTools(fakeAccess(), undefined, {
    toolProviders: [
      provider(['a_one', 'records_my_turn', 'shared_name'], '[A]', ran),
      failing,
      provider(['b_one', 'shared_name', 'bad name!'], '[B]', ran),
      provider(['records_my_turn'], '[C]', ran),
    ],
  })
  assert.ok(tools)
  const names = tools.specs.map(s => s.name)
  for (const n of ['a_one', 'b_one', 'shared_name']) assert.ok(names.includes(n), n)
  assert.equal(names.filter(n => n === 'records_my_turn').length, 1)
  assert.equal(names.filter(n => n === 'shared_name').length, 1)
  assert.ok(!names.includes('bad name!'))
  // Instructions only from providers that added a tool.
  assert.ok(tools.instructions.includes('[A]') && tools.instructions.includes('[B]') && !tools.instructions.includes('[C]'))
  await tools.execute('a_one', {})
  await tools.execute('b_one', {})
  await tools.execute('shared_name', {})
  assert.deepEqual(ran, ['[A]:a_one', '[B]:b_one', '[A]:shared_name'])
})
