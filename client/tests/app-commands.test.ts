// The app's commands handed to the consultation AI (commands.md "Handed to the AI"): exactly the
// three tab commands, view / local only, run only in the main window and answered only by it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { aiCommands, APP_COMMAND_MESSAGES, appCommandRefusal, appCommandToolName, PRIVATE_TAB_TITLE, redactForAI } from '../shared/app-commands'
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
  const sent: Array<{ requestId: string; companyId: string; commandId: string; args: unknown }> = []
  const runner = registerAppCommandsIpc(ipc, {
    mainWindowId: () => options.mainId ?? 7,
    mainWindow: { send: ((_channel: string, request: { requestId: string; companyId: string; commandId: string; args: unknown }) => { sent.push(request) }) as never },
    inOwnWindow: () => !!options.ownWindow,
    timeoutMs: options.timeoutMs ?? 1000,
  })
  const respond = (senderId: number, requestId: string, answer: unknown) => handlers.get('appCommand:respond')!({ sender: { id: senderId } }, requestId, answer)
  return { runner, sent, respond }
}

test('only the main window that was asked can answer the AI\'s command', async () => {
  const h = harness()
  const answer = h.runner.run('s1', 'co', 'tabs.list', {})
  assert.equal(h.sent.length, 1)
  h.respond(99, h.sent[0].requestId, { ok: true, result: 'forged' })
  h.respond(7, h.sent[0].requestId, { ok: true, result: { openTabs: [] } })
  assert.deepEqual(await answer, { ok: true, result: { openTabs: [] } })
})

test('a command not handed to the AI, bad arguments or a consultation in its own window never reach a window', async () => {
  const h = harness()
  assert.deepEqual(await h.runner.run('s1', 'co', 'chat.newConsultation', { message: 'x' }), { ok: false, error: APP_COMMAND_MESSAGES.unknown })
  assert.deepEqual(await h.runner.run('s1', 'co', 'tabs.restore', { group: '昨日' }), { ok: false, error: APP_COMMAND_MESSAGES.badArgs })
  const own = harness({ ownWindow: true })
  assert.deepEqual(await own.runner.run('s1', 'co', 'tabs.tidy', {}), { ok: false, error: APP_COMMAND_MESSAGES.ownWindow })
  assert.equal(h.sent.length + own.sent.length, 0)
})

test('a window that does not answer lets the AI go on with a message', async () => {
  const h = harness({ timeoutMs: 20 })
  assert.deepEqual(await h.runner.run('s1', 'co', 'tabs.tidy', {}), { ok: false, error: APP_COMMAND_MESSAGES.timeout })
})

test('the AI of one company never acts on another company\'s tabs', async () => {
  const h = harness()
  void h.runner.run('s1', 'co-a', 'tabs.tidy', {})
  // The request names the consultation's company; the window refuses when another one is on screen.
  assert.equal(h.sent[0].companyId, 'co-a')
  assert.equal(appCommandRefusal(h.sent[0], 'co-b'), APP_COMMAND_MESSAGES.otherCompany)
  assert.equal(appCommandRefusal(h.sent[0], null), APP_COMMAND_MESSAGES.otherCompany)
  assert.equal(appCommandRefusal(h.sent[0], 'co-a'), null)
  assert.equal(appCommandRefusal({ commandId: 'chat.newConsultation', companyId: 'co-a' }, 'co-a'), APP_COMMAND_MESSAGES.unknown)
  // A consultation without a company never reaches the window.
  assert.deepEqual(await h.runner.run('s1', '', 'tabs.list', {}), { ok: false, error: APP_COMMAND_MESSAGES.otherCompany })
  assert.equal(h.sent.length, 1)
})

test('the AI gets no file paths and no name of a file in a private folder it has not read', async () => {
  const result = { openTabs: [{ title: '給与.xlsx', kind: 'ファイル', path: '人事/非公開/給与.xlsx' }, { title: 'A社.md', kind: 'ファイル', path: '営業/A社.md' }, { title: '見積', kind: 'やること' }],
    keptUnsaved: [{ title: '給与.xlsx', kind: 'ファイル', path: '人事/非公開/給与.xlsx' }] }
  const hidden = (p: string) => p.startsWith('人事/非公開/')
  const out = JSON.stringify(redactForAI(result, hidden))
  assert.ok(!out.includes('給与') && !out.includes('非公開/') && !out.includes('"path"'), out)
  assert.equal((redactForAI(result, hidden) as typeof result).openTabs[0].title, PRIVATE_TAB_TITLE)
  assert.equal((redactForAI(result, hidden) as typeof result).openTabs[1].title, 'A社.md')
  // Through the tool too.
  const tools = createAppCommandTools(async () => ({ ok: true, result }), hidden)
  assert.ok(!(await tools.execute('tabs_list', {})).includes('給与'))
  assert.equal(appCommandToolName('a.b.c'), 'a_b_c')
})
