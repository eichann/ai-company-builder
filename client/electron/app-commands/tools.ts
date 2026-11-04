/**
 * The app's commands as the consultation AI's tools (commands.md "Handed to the AI"): every
 * catalog command with `exposeToAI` (today tabs.list, tabs.tidy, tabs.restore; classes view and
 * local only) becomes a tool on the app's own MCP server `acb_app`, with the catalog's zod args as
 * its schema — no second definition. Given to Claude Code in process (always loaded) and to Codex
 * as a loopback endpoint, like the review tool. The tool only relays: main asks the main window
 * to run the command (features/app-commands/ipc.ts) and hands back its answer as JSON.
 */
import { startLoopbackMcp } from '../agents/loopback-mcp'
import { APP_COMMANDS_SERVER, aiCommands, appCommandToolId, appCommandToolName, type AppCommandAnswer } from '../../shared/app-commands'
import type { CommandDefinition } from '../../shared/commands/define'

export { APP_COMMANDS_SERVER } from '../../shared/app-commands'

export interface AppCommandTool {
  /** The MCP tool name (`tabs_list`) and the id the agent reports (`mcp__acb_app__tabs_list`). */
  name: string
  id: string
  description: string
  schema: CommandDefinition['args']
  /** `view`: changes nothing; `local`: only this computer's screen, undoable. */
  readOnly: boolean
}

export interface AppCommandTools {
  tools: AppCommandTool[]
  execute(name: string, input: unknown): Promise<string>
}

/** The tools for one chat request; `run` reaches the window that shows the consultation. */
export function createAppCommandTools(run: (commandId: string, args: unknown) => Promise<AppCommandAnswer>): AppCommandTools {
  const defs = aiCommands()
  return {
    tools: defs.map(def => ({
      name: appCommandToolName(def.id), id: appCommandToolId(def.id),
      description: def.aiDescription ?? def.title, schema: def.args, readOnly: def.class === 'view',
    })),
    async execute(name, input) {
      const def = defs.find(d => appCommandToolName(d.id) === name)
      if (!def) return JSON.stringify({ error: 'この道具はありません。' })
      const answer = await run(def.id, input ?? {}).catch((): AppCommandAnswer => ({ ok: false, error: 'できませんでした。' }))
      return JSON.stringify(answer.ok ? answer.result ?? { ok: true } : { error: answer.error })
    },
  }
}

/** Codex: the same tools behind a request-scoped loopback MCP endpoint. */
export function startAppCommandsMcp(tools: AppCommandTools) {
  return startLoopbackMcp(APP_COMMANDS_SERVER, tools.tools.map(t => ({
    name: t.name, description: t.description, inputSchema: t.schema.shape,
    execute: (args: unknown) => tools.execute(t.name, args),
  })))
}
