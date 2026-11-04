import { APP_COMMAND_MESSAGES, isAiCommand, type AppCommandAnswer, type AppCommandRequest } from '../../../shared/app-commands'
import { CommandError } from '../../../shared/commands/registry'
import { useIpcEvent } from '../hooks/useIpcEvent'
import { answerAppCommand, onAppCommandRequest } from '../ipc/app-commands'
import { commands } from './commands'

/**
 * Runs the consultation AI's app commands in this window (commands.md "Handed to the AI"): only
 * the catalog's `exposeToAI` ones, through the same registry as a click, and answers main with
 * what the handler returned (plain data). The main screen mounts it; nothing else does.
 */
export function useAiCommandRequests(): void {
  useIpcEvent(onAppCommandRequest, (request: AppCommandRequest) => {
    const answer = (value: AppCommandAnswer) => { void answerAppCommand(request.requestId, value).catch(() => {}) }
    if (!isAiCommand(request.commandId)) { answer({ ok: false, error: APP_COMMAND_MESSAGES.unknown }); return }
    ;(commands.run as (id: string, args?: unknown) => Promise<unknown>)(request.commandId, request.args ?? {}).then(
      result => answer({ ok: true, result: JSON.parse(JSON.stringify(result ?? null)) }),
      error => {
        // The arguments are never logged (commands.md).
        console.warn(`[commands] ${request.commandId} for the AI failed:`, error instanceof CommandError ? error.code : 'error')
        answer({ ok: false, error: error instanceof CommandError && error.code === 'invalid-args' ? APP_COMMAND_MESSAGES.badArgs : APP_COMMAND_MESSAGES.failed })
      },
    )
  })
}
