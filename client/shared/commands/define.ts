/**
 * What a command is: a named operation (`file.open`, `chat.insertText`) with
 * typed arguments, a class saying how far its effect reaches, and an optional
 * keyboard shortcut. Pure (only zod, see below), so the renderer, the main
 * process and tests read the same definitions; handlers are registered where
 * they run (registry.ts). Rules: .claude/rules/commands.md.
 *
 * Arguments are zod objects because zod is already the schema language of
 * the app's AI tools (`electron/agents/loopback-mcp.ts` takes a ZodRawShape):
 * a command handed to the AI later becomes a tool without a second schema.
 */
import { z } from 'zod'

/**
 * How far a command's effect reaches (design memo E1, owner 2026-10-30).
 * It decides how the command may ever be handed to the AI:
 * view → without asking; local → undoable; outbound → the member presses
 * 「はい」 each time; admin → the AI drafts, the member approves on ACB's own
 * confirmation screen; never → not handed over at all.
 */
export type CommandClass = 'view' | 'local' | 'outbound' | 'admin' | 'never'
export const COMMAND_CLASSES: readonly CommandClass[] = ['view', 'local', 'outbound', 'admin', 'never']

/**
 * A part of the screen that can hold the keyboard focus and receive its own
 * shortcuts. `app` is the whole window: every focus is inside it.
 */
export type CommandArea = 'app' | 'chat'
export const COMMAND_AREAS: readonly CommandArea[] = ['app', 'chat']

export interface CommandKeybinding {
  /**
   * `mod+shift+c`: modifiers (mod = ⌘ or Ctrl, shift, alt) then one KeyboardEvent.key.
   * A letter A–Z matches in either case (Windows reports Ctrl+Shift+C as `C`); other keys exactly.
   */
  readonly key: string
  /** Only a focus inside this area receives the key (the innermost area wins). */
  readonly area: CommandArea
}

export interface CommandDefinition<Id extends string = string, Args extends z.ZodObject = z.ZodObject> {
  /** `area.verb`, English (`file.open`). Callers and, later, the AI name the command by it. */
  readonly id: Id
  /** What the member reads (Japanese). */
  readonly title: string
  readonly class: CommandClass
  readonly args: Args
  /** Handed to the AI as a tool. Defaults to false; nothing reads it yet. */
  readonly exposeToAI?: boolean
  readonly keybinding?: CommandKeybinding
  /**
   * The command acts on one of several instances of an area (a chat pane):
   * `arg` names the optional argument that picks it. Without it the instance
   * the member used last runs it; a shortcut picks the focused one.
   */
  readonly target?: { readonly arg: string; readonly area: CommandArea }
}

export type CommandCatalog<Defs extends readonly CommandDefinition[] = readonly CommandDefinition[]> = {
  readonly [D in Defs[number] as D['id']]: D
}

const ID_SHAPE = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/

export class CommandDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandDefinitionError'
  }
}

/**
 * Checks a list of definitions and indexes it by id. Throws on a duplicate
 * id, a missing or unknown class, or a shortcut that could not run, so a bad
 * catalog stops the app at start-up instead of misbehaving later.
 */
export function defineCommands<const Defs extends readonly CommandDefinition[]>(defs: Defs): CommandCatalog<Defs> {
  const byId: Record<string, CommandDefinition> = {}
  for (const def of defs) {
    const id = String(def?.id)
    if (!ID_SHAPE.test(id)) throw new CommandDefinitionError(`Command id "${id}" must be area.verb (e.g. file.open)`)
    if (Object.prototype.hasOwnProperty.call(byId, id)) throw new CommandDefinitionError(`Command "${id}" is defined twice`)
    if (!COMMAND_CLASSES.includes(def.class)) throw new CommandDefinitionError(`Command "${id}" must declare its class (${COMMAND_CLASSES.join(' / ')})`)
    if (typeof def.title !== 'string' || def.title.trim() === '') throw new CommandDefinitionError(`Command "${id}" needs a title`)
    if (!(def.args instanceof z.ZodObject)) throw new CommandDefinitionError(`Command "${id}": args must be a zod object`)
    if (def.exposeToAI && def.class === 'never') throw new CommandDefinitionError(`Command "${id}" is class never and cannot be handed to the AI`)
    if (def.target) {
      if (!COMMAND_AREAS.includes(def.target.area)) throw new CommandDefinitionError(`Command "${id}": unknown target area ${def.target.area}`)
      if (!(def.target.arg in def.args.shape)) throw new CommandDefinitionError(`Command "${id}": target argument "${def.target.arg}" is not one of its args`)
    }
    if (def.keybinding) {
      const { key, area } = def.keybinding
      if (!parseKey(key)) throw new CommandDefinitionError(`Command "${id}": cannot read shortcut "${key}"`)
      if (!COMMAND_AREAS.includes(area)) throw new CommandDefinitionError(`Command "${id}": unknown shortcut area ${area}`)
      if (def.target && def.target.area !== area) throw new CommandDefinitionError(`Command "${id}": its shortcut must belong to its target area ${def.target.area}`)
      // A shortcut runs the command with no arguments (plus the focused target).
      if (!def.args.safeParse({}).success) throw new CommandDefinitionError(`Command "${id}" has a shortcut but required arguments`)
    }
    byId[id] = { ...def, exposeToAI: def.exposeToAI ?? false }
  }
  const shortcuts = new Map<string, string>()
  for (const def of Object.values(byId)) {
    if (!def.keybinding) continue
    const slot = `${def.keybinding.area}:${normalizeKey(def.keybinding.key)}`
    const other = shortcuts.get(slot)
    if (other) throw new CommandDefinitionError(`Commands "${other}" and "${def.id}" share the shortcut ${def.keybinding.key} in ${def.keybinding.area}`)
    shortcuts.set(slot, def.id)
  }
  return byId as CommandCatalog<Defs>
}

// ---- Shortcut keys ----

export interface ParsedKey {
  readonly mod: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly key: string
}

/** The parts of a KeyboardEvent a shortcut looks at. */
export interface KeyInput {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

const MODIFIERS = new Set(['mod', 'shift', 'alt'])

export function parseKey(spec: string): ParsedKey | null {
  const parts = spec.split('+')
  const key = parts.pop()
  if (!key || parts.some(p => !MODIFIERS.has(p)) || new Set(parts).size !== parts.length) return null
  return { mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt'), key: keyName(key) }
}

/**
 * A letter A–Z in lower case, any other key as it is. Shift is a modifier of
 * its own, so the case `event.key` reports for a letter carries nothing:
 * macOS gives `c` for ⌘⇧C, Windows / Linux give `C` for Ctrl+Shift+C (and
 * Caps Lock turns Ctrl+P into `P`).
 */
function keyName(key: string): string {
  return /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key
}

function normalizeKey(spec: string): string {
  const p = parseKey(spec)!
  return `${p.mod}:${p.shift}:${p.alt}:${p.key}`
}

/**
 * Whether a key press is this shortcut. `mod` is ⌘ or Ctrl (as the app's
 * shortcuts always were); shift and alt (⌥) must match exactly, so ⌥⌘P is
 * not ⌘P; a letter matches in either case (keyName), any other key exactly.
 */
export function matchesKey(spec: ParsedKey, input: KeyInput): boolean {
  return spec.mod === (input.metaKey || input.ctrlKey)
    && spec.shift === input.shiftKey
    && spec.alt === input.altKey
    && spec.key === keyName(input.key)
}
