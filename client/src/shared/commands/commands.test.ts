// The command registry's promises (client/shared/commands/, rules:
// .claude/rules/commands.md). Kept in src/ so `pnpm typecheck` also checks
// the @ts-expect-error lines: a wrong id or argument must not compile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineCommands, type CommandDefinition } from '../../../shared/commands/define'
import { CommandError, createCommandRegistry, type FocusScope } from '../../../shared/commands/registry'
import { COMMANDS } from '../../../shared/commands/catalog'
import { focusChainOf, type AreaElement } from './focus'

const catalog = defineCommands([
  { id: 'file.open', title: 'ファイルを開く', class: 'view', args: z.object({ path: z.string().min(1) }) },
  { id: 'layout.toggleChat', title: 'チャットの表示を切り替える', class: 'view', args: z.object({}), keybinding: { key: 'mod+shift+c', area: 'app' } },
  {
    id: 'chat.insertText', title: '入力欄に文を入れる', class: 'local',
    args: z.object({ text: z.string().optional(), pane: z.string().optional() }),
    target: { arg: 'pane', area: 'chat' },
    keybinding: { key: 'mod+i', area: 'chat' },
  },
])

const key = (spec: { key: string; mod?: boolean; shift?: boolean; alt?: boolean }) =>
  ({ key: spec.key, metaKey: !!spec.mod, ctrlKey: false, shiftKey: !!spec.shift, altKey: !!spec.alt })

async function rejection(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof CommandError, String(error))
    return error
  }
  assert.fail('expected a rejection')
}

test('the app catalog is valid (it would throw at start-up otherwise)', () => {
  assert.equal(typeof COMMANDS, 'object')
})

test('an unknown command id is rejected, at compile time and at run time', async () => {
  const registry = createCommandRegistry(catalog)
  // @ts-expect-error not in the catalog
  const error = await rejection(registry.run('file.delete', { path: '/a' }))
  assert.equal(error.code, 'unknown-command')
  // @ts-expect-error not in the catalog
  assert.throws(() => registry.register('file.delete', () => {}), CommandError)
})

test('wrong arguments are rejected before any handler runs', async () => {
  const registry = createCommandRegistry(catalog)
  const calls: unknown[] = []
  registry.register('file.open', args => { calls.push(args) })
  // @ts-expect-error path must be a string
  assert.equal((await rejection(registry.run('file.open', { path: 3 }))).code, 'invalid-args')
  // @ts-expect-error path is required
  assert.equal((await rejection(registry.run('file.open', {}))).code, 'invalid-args')
  assert.equal((await rejection(registry.run('file.open', { path: '' }))).code, 'invalid-args')
  assert.deepEqual(calls, [])
  await registry.run('file.open', { path: '/会社/a.md' })
  assert.deepEqual(calls, [{ path: '/会社/a.md' }])
})

test('nobody handling a command is a rejection, not a silent no-op', async () => {
  const registry = createCommandRegistry(catalog)
  assert.equal((await rejection(registry.run('layout.toggleChat'))).code, 'no-handler')
  const remove = registry.register('layout.toggleChat', () => {})
  assert.equal(registry.has('layout.toggleChat'), true)
  remove()
  assert.equal(registry.has('layout.toggleChat'), false)
})

test('a catalog with a duplicate id, or a command without a class, does not load', () => {
  const open = { id: 'file.open', title: '開く', class: 'view', args: z.object({}) } as const
  assert.throws(() => defineCommands([open, { ...open, title: 'もう一つ' }]), /defined twice/)
  const classless: Record<string, unknown> = { ...open }
  delete classless.class
  assert.throws(() => defineCommands([classless as unknown as CommandDefinition]), /must declare its class/)
  assert.throws(() => defineCommands([{ ...open, class: 'maybe' } as unknown as CommandDefinition]), /must declare its class/)
  assert.throws(() => defineCommands([{ ...open, id: 'openFile' }]), /area\.verb/)
  assert.throws(() => defineCommands([{ ...open, class: 'never', exposeToAI: true }]), /cannot be handed to the AI/)
})

test('two commands cannot share a shortcut in one area, and a shortcut cannot need arguments', () => {
  const a = { id: 'a.one', title: 'A', class: 'view', args: z.object({}), keybinding: { key: 'mod+p', area: 'app' } } as const
  assert.throws(() => defineCommands([a, { ...a, id: 'a.two' }]), /share the shortcut/)
  assert.throws(() => defineCommands([{ ...a, args: z.object({ path: z.string() }) }]), /required arguments/)
})

