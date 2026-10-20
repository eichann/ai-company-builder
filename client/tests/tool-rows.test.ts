import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UIMessage } from 'ai'
import {
  GROUP_PAGE_SIZE,
  RUN_COLLAPSE_THRESHOLD,
  RUN_VISIBLE_TAIL,
  planParts,
  signaturePropsEqual,
  toolRowOf,
  toolRowPropsEqual,
  visibleRunItems,
  type AgentItem,
  type PlanItem,
  type RunItem,
} from '../src/components/chat/toolRows'

type Part = UIMessage['parts'][number]

function tool(id: string, name: string, state: string, opts: { parent?: string; input?: unknown; output?: unknown; errorText?: string } = {}): Part {
  return {
    type: 'dynamic-tool',
    toolCallId: id,
    toolName: name,
    state,
    input: opts.input ?? {},
    ...(state === 'output-available' ? { output: opts.output ?? 'ok' } : {}),
    ...(state === 'output-error' ? { errorText: opts.errorText ?? 'failed' } : {}),
    ...(opts.parent !== undefined ? { callProviderMetadata: { 'claude-code': { parentToolCallId: opts.parent } } } : {}),
  } as Part
}
const text = (t: string): Part => ({ type: 'text', text: t })

/** The failing turn's shape: 9 subagents with 902 inner calls, 78 main-thread calls. */
function bookTurn(running = 1): Part[] {
  const parts: Part[] = [{ type: 'step-start' }, text('始めます')]
  for (let a = 0; a < 9; a++) parts.push(tool(`agent-${a}`, 'Agent', a < 8 ? 'output-available' : 'input-available', { parent: null as unknown as string, input: { description: `${a + 1}章を精読`, prompt: '...' } }))
  for (let i = 0; i < 902; i++) {
    const state = i >= 902 - running ? 'input-available' : 'output-available'
    parts.push(tool(`inner-${i}`, i % 10 === 0 ? 'Write' : 'Read', state, { parent: `agent-${i % 9}`, input: { file_path: `/book/p${i}.jpg` }, output: ['[image: image/jpeg, 390KB]'] }))
  }
  for (let i = 0; i < 69; i++) {
    if (i % 23 === 0) parts.push(text(`途中経過 ${i}`), text(''))
    parts.push(tool(`main-${i}`, 'Bash', 'output-available', { input: { command: `ls ${i}` } }))
  }
  return parts
}

const runs = (plan: PlanItem[]) => plan.filter((p): p is RunItem => p.kind === 'run')
/** Top-level tool/agent items, in order. */
const topLevel = (plan: PlanItem[]) => runs(plan).flatMap(r => r.items)
const agentsOf = (plan: PlanItem[]) => topLevel(plan).filter((i): i is AgentItem => i.kind === 'agent')

test('subagent calls nest under their Agent row with recursive counts', () => {
  const plan = planParts(bookTurn())
  const agents = agentsOf(plan)
  assert.equal(agents.length, 9)
  assert.equal(agents.reduce((n, a) => n + a.toolCount, 0), 902)
  assert.equal(agents[0].description, '1章を精読')
  assert.equal(agents[0].toolCount, 101)
  // The single running inner call (index 901 → agent-1) is counted on its parent.
  assert.equal(agents[1].runningCount, 1)
  assert.equal(agents.filter(a => a.runningCount > 0).length, 1)
  // No inner call is rendered at top level.
  const topLevelIds = topLevel(plan).map(i => i.row.toolCallId)
  assert.equal(topLevelIds.some(id => id.startsWith('inner-')), false)
})

test('a 1,000-tool message renders a bounded number of rows by default', () => {
  const parts = bookTurn()
  assert.equal(parts.filter(p => p.type === 'dynamic-tool').length, 980)
  const plan = planParts(parts)
  // Rows mounted when nothing is expanded: top-level tools, plus the visible
  // tail of each collapsed run. Inner calls of collapsed groups mount nothing.
  let rows = 0
  for (const run of runs(plan)) rows += run.collapsible ? 1 + visibleRunItems(run.items).length : run.items.length
  assert.ok(rows <= 40, `rendered rows: ${rows}`)
  assert.ok(runs(plan).some(r => r.collapsible))
  // Every subagent group stays visible even inside a collapsed run.
  assert.equal(runs(plan).flatMap(r => r.collapsible ? visibleRunItems(r.items) : r.items).filter(i => i.kind === 'agent').length, 9)
})

test('runs collapse only above the threshold and keep the tail and running rows visible', () => {
  const short = Array.from({ length: RUN_COLLAPSE_THRESHOLD }, (_, i) => tool(`t${i}`, 'Bash', 'output-available'))
  const shortPlan = planParts(short)
  assert.equal(shortPlan.length, 1)
  assert.equal((shortPlan[0] as RunItem).collapsible, false)
  assert.equal((shortPlan[0] as RunItem).items.length, RUN_COLLAPSE_THRESHOLD)

  const long = Array.from({ length: 40 }, (_, i) => tool(`t${i}`, 'Bash', i === 5 ? 'input-available' : 'output-available'))
  const plan = planParts(long)
  assert.equal(plan.length, 1)
  const run = plan[0] as RunItem
  assert.equal(run.collapsible, true)
  assert.equal(run.key, (shortPlan[0] as RunItem).key, 'a run keeps its key as it grows past the threshold')
  assert.equal(run.items.length, 40)
  assert.equal(run.runningCount, 1)
  const visible = visibleRunItems(run.items).map(i => i.row.toolCallId)
  assert.deepEqual(visible, ['t5', ...Array.from({ length: RUN_VISIBLE_TAIL }, (_, i) => `t${40 - RUN_VISIBLE_TAIL + i}`)])

  // Visible text splits runs; empty text parts do not.
  const split = planParts([...long.slice(0, 20), text(''), ...long.slice(20, 30), text('区切り'), ...long.slice(30)])
  assert.deepEqual(split.map(p => p.kind), ['run', 'part', 'run'])
  assert.equal((split[0] as RunItem).items.length, 30)
})

