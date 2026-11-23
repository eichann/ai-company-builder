// 全社 is a choice (records.md "全社 is a choice", owner decision 2026-11-23): the chat server tells the
// record tools the member is on the 全社 tab (`companyScreen`, sent as `defaultPlace: 'company'`) only in a
// consultation with no department on screen — never with a department, and never in an unattended 「AI の番」
// run, whose creates must not be read as 全社 by the app's word.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

async function companyScreenOf(body: Record<string, unknown>): Promise<unknown> {
  const { startChatServer } = await import('../electron/chat-server')
  let seen: unknown = 'not asked'
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    getWriteGuard: () => ({ root: os.tmpdir(), getAccess: () => undefined }),
    createRecordTools: async (request: { companyScreen?: boolean }) => {
      seen = request.companyScreen
      return { specs: [{ name: 'records_get' }], instructions: '', close: async () => {}, execute: async () => '', readTask: async () => null }
    },
  } as never)
  const abort = new AbortController()
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', companyRootPath: os.tmpdir(), ...body }),
    })
    await res.text().catch(() => '')
  } catch { /* the turn itself is not what is tested */ } finally {
    abort.abort()
    server.server.close()
  }
  return seen
}

test('the 全社 tab of a consultation says 全社; a department on screen or an unattended run does not', async () => {
  assert.equal(await companyScreenOf({ appSessionId: 'conv-company-001' }), true)
  assert.equal(await companyScreenOf({ appSessionId: 'conv-dept-00001', activeDepartment: { name: '営業部', folder: '営業部' } }), false)
  assert.equal(await companyScreenOf({ appSessionId: 'conv-turn-00001', aiTurnStep: 'minutes-reading' }), false)
})
