import { APP_COMMAND_MESSAGES, appCommandRefusal, type AppCommandAnswer, type AppCommandRequest } from '../../shared/app-commands'
import { CommandError } from '../../shared/commands/registry'
import { commands } from '../shared/commands/commands'
import { useIpcEvent } from '../shared/hooks/useIpcEvent'
import { answerAppCommand, onAppCommandRequest } from '../shared/ipc/app-commands'
import { useAppStore } from '../stores/appStore'

/**
 * Runs the consultation AI's app commands in the main window (commands.md "Handed to the AI"):
 * only the catalog's `exposeToAI` ones and only for the company on screen (a consultation of
 * another company is refused politely), through the same registry as a click; answers main with
 * what the handler returned (plain data). Mounted by the main screen only.
 */
export function useAiCommandRequests(): void {
  useIpcEvent(onAppCommandRequest, (request: AppCommandRequest) => {
    const answer = (value: AppCommandAnswer) => { void answerAppCommand(request.requestId, value).catch(() => {}) }
    const refused = appCommandRefusal(request, useAppStore.getState().currentCompany?.id)
    if (refused) { answer({ ok: false, error: refused }); return }
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
