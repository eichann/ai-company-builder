/**
 * The AI sandbox enforced through Codex (sandbox S4): the thread runs the
 * app's permission profile (never a legacy sandbox mode, which would switch
 * profiles off), Codex must confirm the profile is in force before the turn
 * starts, and a command its proxy refused is logged as blocked.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel } from 'ai'
import { createCodexConnection, type CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'
import type { TurnSandbox } from '../electron/agents/connection'
import { recordCodexItem } from '../electron/agents/codex-tool-events'
import { CODEX_SANDBOX_PROFILE, SANDBOX_MESSAGES, resolveSandbox, sandboxConcern } from '../shared/agents/sandbox-policy'
import { createToolEventTracker, type AgentToolEvent } from '../shared/agent-events'

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
const HOME = '/Users/member'
const COMPANY = `${HOME}/Documents/AI Company Builder/acme`
const resolved = resolveSandbox({ allowedDomains: ['api.github.com'], deniedReadPaths: [] }, { home: HOME, companyRoot: COMPANY })
const enforce = (onUnavailable: TurnSandbox['onUnavailable']): TurnSandbox => ({ mode: 'enforce', resolved, home: HOME, onUnavailable })

class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  calls: { method: string; params: Record<string, unknown> }[] = []
  constructor(private profile: unknown) {}
  async initialize() {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'turn/start') {
      setImmediate(() => {
        this.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'th', itemId: 'a', delta: 'done' } })
        this.onMessage({ method: 'item/completed', params: { threadId: 'th', item: { id: 'a', type: 'agentMessage', text: 'done' } } })
        this.onMessage({ method: 'turn/completed', params: { threadId: 'th', turn: { status: 'completed' } } })
      })
    }
    const results: Record<string, unknown> = {
      'account/read': { account: { type: 'chatgpt' } },
      'model/list': { data: [{ model: 'm', displayName: 'M', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] },
      'thread/start': { thread: { id: 'th' }, activePermissionProfile: this.profile },
      'turn/start': { turn: { id: 'tu' } },
    }
    return results[method] as T
  }
  send() {}
  close() {}
}

async function run(rpc: FakeRpc, sandbox?: TurnSandbox) {
  const connection = createCodexConnection({ getShellEnv: () => ({}) }, () => rpc)
  const model = connection.createChatModel({ workingDirectory: COMPANY, modelId: 'm', ...(sandbox ? { sandbox } : {}) }) as Model
  const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })
  let out = ''
  for await (const part of stream as unknown as AsyncIterable<{ type: string; delta?: string; error?: Error }>) {
    if (part.type === 'text-delta') out += part.delta
    if (part.type === 'error') out += `[error ${part.error?.message}]`
  }
  return { out, start: rpc.calls.find(c => c.method === 'thread/start')!.params, turned: rpc.calls.some(c => c.method === 'turn/start') }
}

test('enforce: the thread runs the app\'s permission profile with its proxy, never a legacy sandbox mode', async () => {
  const { out, start } = await run(new FakeRpc({ id: CODEX_SANDBOX_PROFILE, extends: ':workspace' }), enforce('stop'))
  assert.equal(out, 'done')
  assert.equal(start.sandbox, undefined, 'a legacy sandbox mode would switch the profile off')
  const config = start.config as { default_permissions: string; features: Record<string, unknown>; permissions: Record<string, { network: { domains: Record<string, string> }; filesystem: Record<string, string> }> }
  assert.equal(config.default_permissions, CODEX_SANDBOX_PROFILE)
  assert.equal(config.features.network_proxy, true)
  assert.deepEqual(Object.keys(config.permissions[CODEX_SANDBOX_PROFILE].network.domains), ['api.github.com'])
  assert.equal(config.permissions[CODEX_SANDBOX_PROFILE].filesystem[`${HOME}/.ssh`], 'deny')
})

test('observe or off: the thread starts exactly as before (workspace-write, no profile)', async () => {
  for (const sandbox of [undefined, { ...enforce('stop'), mode: 'observe' as const }]) {
    const { start } = await run(new FakeRpc(null), sandbox)
    assert.equal(start.sandbox, 'workspace-write')
    assert.equal((start.config as Record<string, unknown> | undefined)?.default_permissions, undefined)
  }
})

test('Codex did not apply the profile + company says stop: the turn never starts', async () => {
  for (const profile of [null, undefined, { id: 'evil' }]) {
    const { out, turned } = await run(new FakeRpc(profile), enforce('stop'))
    assert.equal(out, `[error ${SANDBOX_MESSAGES.startFailedStop}]`)
    assert.equal(turned, false)
  }
})

test('Codex did not apply the profile + company says record only: the turn runs and says so', async () => {
  const { out, turned } = await run(new FakeRpc(null), enforce('record-only'))
  assert.equal(out, `※ ${SANDBOX_MESSAGES.startFailedRecordOnly}\n\ndone`)
  assert.equal(turned, true)
})

test('a command Codex\'s proxy refused is logged as blocked, with the host the command named', () => {
  const events: AgentToolEvent[] = []
  const tracker = createToolEventTracker({ agent: 'codex', companyRoot: COMPANY, home: HOME, sandbox: { mode: 'enforce', concern: call => sandboxConcern(resolved, call.tool, call.input, HOME) } }, e => events.push(e))
  const item = { id: 'i1', type: 'commandExecution', command: "/bin/zsh -lc \"curl -sS https://example.org/\"", status: 'failed', aggregatedOutput: 'curl: (56) CONNECT tunnel failed, response 403\n' }
  recordCodexItem(tracker, 'item/started', item)
  recordCodexItem(tracker, 'item/completed', item)
  // codex-cli 0.153.4 under the profile: a denied place.
  const read = { id: 'i2', type: 'commandExecution', command: `python3 -c "open('${HOME}/.ssh/config')"`, status: 'failed', aggregatedOutput: `PermissionError: [Errno 1] Operation not permitted: '${HOME}/.ssh/config'` }
  recordCodexItem(tracker, 'item/started', read)
  recordCodexItem(tracker, 'item/completed', read)
  assert.deepEqual(events.map(e => [e.sandbox, e.guardReason]), [['blocked', 'sandbox'], ['blocked', 'sandbox']])
  assert.deepEqual(events[0].target, { kind: 'command', programs: ['curl'], hosts: ['example.org'] })
})
