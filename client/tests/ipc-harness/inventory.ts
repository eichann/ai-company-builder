// The IPC surface between the renderer and the main process, as data
// (tests/ipc-contract.test.ts compares it, as inventoryLines(), with
// ipc-inventory.txt).
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
/** The IPC contract: channel types and window.electronAPI (ElectronAPI). */
export const CONTRACT_FILE = 'shared/ipc-contract.ts'

/**
 * Main-process files that register IPC handlers or send to the window:
 * main.ts, voice-input.ts and every module under electron/features/.
 */
export function mainIpcFiles(): string[] {
  const files = ['electron/main.ts', 'electron/voice-input.ts']
  const walk = (rel: string) => {
    const dir = path.join(CLIENT, rel)
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(child)
    }
  }
  walk('electron/features')
  return files
}
/** Variables holding the main process's IPC (Electron's, or the typed registrar). */
const IPC_TARGETS = new Set(['ipcMain', 'ipc'])

export interface MainChannel { file: string; params: string }

export interface Inventory {
  main: {
    handle: Record<string, MainChannel>
    on: Record<string, MainChannel>
    /** Channel (template literals as written) → files sending it. */
    send: Record<string, string[]>
  }
  preload: Record<string, { calls: string[]; declared: string | null }>
  /**
   * shared/ipc-contract.ts: the channels it lists per kind, and every type it
   * exports as written (a change to a payload's shape shows up here). An
   * interface is recorded per member (`Name.member`, plus `Name` for its
   * heading), so two branches adding different channels change different
   * entries instead of the same long line.
   */
  contract: {
    channels: ContractChannels
    types: Record<string, string>
  }
  unmatched: {
    handlersWithoutPreloadCaller: string[]
    preloadCallsWithoutHandler: string[]
    sendsWithoutPreloadListener: string[]
    preloadListenersWithoutSender: string[]
    exposedButNotDeclared: string[]
    declaredButNotExposed: string[]
    preloadApiUnusedByRenderer: string[]
    /** Channels the running app uses but the contract does not list, or the other way round. */
    notInContract: string[]
    inContractButUnused: string[]
  }
}

export interface ContractChannels { invoke: string[]; send: string[]; sync: string[]; events: string[] }

/** The channel names (members) of the contract's channel interfaces, and its exported types' text. */
export function contractFromSource(): Inventory['contract'] {
  const source = parse(CONTRACT_FILE)
  const kinds: Record<string, keyof ContractChannels> = {
    IpcInvokeChannels: 'invoke', IpcSendChannels: 'send', IpcSyncChannels: 'sync', IpcEventChannels: 'events',
  }
  const channels: ContractChannels = { invoke: [], send: [], sync: [], events: [] }
  const types: Record<string, string> = {}
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue
    const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    const name = statement.name.text
    if (ts.isInterfaceDeclaration(statement)) {
      // The heading (`export interface X extends Y {`) and each member on its own.
      types[name] = `${squash(withoutComments(source.text.slice(statement.getStart(), statement.members.pos)))} }`
      for (const member of statement.members) {
        const text = squash(withoutComments(member.getText())).replace(/[;,]$/, '')
        types[`${name}.${member.name ? squash(member.name.getText()) : text}`] = text
      }
    } else {
      types[name] = squash(withoutComments(statement.getText()))
    }
    const kind = kinds[statement.name.text]
    if (kind && ts.isInterfaceDeclaration(statement)) {
      for (const member of statement.members) {
        const name = member.name && literalText(member.name)
        if (name) channels[kind].push(name)
      }
    }
  }
  for (const list of Object.values(channels)) list.sort()
  return { channels, types: sorted(types) }
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
// Comments inside a declaration are not part of its shape.
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

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
  for (const rel of mainIpcFiles()) {
    const where = path.relative('electron', rel)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text
        const target = node.expression.expression.getText()
        const channel = literalText(node.arguments[0])
        if (IPC_TARGETS.has(target) && (name === 'handle' || name === 'on') && channel !== null) {
          const fn = node.arguments[1]
          const params = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
            ? fn.parameters.slice(1).map(p => squash(p.getText())).join(', ')
            : `<${fn ? squash(fn.getText()) : ''}>`
          out[name][channel] = { file: where, params }
        }
        if (name === 'send' && channel !== null) {
          const files = out.send[channel] ?? []
          if (!files.includes(where)) files.push(where)
          out.send[channel] = files
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parse(rel))
  }
  return out
}

/**
 * Members of `ElectronAPI` (shared/ipc-contract.ts, what preload.ts implements
 * and src/shared/ipc/electron-api.ts declares as `Window['electronAPI']`): dotted name → the member's type as the
 * compiler resolves it (contract aliases expanded into parameters and
 * result), so a change to a channel's types shows up here.
 */
