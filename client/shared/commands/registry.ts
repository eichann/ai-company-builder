/**
 * Runs commands by name: callers know an id and its arguments, never who
 * handles it. Handlers register where they run (the renderer today; the main
 * process later with its own registry over the same catalog). Pure: the
 * renderer wires it to the DOM in src/shared/commands/.
 * Rules: .claude/rules/commands.md.
 */
import type { z } from 'zod'
import { matchesKey, parseKey, type CommandArea, type CommandCatalog, type CommandDefinition, type KeyInput } from './define'

export type CommandId<C extends CommandCatalog> = keyof C & string
/** What a caller passes (defaults not yet applied). */
export type CommandArgs<C extends CommandCatalog, I extends CommandId<C>> = z.input<C[I]['args']>
/** What a handler receives (checked, defaults applied). */
export type CommandHandlerArgs<C extends CommandCatalog, I extends CommandId<C>> = z.output<C[I]['args']>

export interface CommandContext {
  /** A shortcut pressed in the handler's area, or a call. */
  readonly source: 'call' | 'keybinding'
  /** The instance that runs it (a chat pane), for commands with a target. */
  readonly target?: string
}

export type CommandHandler<A> = (args: A, context: CommandContext) => unknown

export interface RegisterOptions {
  /** Which instance of the command's target area this handler is (a chat pane id). */
  readonly target?: string
  /** Asked when the command's shortcut is pressed: false lets the key through untouched. */
  readonly acceptsKey?: () => boolean
}

/** One focusable area around the focus, innermost first; the chain ends with `app`. */
export interface FocusScope {
  readonly area: CommandArea
  readonly target?: string
}

export type CommandErrorCode = 'unknown-command' | 'invalid-args' | 'no-handler' | 'duplicate-handler'

export class CommandError extends Error {
  constructor(readonly code: CommandErrorCode, readonly commandId: string, message: string) {
    super(message)
    this.name = 'CommandError'
  }
}

/** Args may be left out when the command takes none that are required. */
type ArgsParam<A> = Record<never, never> extends A ? [args?: A] : [args: A]

interface Entry {
  readonly handler: CommandHandler<unknown>
  readonly acceptsKey?: () => boolean
}

const NO_TARGET = ''

export interface CommandRegistry<C extends CommandCatalog> {
  readonly catalog: C
  /** Adds a handler; returns the function that removes it. Throws on a second handler for the same command and target. */
  register<I extends CommandId<C>>(id: I, handler: CommandHandler<CommandHandlerArgs<C, I>>, options?: RegisterOptions): () => void
  /** Checks the arguments and runs the command. Rejects with a CommandError (unknown id, bad arguments, nobody handles it). */
  run<I extends CommandId<C>>(id: I, ...args: ArgsParam<CommandArgs<C, I>>): Promise<unknown>
  /** Whether running it now would reach a handler (a target, when given, must be that one). */
  has(id: CommandId<C>, target?: string): boolean
  /** The instance of an area the member used last: where a command without a target argument goes. */
  setActiveTarget(area: CommandArea, target: string): void
  /**
   * A key pressed with the focus inside `chain` (innermost first). Runs the
   * one command whose shortcut matches in the innermost area that has a
   * handler for the focused instance; true when it ran (the caller then
   * stops the key's default action).
   */
  handleKey(input: KeyInput, chain: readonly FocusScope[]): boolean
  /** Called whenever handlers come or go (for `has` in a UI). */
  subscribe(listener: () => void): () => void
}

