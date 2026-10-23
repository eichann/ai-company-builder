// The IPC surface between the renderer and the main process, as data
// (tests/ipc-contract.test.ts compares it with ipc-inventory.json).
//
//  - main: every ipcMain.handle / ipcMain.on channel, with the handler's
//    parameters as written (TypeScript AST of the files that import
//    electron), and every channel the main process sends to the window.
//  - preload: every function preload.ts exposes as window.electronAPI, the
//    IPC call(s) it makes when called (found by calling it against the fake
//    ipcRenderer: method, channel, which of its arguments are forwarded) and
//    its declared type (the `declare global` block).
//  - unmatched: the cross-checks — handlers no preload function calls, sends
//    nobody listens to, preload functions the renderer (src/) never calls.
//    These are the dead-code candidates; they are reported, not enforced.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as electronFake from './fake-electron.ts'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** Main-process files that talk to Electron's IPC directly. */
export const MAIN_IPC_FILES = ['electron/main.ts', 'electron/voice-input.ts']

export interface MainChannel { file: string; params: string }

export interface Inventory {
  main: {
    handle: Record<string, MainChannel>
    on: Record<string, MainChannel>
    /** Channel (template literals as written) → files sending it. */
    send: Record<string, string[]>
  }
  preload: Record<string, { calls: string[]; declared: string | null }>
  unmatched: {
    handlersWithoutPreloadCaller: string[]
    preloadCallsWithoutHandler: string[]
    sendsWithoutPreloadListener: string[]
    preloadListenersWithoutSender: string[]
    exposedButNotDeclared: string[]
    declaredButNotExposed: string[]
    preloadApiUnusedByRenderer: string[]
  }
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

function parse(rel: string): ts.SourceFile {
  const file = path.join(CLIENT, rel)
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true)
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1)
  return null
}

/** ipcMain.handle / ipcMain.on registrations and .send(<literal>) calls, from source. */
export function staticMainChannels(): Inventory['main'] {
  const out: Inventory['main'] = { handle: {}, on: {}, send: {} }
  for (const rel of MAIN_IPC_FILES) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text
        const target = node.expression.expression.getText()
        const channel = literalText(node.arguments[0])
        if (target === 'ipcMain' && (name === 'handle' || name === 'on') && channel !== null) {
          const fn = node.arguments[1]
          const params = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
            ? fn.parameters.slice(1).map(p => squash(p.getText())).join(', ')
            : `<${fn ? squash(fn.getText()) : ''}>`
          out[name][channel] = { file: path.basename(rel), params }
        }
        if (name === 'send' && channel !== null) {
          const files = out.send[channel] ?? []
          if (!files.includes(path.basename(rel))) files.push(path.basename(rel))
          out.send[channel] = files
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parse(rel))
  }
  return out
}

/** Members of `interface Window { electronAPI: {...} }` in preload.ts: dotted name → type text. */
function declaredPreloadApi(): Record<string, string> {
  const out: Record<string, string> = {}
  const walkType = (prefix: string, type: ts.TypeNode | undefined) => {
    if (!type || !ts.isTypeLiteralNode(type)) return
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue
      const name = prefix + member.name.getText()
      out[name] = squash(member.type?.getText() ?? '')
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Window') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name.getText() === 'electronAPI') walkType('', member.type)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse('electron/preload.ts'))
  return out
}

/** Load preload.ts against the fake contextBridge / ipcRenderer and call every exposed function. */
export async function exercisePreload(): Promise<Record<string, string[]>> {
  const realRequire = createRequire(path.join(CLIENT, 'electron/preload.ts'))
  // preload.ts is CommonJS in the app (`require('electron')`); give it one.
  ;(globalThis as { require?: unknown }).require = (id: string) => (id === 'electron' ? electronFake : realRequire(id))
  await import('../../electron/preload.ts')
  const api = electronFake.renderer.exposed.electronAPI as Record<string, unknown>
  const out: Record<string, string[]> = {}
  const describe = (value: unknown, sentinels: string[]): string => {
    const i = sentinels.indexOf(value as string)
    if (i >= 0) return `$${i}`
    if (typeof value === 'function') return '<fn>'
    return JSON.stringify(value) ?? 'undefined'
  }
  const exercise = (prefix: string, obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      const name = prefix + key
      if (value && typeof value === 'object') { exercise(`${name}.`, value as Record<string, unknown>); continue }
      if (typeof value !== 'function') { out[name] = [`<${typeof value}>`]; continue }
      const sentinels = Array.from({ length: value.length }, (_, i) => `<arg${i}>`)
      // Subscriptions take a callback first; their result is the unsubscribe.
      const args = key.startsWith('on') ? [() => {}] : sentinels
      electronFake.renderer.calls.length = 0
      let result: unknown
      try { result = (value as (...a: unknown[]) => unknown)(...args) } catch (error) { result = error }
      if (typeof result === 'function' && key.startsWith('on')) (result as () => void)()
      out[name] = electronFake.renderer.calls.map(c => `${c.method} ${c.channel}(${c.args.map(a => describe(a, sentinels)).join(', ')})`)
    }
  }
  exercise('', api)
  return out
}

