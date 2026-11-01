// The bridge of a plugin's screen (stage 4b A5, .claude/rules/plugin-frame.md): a call is
// `{ id, op, args }` with one of bridge 1's ops and exactly the keys B6's route takes; main forwards
// it to the server with the member's session and the plugin of the frame the app created (never
// what the frame says), only for a package the app keeps for that company; a frame's page never
// navigates.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBridgeMessage, pluginFrameNavigationAllowed } from '../shared/plugin-bridge'
import { createPluginBridgeApi } from '../electron/features/plugins/bridge-ipc'
import { PLUGIN_BRIDGE_OPS, PLUGIN_BRIDGE_REFUSED } from '../../shared/types/plugin-bridge'
import { BRIDGE_OPS } from '../shared/plugin-bridge-ops'

const quiet = { warn: () => {} }
const REC = 'program_plan-abc123'

test('only bridge 1\'s ops with exactly their keys are read; anything else is refused with a reason', () => {
  // The server's ops (B6) and the core screen's ui.open; nothing else.
  assert.deepEqual([...BRIDGE_OPS].sort(), [...PLUGIN_BRIDGE_OPS, 'ui.open'].sort())
  const ok = (op: string, args: unknown) => parseBridgeMessage({ id: 1, op, args })
  assert.equal(ok('records.query', { type: 'program_plan', state: ['open'], limit: 20 }).ok, true)
  assert.equal(ok('records.get', { recordId: REC }).ok, true)
  assert.equal(ok('records.act', { recordId: REC, action: 'choose', expectedVersion: 3, args: { note_text: 'a' } }).ok, true)
  assert.equal(ok('approvals.request', { operation: 'update_plan', recordId: REC, input: { expectedVersion: 1, fields: {} } }).ok, true)
  assert.equal(ok('approvals.request', { operation: 'create_plan', recordId: null, input: {} }).ok, true)
  assert.equal(ok('ui.open', { target: 'file', path: '企画/構成.md' }).ok, true)

  const refused = (data: unknown) => { const r = parseBridgeMessage(data); assert.equal(r.ok, false, JSON.stringify(data)); return r as Extract<typeof r, { ok: false }> }
  // Approving, sending, files, network, settings: not bridge operations.
  for (const op of ['approvals.approve', 'outbound.send', 'fs.read', 'net.fetch', 'settings.get', 'records.delete', 'deliverables.read', '__proto__', 'toString']) {
    assert.equal(refused({ id: 'a', op, args: {} }).code, 'UNKNOWN_OP', op)
  }
  // The plugin cannot speak for the person or the AI, attach files or claim a decision's basis.
  for (const extra of [{ actor: { kind: 'ai' } }, { proposedBy: 'ai' }, { attachments: [] }, { via: 'screen' }, { conversationId: 'x' }]) {
    assert.equal(refused({ id: 2, op: 'records.act', args: { recordId: REC, action: 'choose', expectedVersion: 1, ...extra } }).code, 'BAD_REQUEST')
  }
  // The plugin cannot name itself either.
  assert.equal(refused({ id: 3, op: 'records.get', args: { recordId: REC }, plugin: 'other' }).code, 'BAD_REQUEST')
  assert.equal(refused({ id: 4, op: 'records.get', args: { recordId: '../x' } }).code, 'BAD_REQUEST')
  assert.equal(refused({ id: 5, op: 'records.query', args: { state: ['open'] } }).code, 'BAD_REQUEST')
  assert.equal(refused({ id: 6, op: 'approvals.request', args: { operation: 'update_plan', recordId: REC } }).code, 'BAD_REQUEST')
  assert.equal(refused({ id: 9, op: 'ui.open', args: { target: 'file', path: '../.env' } }).code, 'BAD_REQUEST')
  assert.equal(refused({ id: 7, op: 'ui.open', args: { target: 'url', url: 'https://example.com' } }).code, 'BAD_REQUEST')
  assert.equal(refused({ id: 8, op: 'records.query', args: { text: 'x'.repeat(70_000) } }).code, 'BAD_REQUEST')
  // No usable id: no answer at all.
  for (const bad of [null, [], 'x', { op: 'records.get' }, { id: {}, op: 'records.get' }, { id: 'a b', op: 'records.get' }]) assert.equal(refused(bad).id, null)
})