test('Codex / api-key messages without parent metadata stay flat and in order', () => {
  const parts: Part[] = [text('a'), tool('c1', 'Bash', 'output-available', { input: { command: 'ls' } }), tool('c2', 'Write', 'output-error'), text('b')]
  const plan = planParts(parts)
  assert.deepEqual(plan.map(p => p.kind), ['part', 'run', 'part'])
  const run = plan[1] as RunItem
  assert.equal(run.collapsible, false)
  assert.deepEqual(run.items.map(i => [i.kind, i.row.toolCallId]), [['tool', 'c1'], ['tool', 'c2']])
  assert.equal(run.items[0].row.inputSummary, 'ls')
  // Static tool parts (api-key mode) keep their name from the part type.
  const row = toolRowOf({ type: 'tool-readFile', toolCallId: 'x', state: 'input-available', input: { path: 'a.md' } } as Part)
  assert.equal(row?.toolName, 'readFile')
  assert.equal(row?.inputSummary, 'a.md')
})

test('a run of only subagent groups never collapses (nothing would be hidden)', () => {
  const plan = planParts(Array.from({ length: 12 }, (_, i) => tool(`a${i}`, 'Agent', 'output-available', { input: { description: `d${i}` } })))
  assert.equal((plan[0] as RunItem).collapsible, false)
})

test('orphans whose parent is not in the message stay visible at top level', () => {
  const plan = planParts([tool('x', 'Read', 'output-available', { parent: 'missing-agent' })])
  assert.deepEqual(topLevel(plan).map(i => [i.kind, i.row.toolCallId]), [['tool', 'x']])
})

test('nested subagents nest recursively', () => {
  const plan = planParts([
    tool('a', 'Agent', 'input-available'),
    tool('b', 'Agent', 'input-available', { parent: 'a' }),
    tool('c', 'Read', 'input-available', { parent: 'b' }),
  ])
  assert.equal(topLevel(plan).length, 1)
  const outer = topLevel(plan)[0] as AgentItem
  assert.equal(outer.toolCount, 2)
  assert.equal(outer.runningCount, 2)
  assert.equal((outer.children[0] as AgentItem).children[0].row.toolCallId, 'c')
})

test('memo equality: finished rows are equal across fresh clones; changes that show are not', () => {
  const done = toolRowOf(tool('r', 'Read', 'output-available', { input: { path: 'a' } }))!
  const clone = structuredClone(done)
  assert.notEqual(done, clone)
  assert.equal(toolRowPropsEqual({ row: done }, { row: clone }), true)
  const streaming = toolRowOf(tool('r', 'Read', 'input-streaming', { input: { path: 'a' } }))!
  assert.equal(toolRowPropsEqual({ row: streaming }, { row: structuredClone(streaming) }), true)
  assert.equal(toolRowPropsEqual({ row: streaming }, { row: { ...streaming, inputSummary: 'ab' } }), false)
  assert.equal(toolRowPropsEqual({ row: streaming }, { row: done }), false)
  assert.equal(toolRowPropsEqual({ row: done }, { row: { ...clone, toolCallId: 'other' } }), false)
})

test('group signatures ignore re-cloning but change when the group changes', () => {
  const parts = bookTurn()
  const before = planParts(parts)
  const after = planParts(structuredClone(parts))
  runs(before).forEach((run, i) => assert.equal(signaturePropsEqual({ item: run }, { item: runs(after)[i] }), true))
  agentsOf(before).forEach((agent, i) => assert.equal(signaturePropsEqual({ item: agent }, { item: agentsOf(after)[i] }), true))
  // Finishing the running inner call changes exactly its parent's signature.
  const finished = structuredClone(parts).map(p => (p.type === 'dynamic-tool' && p.toolCallId === 'inner-901') ? { ...p, state: 'output-available', output: 'ok' } as Part : p)
  const next = planParts(finished)
  const changed = agentsOf(before).filter((a, i) => !signaturePropsEqual({ item: a }, { item: agentsOf(next)[i] })).map(a => a.key)
  assert.deepEqual(changed, ['agent-1'])
  // A new inner call changes its parent's signature too.
  const grown = planParts([...parts, tool('inner-new', 'Read', 'input-streaming', { parent: 'agent-3' })])
  assert.equal(signaturePropsEqual({ item: agentsOf(before)[3] }, { item: agentsOf(grown)[3] }), false)
  assert.ok(GROUP_PAGE_SIZE >= 10)
})