/** Names the renderer calls on window.electronAPI (or an alias of it), voiceInput's as `voiceInput.x`. */
function rendererUses(): Set<string> {
  const used = new Set<string>()
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(p)
    }
  }
  walk(path.join(CLIENT, 'src'))
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8')
    const aliases = ['electronAPI', ...[...text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*window\.electronAPI\b/g)].map(m => m[1])]
    for (const alias of aliases) {
      for (const m of text.matchAll(new RegExp(`\\b${alias}[?!]?\\.(?:(voiceInput)[?!]?\\.)?(\\w+)`, 'g'))) {
        used.add(m[1] ? `voiceInput.${m[2]}` : m[2])
        if (m[1]) used.add('voiceInput')
      }
    }
  }
  return used
}

const sorted = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))

/** Channel pattern as written (`agent-interaction:${event}`) → matcher. */
function channelMatcher(pattern: string): RegExp {
  return new RegExp(`^${pattern.split(/\$\{[^}]+\}/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^:]+')}$`)
}

export async function buildInventory(registered: { handle: string[]; on: string[] }): Promise<Inventory> {
  const main = staticMainChannels()
  // The AST is the source of the parameter text; the running app is the
  // authority on what is registered. They must agree, or the parse missed one.
  const missing = [
    ...registered.handle.filter(c => !main.handle[c]).map(c => `handle ${c}`),
    ...registered.on.filter(c => !main.on[c]).map(c => `on ${c}`),
    ...Object.keys(main.handle).filter(c => !registered.handle.includes(c)).map(c => `handle ${c} (in source, not registered)`),
    ...Object.keys(main.on).filter(c => !registered.on.includes(c)).map(c => `on ${c} (in source, not registered)`),
  ]
  if (missing.length > 0) throw new Error(`Static and runtime IPC registrations differ:\n${missing.join('\n')}`)

  const calls = await exercisePreload()
  const declared = declaredPreloadApi()
  const preload: Inventory['preload'] = {}
  for (const name of Object.keys(calls)) preload[name] = { calls: calls[name], declared: declared[name] ?? null }

  const parsedCalls = Object.values(calls).flat().map(c => { const [method, rest] = c.split(' '); return { method, channel: rest.slice(0, rest.indexOf('(')) } })
  const invoked = new Set(parsedCalls.filter(c => c.method === 'invoke').map(c => c.channel))
  const sentToMain = new Set(parsedCalls.filter(c => c.method === 'send' || c.method === 'sendSync').map(c => c.channel))
  const listened = new Set(parsedCalls.filter(c => c.method === 'on').map(c => c.channel))
  const sendMatchers = Object.keys(main.send).map(p => ({ p, re: channelMatcher(p) }))
  const used = rendererUses()

  return {
    main: { handle: sorted(main.handle), on: sorted(main.on), send: sorted(main.send) },
    preload: sorted(preload),
    unmatched: {
      handlersWithoutPreloadCaller: Object.keys(main.handle).filter(c => !invoked.has(c)).sort(),
      preloadCallsWithoutHandler: [
        ...[...invoked].filter(c => !main.handle[c]),
        ...[...sentToMain].filter(c => !main.on[c]),
      ].sort(),
      sendsWithoutPreloadListener: Object.keys(main.send).filter(p => ![...listened].some(c => channelMatcher(p).test(c))).sort(),
      preloadListenersWithoutSender: [...listened].filter(c => !sendMatchers.some(m => m.re.test(c))).sort(),
      // A nested object (voiceInput) is declared by its type name as a whole.
      exposedButNotDeclared: Object.keys(calls).filter(n => !(n in declared) && !(n.split('.')[0] in declared)).sort(),
      declaredButNotExposed: Object.keys(declared).filter(n => !(n in calls) && !Object.keys(calls).some(k => k.startsWith(`${n}.`))).sort(),
      preloadApiUnusedByRenderer: Object.keys(calls).filter(n => !used.has(n)).sort(),
    },
  }
}
