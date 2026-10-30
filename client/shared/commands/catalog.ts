/**
 * The app's commands: the one list of every named operation (rules:
 * .claude/rules/commands.md). Add a command here, then register its handler
 * where it runs. Only operations another feature, a shortcut or (later) the
 * AI or an extension invokes become commands; calls inside a feature stay
 * direct.
 */
import { defineCommands } from './define'

export const COMMANDS = defineCommands([])

export type AppCommands = typeof COMMANDS