function bridge(answer: { status: number; body: unknown } | 'down', kept = true) {
  const sent: Array<{ url: string; init: RequestInit }> = []
  const api = createPluginBridgeApi({
    baseUrl: () => 'https://acb.example',
    cookies: () => ['session=s1'],
    keeps: (id, version, companyId) => kept && id === 'planning' && version === '0.1.0' && companyId === 'c1',
    isMainWindow: () => true,
    log: quiet,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      if (answer === 'down') throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch,
  })
  return { api, sent }
}

test('main sends B6\'s request with the session and the plugin of the frame the app created', async () => {
  const b = bridge({ status: 200, body: { success: true, data: { total: 0, records: [] } } })
  const answer = await b.api.call('c1', { id: 'planning', version: '0.1.0' }, 'records.query', { type: 'program_plan' })
  assert.deepEqual(answer, { ok: true, data: { total: 0, records: [] } })
  assert.equal(b.sent.length, 1)
  assert.equal(b.sent[0].url, 'https://acb.example/api/companies/c1/plugin-bridge')
  assert.equal((b.sent[0].init.headers as Record<string, string>).Cookie, 'session=s1')
  assert.deepEqual(JSON.parse(String(b.sent[0].init.body)), { pluginId: 'planning', version: '0.1.0', op: 'records.query', args: { type: 'program_plan' } })
})

test('main refuses before the server: a package the company does not list, an unknown op, ui.open, bad arguments', async () => {
  const notKept = bridge({ status: 200, body: {} }, false)
  assert.equal(((await notKept.api.call('c1', { id: 'planning', version: '0.1.0' }, 'records.get', { recordId: REC })) as { error: { code: string } }).error.code, 'NOT_AVAILABLE')
  const b = bridge({ status: 200, body: {} })
  assert.equal(((await b.api.call('c2', { id: 'planning', version: '0.1.0' }, 'records.get', { recordId: REC })) as { error: { code: string } }).error.code, 'NOT_AVAILABLE')
  assert.equal(((await b.api.call('c1', { id: 'planning', version: '0.1.0' }, 'approvals.approve', {})) as { error: { code: string } }).error.code, 'UNKNOWN_OP')
  assert.equal(((await b.api.call('c1', { id: 'planning', version: '0.1.0' }, 'ui.open', { target: 'record', recordId: REC })) as { error: { code: string } }).error.code, 'UNKNOWN_OP')
  assert.equal(((await b.api.call('c1', { id: 'planning', version: '0.1.0' }, 'records.act', { recordId: REC })) as { error: { code: string } }).error.code, 'BAD_REQUEST')
  assert.equal(((await b.api.call('../c1', { id: 'planning', version: '0.1.0' }, 'records.get', { recordId: REC })) as { error: { code: string } }).error.code, 'BAD_REQUEST')
  assert.equal(b.sent.length + notKept.sent.length, 0)
})

test('the server\'s refusal reaches the frame as its code and words; a server down is 「つながっていません」', async () => {
  const refused = bridge({ status: 403, body: PLUGIN_BRIDGE_REFUSED })
  assert.deepEqual(await refused.api.call('c1', { id: 'planning', version: '0.1.0' }, 'records.get', { recordId: REC }), { ok: false, error: { code: 'PLUGIN_BRIDGE_REFUSED', message: PLUGIN_BRIDGE_REFUSED.error } })
  const down = bridge('down')
  const answer = await down.api.call('c1', { id: 'planning', version: '0.1.0' }, 'records.get', { recordId: REC })
  assert.equal(answer.ok, false)
  assert.equal((answer as { error: { code: string } }).error.code, 'OFFLINE')
})

test('a frame showing a plugin\'s page navigates nowhere; only the app\'s own frame loads one', () => {
  const page = 'acb-plugin://planning/0.1.0/ui/index.html'
  assert.equal(pluginFrameNavigationAllowed('', page), true)
  assert.equal(pluginFrameNavigationAllowed('about:blank', page), true)
  assert.equal(pluginFrameNavigationAllowed('', 'acb-plugin://planning/0.1.0/plugin.yaml'), false)
  for (const target of ['acb-plugin://planning/0.1.0/ui/other.html', 'acb-plugin://other/1.0.0/ui/index.html', 'https://example.com/', 'file:///etc/passwd', 'about:blank']) {
    assert.equal(pluginFrameNavigationAllowed(page, target), false, target)
  }
  // Other frames (the PDF preview) are not this rule's.
  assert.equal(pluginFrameNavigationAllowed('blob:file:///x', 'blob:file:///y'), true)
})
