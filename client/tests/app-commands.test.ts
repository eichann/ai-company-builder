// The app's commands handed to the consultation AI (commands.md "Handed to the AI"): exactly the
// three tab commands, view / local only, run only in the main window and answered only by it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { aiCommands, APP_COMMAND_MESSAGES } from '../shared/app-commands'
import { defineCommands } from '../shared/commands/define'
import { createAppCommandTools } from '../electron/app-commands/tools'
import { registerAppCommandsIpc } from '../electron/features/app-commands/ipc'
import type { IpcRegistrar } from '../electron/ipc/registrar'

test('only tabs.list, tabs.tidy and tabs.restore are handed to the AI, and only as view / local', () => {
  const exposed = aiCommands()
  assert.deepEqual(exposed.map(d => d.id).sort(), ['tabs.list', 'tabs.restore', 'tabs.tidy'])
  assert.ok(exposed.every(d => d.class === 'view' || d.class === 'local'))
  assert.ok(exposed.every(d => (d.aiDescription ?? '').length > 20))
})

test('a catalog that hands an outbound or admin command to the AI, or one without a description, does not load', () => {
  const base = { id: 'x.do', title: 'する', args: z.object({}), exposeToAI: true, aiDescription: 'する。Do it.' } as const
  assert.throws(() => defineCommands([{ ...base, class: 'outbound' }]), /only view and local/)
  assert.throws(() => defineCommands([{ ...base, class: 'admin' }]), /only view and local/)
  assert.throws(() => defineCommands([{ ...base, class: 'local', aiDescription: ' ' }]), /needs an aiDescription/)
  assert.doesNotThrow(() => defineCommands([{ ...base, class: 'local' }]))
})

test('the AI\'s tools are the exposed commands by name and relay to the window, nothing else', async () => {
  const ran: Array<[string, unknown]> = []
  const tools = createAppCommandTools(async (id, args) => { ran.push([id, args]); return { ok: true, result: { tidied: 2 } } })
  assert.deepEqual(tools.tools.map(t => t.id).sort(), ['mcp__acb_app__tabs_list', 'mcp__acb_app__tabs_restore', 'mcp__acb_app__tabs_tidy'])
  assert.equal(tools.tools.find(t => t.name === 'tabs_list')?.readOnly, true)
  assert.equal(JSON.parse(await tools.execute('tabs_tidy', {})).tidied, 2)
  assert.match(await tools.execute('chat_newConsultation', { message: 'x' }), /この道具はありません/)
  assert.deepEqual(ran, [['tabs.tidy', {}]])
})

function harness(options: { ownWindow?: boolean; mainId?: number; timeoutMs?: number } = {}) {
  const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, h: never) => { handlers.set(channel, h) }, on: () => {} } as unknown as IpcRegistrar
  const sent: Array<{ requestId: string; commandId: string; args: unknown }> = []
  const runner = registerAppCommandsIpc(ipc, {
    mainWindowId: () => options.mainId ?? 7,
    mainWindow: { send: ((_channel: string, request: { requestId: string; commandId: string; args: unknown }) => { sent.push(request) }) as never },
    inOwnWindow: () => !!options.ownWindow,
    timeoutMs: options.timeoutMs ?? 1000,
  })
  const respond = (senderId: number, requestId: string, answer: unknown) => handlers.get('appCommand:respond')!({ sender: { id: senderId } }, requestId, answer)
  return { runner, sent, respond }
}

test('only the main window that was asked can answer the AI\'s command', async () => {
  const h = harness()
  const answer = h.runner.run('s1', 'tabs.list', {})
  assert.equal(h.sent.length, 1)
  h.respond(99, h.sent[0].requestId, { ok: true, result: 'forged' })
  h.respond(7, h.sent[0].requestId, { ok: true, result: { openTabs: [] } })
  assert.deepEqual(await answer, { ok: true, result: { openTabs: [] } })
})

test('a command not handed to the AI, bad arguments or a consultation in its own window never reach a window', async () => {
  const h = harness()
  assert.deepEqual(await h.runner.run('s1', 'chat.newConsultation', { message: 'x' }), { ok: false, error: APP_COMMAND_MESSAGES.unknown })
  assert.deepEqual(await h.runner.run('s1', 'tabs.restore', { group: '昨日' }), { ok: false, error: APP_COMMAND_MESSAGES.badArgs })
  const own = harness({ ownWindow: true })
  assert.deepEqual(await own.runner.run('s1', 'tabs.tidy', {}), { ok: false, error: APP_COMMAND_MESSAGES.ownWindow })
  assert.equal(h.sent.length + own.sent.length, 0)
})

test('a window that does not answer lets the AI go on with a message', async () => {
  const h = harness({ timeoutMs: 20 })
  assert.deepEqual(await h.runner.run('s1', 'tabs.tidy', {}), { ok: false, error: APP_COMMAND_MESSAGES.timeout })
})