function declaredPreloadApi(): Record<string, string> {
  const file = path.join(CLIENT, CONTRACT_FILE)
  const program = ts.createProgram([file], {
    strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  })
  const checker = program.getTypeChecker()
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(file)!)!
  const apiSymbol = checker.getExportsOfModule(moduleSymbol).find(s => s.name === 'ElectronAPI')
  if (!apiSymbol) throw new Error(`${CONTRACT_FILE} exports no ElectronAPI`)
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature
  const out: Record<string, string> = {}
  const walk = (prefix: string, type: ts.Type) => {
    for (const member of type.getProperties()) {
      const memberType = checker.getTypeOfSymbol(member)
      const signatures = memberType.getCallSignatures()
      const name = prefix + member.name
      out[name] = squash(signatures.length === 1
        ? checker.signatureToString(signatures[0], undefined, flags)
        : checker.typeToString(memberType, undefined, flags))
      // A nested API object (voiceInput): its methods too.
      if (signatures.length === 0 && memberType.getProperties().length > 0) walk(`${name}.`, memberType)
    }
  }
  walk('', checker.getDeclaredTypeOfSymbol(apiSymbol))
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
    // A data-access module's port (src/shared/ipc/electron-api.ts) names the methods it calls.
    for (const m of text.matchAll(/\bElectronPort<([^>]+)>/g)) {
      for (const name of m[1].matchAll(/'(\w+)'/g)) used.add(name[1])
    }
    for (const m of text.matchAll(/\bVoiceInputPort<([^>]+)>/g)) {
      used.add('voiceInput')
      for (const name of m[1].matchAll(/'(\w+)'/g)) used.add(`voiceInput.${name[1]}`)
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
  const contract = contractFromSource()
  // What the running app uses, per contract kind: handlers (+ the preload's
  // invokes), ipcMain.on listeners (+ the preload's send / sendSync), and the
  // events the preload listens to (each a channel main sends, see below).
  const usedByKind = {
    invoke: new Set([...Object.keys(main.handle), ...invoked]),
    message: new Set([...Object.keys(main.on), ...sentToMain]),
    events: listened,
  }
  const contractMessages = new Set([...contract.channels.send, ...contract.channels.sync])

  return {
    main: { handle: sorted(main.handle), on: sorted(main.on), send: sorted(main.send) },
    preload: sorted(preload),
    contract,
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
      notInContract: [
        ...[...usedByKind.invoke].filter(c => !contract.channels.invoke.includes(c)).map(c => `invoke ${c}`),
        ...[...usedByKind.message].filter(c => !contractMessages.has(c)).map(c => `send/sendSync ${c}`),
        ...[...usedByKind.events].filter(c => !contract.channels.events.includes(c)).map(c => `event ${c}`),
        ...Object.keys(main.send).filter(p => !contract.channels.events.some(c => channelMatcher(p).test(c))).map(c => `event ${c} (sent by main)`),
      ].sort(),
      inContractButUnused: [
        ...contract.channels.invoke.filter(c => !main.handle[c] || !invoked.has(c)).map(c => `invoke ${c}`),
        ...[...contractMessages].filter(c => !main.on[c] || !sentToMain.has(c)).map(c => `send/sendSync ${c}`),
        ...contract.channels.events.filter(c => !listened.has(c) || !sendMatchers.some(m => m.re.test(c))).map(c => `event ${c}`),
      ].sort(),
    },
  }
}

/**
 * The inventory as one fact per line, sorted (code-unit order, not the
 * locale's). Each line stands alone — no counts, no line numbers, nothing
 * derived from other entries — so two branches that each add a channel change
 * different lines, git merges them, and the merged file is what regenerating
 * on the merged code writes.
 */
export function inventoryLines(inventory: Inventory): string[] {
  const lines: string[] = []
  for (const kind of ['handle', 'on'] as const) {
    for (const [channel, c] of Object.entries(inventory.main[kind])) lines.push(`main.${kind} ${channel} @ ${c.file} (${c.params})`)
  }
  for (const [channel, files] of Object.entries(inventory.main.send)) {
    for (const file of files) lines.push(`main.send ${channel} @ ${file}`)
  }
  for (const [name, p] of Object.entries(inventory.preload)) {
    lines.push(`preload ${name} -> ${p.calls.length > 0 ? p.calls.join(' ; ') : '(no IPC)'}`)
    lines.push(`preload ${name} : ${p.declared ?? '(not declared)'}`)
  }
  for (const [kind, channels] of Object.entries(inventory.contract.channels)) {
    for (const channel of channels) lines.push(`contract.${kind} ${channel}`)
  }
  for (const [name, text] of Object.entries(inventory.contract.types)) lines.push(`contract.type ${name} = ${text}`)
  for (const [list, items] of Object.entries(inventory.unmatched)) {
    for (const item of items) lines.push(`unmatched.${list} ${item}`)
  }
  const bad = lines.find(line => /[\r\n]/.test(line))
  if (bad) throw new Error(`Inventory entry spans lines: ${bad.slice(0, 80)}`)
  return lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
