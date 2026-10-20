import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { startChatServer } from '../../electron/chat-server'
import { ChatHistoryStore } from '../../electron/chat-history-store'
import { HandoffStore, fingerprint } from '../../electron/handoff/store'
import { recoveryContext } from '../../electron/handoff/recovery-context'
import { HANDOFF_HEADINGS } from '../../electron/handoff/contract'
import type { ChatSession } from '../../shared/chat-history'
import type { HandoffRecovery } from '../../shared/handoff'
// Explicitly synthetic data and a fresh random missing native ID; no existing native sessions are removed.
const output = process.argv[2]
if (!path.isAbsolute(output || '')) throw new Error('New absolute output directory required')
fs.mkdirSync(output)
const cwd = path.join(output, 'empty-project'); fs.mkdirSync(cwd)
const history = new ChatHistoryStore(path.join(output, 'history'))
const store = new HandoffStore(path.join(output, 'memo'), history)
const events: HandoffRecovery[] = []
const env = Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => typeof p[1] === 'string'))
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[key]
const start = () => startChatServer({
  getShellEnv: () => env, getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => process.env.ACB_HANDOFF_CLAUDE_CLI || path.join(os.homedir(), '.local/bin/claude'),
  getApiKey: () => undefined, getAuthMode: () => 'claude-code', buildSystemPrompt: () => '',
  requestToolApproval: async () => ({ approved: false }), requestInteraction: async () => ({ cancelled: true }),
  prepareRecovery: (company, id, messages) => recoveryContext(history.get(company, id), store.read(company, id), messages),
  onRecovery: (_, __, event) => { events.push(event) },
  persistAgentSession: (company, id, session) => { assert.ok(history.patch(company, id, { agentSession: session })) },
})
let server = await start()
let headers = { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' }
async function send(body: object) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
  const raw = await response.text()
  const parts = raw.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)))
  const error = parts.find(p => p.type === 'error')
  if (!response.ok || error) throw new Error(error?.errorText || raw)
  return parts.filter(p => p.type === 'text-delta').map(p => p.delta).join('') as string
}
try {
  for (const provider of ['claude-code', 'codex'] as const) {
    events.length = 0
    const oldId = crypto.randomUUID()
    const modelId = provider === 'claude-code' ? 'haiku' : undefined
    const session: ChatSession = { id: provider, companyId: 'probe', title: '人工会話の復旧検証', createdAt: '2000-01-01', updatedAt: '2000-01-01', agentSession: { providerId: provider, id: oldId, modelId }, messages: [
      { id: 'u1', role: 'user', content: '桜計画の予算は15万円。納期は11月19日。担当は田中。公開前に私の画面確認が必要。JSON保存を維持するのは配布への影響を避けるため。', timestamp: '2000-01-01' },
      { id: 'a1', role: 'assistant', content: '了解しました。テストは未実施です。', timestamp: '2000-01-01' },
      { id: 'u2', role: 'user', content: '訂正です。予算を12万円にしてください。', timestamp: '2000-01-01' },
      { id: 'a2', role: 'assistant', content: '予算を訂正しました。', timestamp: '2000-01-01' },
    ] }
    history.save('probe', session)
    const memo = HANDOFF_HEADINGS.map((h, i) => `## ${h}\n- ${['桜計画', '予算15万円、11月19日、田中。公開前にユーザーの画面確認が必要。JSON維持は配布への影響を避けるため。', 'テストは未実施', 'テストと画面確認', 'ユーザー確認を待つ', 'なし'][i]}`).join('\n\n')
    const cursor = { index: 2, offset: 0 }
    store.write('probe', provider, { version: 1, turns: 2, memo: { markdown: memo, hash: fingerprint(session.messages, cursor), cursor, turns: 1, provider, updatedAt: '2000-01-01', metrics: { totalMs: 0 } } })
    const prior = session.messages.map(m => ({ id: m.id, role: m.role, parts: [{ type: 'text', text: m.content }] }))
    const question = 'これは人工会話の検証です。ツールやファイル操作は一切せず、現在の予算・担当・納期・JSON維持の理由・公開前の条件を短く答えてください。'
    const messages = [...prior, { id: 'u3', role: 'user', parts: [{ type: 'text', text: question }] }]
    const body = { companyId: 'probe', appSessionId: provider, authMode: provider, agentSession: session.agentSession, modelId, workingDirectory: cwd, messages }
    const started = Date.now()
    const answer = await send(body)
    assert.equal(events.filter(e => e.status === 'recovering').length, 1)
    assert.equal(events.at(-1)?.status, 'recovered'); assert.equal(events.at(-1)?.usedMemo, true)
    const saved = history.get('probe', provider)!.agentSession!
    assert.notEqual(saved.id, oldId)
    assert.match(answer, /12万|120,?000/); assert.match(answer, /田中/); assert.match(answer, /19/)
    const recoveredMs = Date.now() - started
    // Client intentionally still sends the stale ID: server mapping must use the newly saved session.
    const followup = await send({ ...body, messages: [...messages, { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: answer }] }, { id: 'u4', role: 'user', parts: [{ type: 'text', text: 'ツールを使わず、予算だけもう一度答えてください。' }] }] })
    assert.equal(events.filter(e => e.status === 'recovering').length, 1); assert.match(followup, /12万|120,?000/)
    // Recreate server and history store to exercise persistence, not just the in-memory session map.
    await new Promise<void>(resolve => server.server.close(() => resolve()))
    server = await start()
    headers = { ...headers, Authorization: `Bearer ${server.authToken}` }
    const restored = new ChatHistoryStore(path.join(output, 'history')).get('probe', provider)!.agentSession
    const afterRestart = await send({ ...body, agentSession: restored, messages: [...messages.slice(0, -1), { id: 'restart-question', role: 'user', parts: [{ type: 'text', text: 'ツールを使わず、予算だけ答えてください。' }] }] })
    assert.match(afterRestart, /12万|120,?000/)
    assert.equal(events.filter(e => e.status === 'recovering').length, 1)
    fs.writeFileSync(path.join(output, `${provider}.json`), JSON.stringify({ recoveredMs, events, answer, followup, afterRestart, persistedNewId: true }, null, 2))
    console.log(JSON.stringify({ provider, recoveredMs, recovered: true, followupResumed: true }))
  }
} finally { server.server.close() }
