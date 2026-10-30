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
  {
    // Shows the consultation in a window of its own (only the chat); one already
    // shown in another window is brought to the front there.
    id: 'chat.openInWindow', title: '別ウィンドウで開く', class: 'view',
    args: z.object({
      sessionId: z.string().min(1).describe('The consultation (conversation id)'),
      pane: z.string().optional().describe('The chat pane that lists it; the one used last when left out'),
    }),
    target: { arg: 'pane', area: 'chat' },
  },
  {
    // Settings → 「自分の鍵」, that service shown first (its form open when the member may register).
    id: 'settings.openOwnKey', title: '「自分の鍵」の設定を開く', class: 'view',
    args: z.object({ service: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional().describe('The service to show first (gemini, openai, …)') }),
  },
  {
    id: 'layout.toggleChat', title: 'AIチャットの表示を切り替える', class: 'view',
    args: z.object({}), keybinding: { key: 'mod+shift+c', area: 'app' },
  },
  {
    // The 「ファイルを探す」 dialog (search by file name).
    id: 'file.search', title: 'ファイルを名前で探す', class: 'view',
    args: z.object({}), keybinding: { key: 'mod+p', area: 'app' },
  },
  {
    // The left panel's 検索 tab, with the cursor in its box.
    id: 'search.show', title: '検索を開く', class: 'view',
    args: z.object({}), keybinding: { key: 'mod+shift+f', area: 'app' },
  },
  {
    // Writes the active tab to this computer; asks first when the file changed on disk. Shared only by sync.
    id: 'editor.save', title: 'ファイルを保存する', class: 'local',
    args: z.object({ pane: z.string().optional().describe('The editor pane; the one used last when left out') }),
    target: { arg: 'pane', area: 'editor' },
    keybinding: { key: 'mod+s', area: 'editor' },
  },
  {
    // A Markdown file: rendered preview ⇄ source. The choice is remembered for all files.
    id: 'editor.togglePreview', title: 'プレビューと編集を切り替える', class: 'view',
    args: z.object({ pane: z.string().optional().describe('The editor pane; the one used last when left out') }),
    target: { arg: 'pane', area: 'editor' },
    keybinding: { key: 'mod+shift+v', area: 'editor' },
  },
  {
    // The search box of a Markdown preview (the source editor has its own ⌘F).
    id: 'editor.find', title: '文書の中を検索する', class: 'view',
    args: z.object({ pane: z.string().optional().describe('The editor pane; the one used last when left out') }),
    target: { arg: 'pane', area: 'editor' },
    keybinding: { key: 'mod+f', area: 'editor' },
  },
])

export type AppCommands = typeof COMMANDS
