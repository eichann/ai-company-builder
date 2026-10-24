import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS, AGENT_IDS, agentCan, agentDescriptor, claudeCliEffort, claudeCliModel, isAgentId } from '../shared/agents/registry'

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// The exact model strings the app sends: moving them into the registry must
// not change any of them (a model generation update changes this test on purpose).
// ---------------------------------------------------------------------------

test('Claude Code: UI keys → CLI model strings, defaults Opus 5.5 + medium', () => {
  assert.deepEqual(Object.fromEntries(AGENTS['claude-code'].models.map(m => [m.id, claudeCliModel(m.id)])), {
    'fable-5': 'claude-fable-5',
    'opus-5-5': 'claude-opus-5-5[1m]',
    'opus-5': 'claude-opus-5[1m]',
    'opus-4-8': 'claude-opus-4-8[1m]',
    'opus-4-6': 'claude-opus-4-6[1m]',
    sonnet: 'sonnet',
    haiku: 'haiku',
  })
  assert.equal(claudeCliModel(undefined), 'claude-opus-5-5[1m]')
  assert.equal(claudeCliModel(''), 'claude-opus-5-5[1m]')
  // An id the member's CLI knows but this table does not passes through.
  assert.equal(claudeCliModel('claude-something-new'), 'claude-something-new')
  assert.equal(AGENTS['claude-code'].defaultModel, 'opus-5-5')
  assert.equal(AGENTS['claude-code'].defaultEffort, 'medium')
})

test('Claude Code: xhigh is demoted to high where the CLI model does not take it', () => {
  for (const cli of ['claude-opus-5-5[1m]', 'claude-opus-5[1m]', 'claude-opus-4-8[1m]', 'claude-opus-4-7', 'claude-fable-5']) {
    assert.equal(claudeCliEffort(cli, 'xhigh'), 'xhigh', cli)
  }
  for (const cli of ['claude-opus-4-6[1m]', 'claude-opus-4-5', 'sonnet', 'haiku']) {
    assert.equal(claudeCliEffort(cli, 'xhigh'), 'high', cli)
  }
  assert.equal(claudeCliEffort('haiku', 'max'), 'max')
  assert.equal(claudeCliEffort('haiku', undefined), undefined)
})

test('per-feature models are unchanged', () => {
  assert.deepEqual(AGENTS['claude-code'].tasks, { chat: 'claude-opus-5-5[1m]', title: 'haiku', commitMessage: 'haiku', voice: 'haiku', handoff: 'haiku' })
  assert.deepEqual(AGENTS.codex.tasks, { commitMessage: 'gpt-5.6-luna', voice: 'gpt-5.6-luna', handoff: 'gpt-5.6-luna' })
  assert.deepEqual(AGENTS['api-key'].tasks, {
    chat: 'claude-sonnet-4-20250514', title: 'claude-haiku-4-5-20251001',
    commitMessage: 'claude-haiku-5-5', voice: 'claude-haiku-4-5-20251001',
  })
})

// ---------------------------------------------------------------------------
// Descriptor consistency
// ---------------------------------------------------------------------------

test('every entry is keyed by its own id, and lookups refuse anything else', () => {
  assert.deepEqual([...AGENT_IDS].sort(), Object.keys(AGENTS).sort())
  for (const id of AGENT_IDS) assert.equal(AGENTS[id].id, id)
  for (const bad of ['', 'claude', 'toString', '__proto__', null, undefined, 1]) {
    assert.equal(isAgentId(bad), false, String(bad))
    assert.equal(agentDescriptor(bad), undefined)
    assert.equal(agentCan(bad, 'ownsConversation'), false)
  }
})

test('models: unique ids, defaults among them, efforts non-empty; a live catalog has no static list', () => {
  for (const id of AGENT_IDS) {
    const agent = AGENTS[id]
    const ids = agent.models.map(m => m.id)
    assert.equal(new Set(ids).size, ids.length, id)
    for (const model of agent.models) assert.ok(model.efforts.length > 0, `${id}/${model.id}`)
    if (agent.defaultModel) {
      const model = agent.models.find(m => m.id === agent.defaultModel)
      assert.ok(model, `${id}: default model listed`)
      if (agent.defaultEffort) assert.ok(model.efforts.includes(agent.defaultEffort), `${id}: default effort valid`)
    }
    if (agent.capabilities.liveModelCatalog) assert.equal(agent.models.length, 0, id)
  }
})

test('capabilities that depend on others are consistent', () => {
  for (const id of AGENT_IDS) {
    const c = AGENTS[id].capabilities
    // Steering, suggestions, choice prompts, progress, MCP tools and hand-off
    // memos all ride on a native agent's own turn / session.
    for (const key of ['steering', 'promptSuggestions', 'choicePrompts', 'subagentProgress', 'rateLimits', 'companyFilesMcp', 'references', 'handoff'] as const) {
      if (c[key]) assert.ok(c.ownsConversation, `${id}.${key} needs ownsConversation`)
    }
    if (c.privateReadGuard) assert.ok(c.ownsConversation, `${id}.privateReadGuard`)
    if (c.commitMessageFallback || c.privateFolderCommitMessages) assert.ok(c.oneShotText, `${id}: commit messages need oneShotText`)
    const tasks = AGENTS[id].tasks
    if (c.oneShotText) assert.ok(tasks.commitMessage && tasks.voice, `${id}: one-shot models`)
    if (c.handoff) assert.ok(tasks.handoff, `${id}: hand-off model`)
  }
})

// ---------------------------------------------------------------------------
// No model id outside the registry
// ---------------------------------------------------------------------------

/** Model ids the app could send: Claude API / CLI ids, CLI aliases and UI keys as string literals, OpenAI ids. */
const MODEL_LITERALS = [
  /\bclaude-(?:opus|sonnet|haiku|fable)\b[\w.[\]-]*/,
  /\bgpt-\d[\w.-]*/,
  /['"`](?:opus|sonnet|haiku|fable)(?:-\d+)*(?:\[1m\])?['"`]/,
]
const REGISTRY = path.join('shared', 'agents', 'registry.ts')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(clientDir, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(rel)
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) ? [rel] : []
  })
}

test('no model id literal outside shared/agents/registry.ts', () => {
  const offenders: string[] = []
  for (const file of ['electron', 'src', 'shared'].flatMap(sourceFiles)) {
    if (file === REGISTRY) continue
    fs.readFileSync(path.join(clientDir, file), 'utf8').split('\n').forEach((line, i) => {
      if (MODEL_LITERALS.some(pattern => pattern.test(line))) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'Model ids belong in shared/agents/registry.ts (tasks / models)')
})

test('the literal check itself catches the shapes it is meant to', () => {
  for (const line of [
    "model: 'claude-haiku-4-5-20251001'", "createModel('haiku', {", "const id = 'opus-5-5'",
    "m.id === 'gpt-5.6-luna'", "'claude-opus-5-5[1m]'", '`sonnet`',
  ]) assert.ok(MODEL_LITERALS.some(p => p.test(line)), line)
  for (const line of [
    "seven_day_sonnet: '1週間（Sonnet）'", "const CLAUDE_WINDOW_ORDER = ['five_hour', 'seven_day_opus']",
    '// claude -p --model haiku', "provider: 'claude-code'",
  ]) assert.ok(!MODEL_LITERALS.some(p => p.test(line)), line)
})