test('a second handler for the same command (and pane) is refused', () => {
  const registry = createCommandRegistry(catalog)
  registry.register('file.open', () => {})
  assert.throws(() => registry.register('file.open', () => {}), (e: CommandError) => e.code === 'duplicate-handler')
  registry.register('chat.insertText', () => {}, { target: 'left' })
  assert.throws(() => registry.register('chat.insertText', () => {}, { target: 'left' }), (e: CommandError) => e.code === 'duplicate-handler')
  registry.register('chat.insertText', () => {}, { target: 'right' })
})

/** Two chat panes, each recording what reached it. */
function twoPanes() {
  const registry = createCommandRegistry(catalog)
  const reached: string[] = []
  for (const pane of ['left', 'right']) {
    registry.register('chat.insertText', (args, context) => { reached.push(`${pane}:${context.source}:${args.text ?? ''}`) }, { target: pane })
  }
  return { registry, reached }
}

const inPane = (pane: string): FocusScope[] => [{ area: 'chat', target: pane }, { area: 'app' }]

test('a shortcut reaches only the focused chat pane, never both', async () => {
  const { registry, reached } = twoPanes()
  assert.equal(registry.handleKey(key({ key: 'i', mod: true }), inPane('right')), true)
  await Promise.resolve()
  assert.deepEqual(reached, ['right:keybinding:'])
  // Focus outside every chat pane: the chat's shortcut does nothing (and the key goes through).
  assert.equal(registry.handleKey(key({ key: 'i', mod: true }), [{ area: 'app' }]), false)
  assert.deepEqual(reached, ['right:keybinding:'])
})

test('an app-wide shortcut works from inside an area; other keys and modifiers pass through', async () => {
  const registry = createCommandRegistry(catalog)
  let toggled = 0
  registry.register('layout.toggleChat', () => { toggled++ })
  assert.equal(registry.handleKey(key({ key: 'c', mod: true, shift: true }), inPane('left')), true)
  assert.equal(registry.handleKey(key({ key: 'c', mod: true }), inPane('left')), false)
  assert.equal(registry.handleKey(key({ key: 'c', mod: true, shift: true, alt: true }), inPane('left')), false)
  assert.equal(registry.handleKey(key({ key: 'c', shift: true }), inPane('left')), false)
  await Promise.resolve()
  assert.equal(toggled, 1)
})

test('a handler that declines the key lets it through', () => {
  const registry = createCommandRegistry(catalog)
  let ran = false
  registry.register('layout.toggleChat', () => { ran = true }, { acceptsKey: () => false })
  assert.equal(registry.handleKey(key({ key: 'c', mod: true, shift: true }), [{ area: 'app' }]), false)
  assert.equal(ran, false)
})

test('a call goes to the named pane, else the pane used last; an unknown pane is refused, not redirected', async () => {
  const { registry, reached } = twoPanes()
  await registry.run('chat.insertText', { text: 'a' })
  registry.setActiveTarget('chat', 'right')
  await registry.run('chat.insertText', { text: 'b' })
  await registry.run('chat.insertText', { text: 'c', pane: 'left' })
  assert.deepEqual(reached, ['left:call:a', 'right:call:b', 'left:call:c'])
  assert.equal((await rejection(registry.run('chat.insertText', { text: 'd', pane: 'gone' }))).code, 'no-handler')
  assert.equal(reached.length, 3)
})

test('the focus chain lists the marked areas around the focus, innermost first, then app', () => {
  const el = (attrs: Record<string, string>, parentElement: AreaElement | null): AreaElement =>
    ({ getAttribute: name => attrs[name] ?? null, parentElement })
  const root = el({}, null)
  const pane = el({ 'data-command-area': 'chat', 'data-command-target': 'right' }, root)
  const input = el({}, el({ 'data-command-area': 'unknown' }, pane))
  assert.deepEqual(focusChainOf(input), [{ area: 'chat', target: 'right' }, { area: 'app' }])
  assert.deepEqual(focusChainOf(root), [{ area: 'app' }])
  assert.deepEqual(focusChainOf(null), [{ area: 'app' }])
})