export function createCommandRegistry<C extends CommandCatalog>(
  catalog: C,
  { onError }: { onError?: (error: unknown, id: string) => void } = {},
): CommandRegistry<C> {
  const handlers = new Map<string, Map<string, Entry>>()
  const activeTargets = new Map<CommandArea, string>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const l of [...listeners]) l() }

  const definitionOf = (id: string): CommandDefinition | undefined =>
    Object.prototype.hasOwnProperty.call(catalog, id) ? (catalog as Record<string, CommandDefinition>)[id] : undefined

  const shortcuts = Object.values(catalog as Record<string, CommandDefinition>)
    .filter(def => def.keybinding)
    .map(def => ({ def, area: def.keybinding!.area, key: parseKey(def.keybinding!.key)! }))

  /** The handler a call reaches: the asked-for target, else the one used last, else the first registered. */
  function resolve(def: CommandDefinition, requested: string | undefined): [string, Entry] | undefined {
    const forId = handlers.get(def.id)
    if (!forId || forId.size === 0) return undefined
    if (!def.target) return forId.has(NO_TARGET) ? [NO_TARGET, forId.get(NO_TARGET)!] : undefined
    if (requested !== undefined) return forId.has(requested) ? [requested, forId.get(requested)!] : undefined
    const active = activeTargets.get(def.target.area)
    if (active !== undefined && forId.has(active)) return [active, forId.get(active)!]
    return forId.entries().next().value
  }

  function invoke(entry: Entry, args: unknown, context: CommandContext): Promise<unknown> {
    try {
      return Promise.resolve(entry.handler(args, context))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  return {
    catalog,

    register(id, handler, options = {}) {
      const def = definitionOf(id)
      if (!def) throw new CommandError('unknown-command', id, `No command "${id}" in the catalog`)
      if (def.target && options.target === undefined) throw new CommandError('no-handler', id, `Command "${id}" acts on a ${def.target.area}: register it with a target`)
      if (!def.target && options.target !== undefined) throw new CommandError('no-handler', id, `Command "${id}" has no target`)
      const target = options.target ?? NO_TARGET
      let forId = handlers.get(id)
      if (!forId) handlers.set(id, forId = new Map())
      if (forId.has(target)) throw new CommandError('duplicate-handler', id, `Command "${id}" already has a handler${target ? ` for ${target}` : ''}`)
      const entry: Entry = { handler: handler as CommandHandler<unknown>, acceptsKey: options.acceptsKey }
      forId.set(target, entry)
      notify()
      return () => {
        if (forId.get(target) !== entry) return
        forId.delete(target)
        notify()
      }
    },

    async run(id, ...rest) {
      const def = definitionOf(id)
      if (!def) throw new CommandError('unknown-command', id, `No command "${id}" in the catalog`)
      const parsed = def.args.safeParse(rest[0] ?? {})
      if (!parsed.success) throw new CommandError('invalid-args', id, `Command "${id}": invalid arguments`)
      const args = parsed.data as Record<string, unknown>
      const requested = def.target ? args[def.target.arg] as string | undefined : undefined
      const found = resolve(def, requested)
      if (!found) throw new CommandError('no-handler', id, `Nothing handles "${id}" now`)
      const [target, entry] = found
      return invoke(entry, args, { source: 'call', target: target || undefined })
    },

    has(id, target) {
      const def = definitionOf(id)
      if (!def) return false
      return resolve(def, def.target ? target : undefined) !== undefined
    },

    setActiveTarget(area, target) {
      activeTargets.set(area, target)
    },

    handleKey(input, chain) {
      for (const scope of chain) {
        for (const { def, area, key } of shortcuts) {
          if (area !== scope.area || !matchesKey(key, input)) continue
          // The focused instance only: a key never reaches a pane the member is not in.
          const target = def.target ? scope.target : NO_TARGET
          if (target === undefined) continue
          const entry = handlers.get(def.id)?.get(target)
          if (!entry || (entry.acceptsKey && !entry.acceptsKey())) continue
          const args = def.target ? { [def.target.arg]: target } : {}
          const parsed = def.args.safeParse(args)
          if (!parsed.success) continue
          invoke(entry, parsed.data, { source: 'keybinding', target: target || undefined })
            .catch(error => onError?.(error, def.id))
          return true
        }
      }
      return false
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
