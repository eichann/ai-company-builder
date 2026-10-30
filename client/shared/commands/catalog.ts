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
  {
    // Sending the message starts the AI on it, hence outbound.
    id: 'chat.newConsultation', title: '新しい相談を始める', class: 'outbound',
    args: z.object({
      message: z.string().min(1).optional().describe('Sent as the first message of the new consultation'),
      pane: z.string().optional().describe('The chat pane; the one used last when left out'),
    }),
    target: { arg: 'pane', area: 'chat' },
  },
  {
    // Replaces the composer's text; nothing is sent.
    id: 'chat.insertText', title: '入力欄に文を入れる', class: 'local',
    args: z.object({
      text: z.string().min(1),
      pane: z.string().optional().describe('The chat pane; the one used last when left out'),
    }),
    target: { arg: 'pane', area: 'chat' },
  },
])

export type AppCommands = typeof COMMANDS
