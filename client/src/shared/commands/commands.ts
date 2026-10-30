import { useEffect, useRef, useSyncExternalStore } from 'react'
import { COMMANDS, type AppCommands } from '../../../shared/commands/catalog'
import type { CommandArea } from '../../../shared/commands/define'
import {
  CommandError, createCommandRegistry,
  type CommandArgs, type CommandHandler, type CommandHandlerArgs, type CommandId, type RegisterOptions,
} from '../../../shared/commands/registry'
import { focusChainOf } from './focus'

// The renderer's commands (rules: .claude/rules/commands.md). Features call
// runCommand and register handlers with useCommandHandler; the screen
// skeleton installs useKeybindings once.

export type AppCommandId = CommandId<AppCommands>

// Arguments are never logged: they can hold file paths or what a member typed.
const reportFailure = (error: unknown, id: string) => {
  console.warn(`[commands] ${id} failed:`, error instanceof CommandError ? error.code : error)
}

export const commands = createCommandRegistry(COMMANDS, { onError: reportFailure })

type ArgsParam<A> = Record<never, never> extends A ? [args?: A] : [args: A]

/**
 * Runs a command; a failure (nobody handles it now, bad arguments, the
 * handler threw) is logged and resolves to undefined.
 */
export function runCommand<I extends AppCommandId>(id: I, ...args: ArgsParam<CommandArgs<AppCommands, I>>): Promise<unknown> {
  return (commands.run as (id: I, args?: unknown) => Promise<unknown>)(id, args[0])
    .catch(error => { reportFailure(error, id); return undefined })
}

/**
 * Handles a command while the component is mounted. The latest `handler` is
 * used without re-registering; a change of target re-registers.
 */
export function useCommandHandler<I extends AppCommandId>(
  id: I,
  handler: CommandHandler<CommandHandlerArgs<AppCommands, I>>,
  options: RegisterOptions = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const acceptsKeyRef = useRef(options.acceptsKey)
  acceptsKeyRef.current = options.acceptsKey
  const { target } = options
  const hasAcceptsKey = options.acceptsKey !== undefined
  useEffect(() => commands.register(id, (args, context) => handlerRef.current(args, context), {
    target,
    acceptsKey: hasAcceptsKey ? () => acceptsKeyRef.current?.() ?? true : undefined,
  }), [id, target, hasAcceptsKey])
}

/** Whether a command can run now (e.g. show a file name as a link only when something opens files). */
export function useCommandAvailable(id: AppCommandId, target?: string): boolean {
  return useSyncExternalStore(commands.subscribe, () => commands.has(id, target))
}

/** Marks an element as a focus area for shortcuts: spread onto its root (`{...commandArea('chat', paneId)}`). */
export function commandArea(area: CommandArea, target?: string): Record<string, string> {
  return target === undefined
    ? { 'data-command-area': area }
    : { 'data-command-area': area, 'data-command-target': target }
}

/**
 * Delivers shortcuts to the focused area only (one listener for the window)
 * and remembers which instance of an area the member used last. Install
 * once, in the screen skeleton.
 */
export function useKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (commands.handleKey(event, focusChainOf(event.target))) event.preventDefault()
    }
    const onFocusIn = (event: FocusEvent) => {
      for (const scope of focusChainOf(event.target)) {
        if (scope.target !== undefined) commands.setActiveTarget(scope.area, scope.target)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])
}
