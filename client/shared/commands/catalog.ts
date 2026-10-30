/**
 * The app's commands: the one list of every named operation (rules:
 * .claude/rules/commands.md). Add a command here, then register its handler
 * where it runs. Only operations another feature, a shortcut or (later) the
 * AI or an extension invokes become commands; calls inside a feature stay
 * direct.
 */
import { z } from 'zod'
import { defineCommands } from './define'

export const COMMANDS = defineCommands([
  {
    // Opens the file in the editor (files tab), as a kept tab.
    id: 'file.open', title: 'ファイルを開く', class: 'view',
    args: z.object({ path: z.string().min(1).describe('The file\'s absolute path inside the company folder') }),
  },
])

export type AppCommands = typeof COMMANDS
