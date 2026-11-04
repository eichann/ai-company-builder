// The app's commands the consultation AI may run (commands.md "Handed to the AI"; today the
// middle's tabs: tabs.list / tabs.tidy / tabs.restore). The chat server's tool asks the main
// window to run one and waits for its answer:
//   event appCommand:request → the main window only
//   appCommand:respond ← only the window that was asked
// A consultation shown in a window of its own has no tabs: refused here, nothing is sent.

import { APP_COMMAND_MESSAGES, isAiCommand, type AppCommandAnswer } from '../../../shared/app-commands'
import { COMMANDS } from '../../../shared/commands/catalog'
import type { CommandDefinition } from '../../../shared/commands/define'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { WindowPort } from '../ports'

export interface AppCommandsDeps {
  /** The main window's webContents id, undefined while there is none. */
  mainWindowId: () => number | undefined
  /** Events to the main window. */
  mainWindow: WindowPort
  /** The consultation is shown in a window of its own (chatWindows.windowForSession). */
  inOwnWindow: (sessionId: string) => boolean
  /** How long the window has to answer (ms). */
  timeoutMs?: number
}

export interface AppCommandRunner {
  /** Runs an AI command for a consultation of `companyId` in the main window; never rejects. */
  run(sessionId: string, companyId: string, commandId: string, args: unknown, signal?: AbortSignal): Promise<AppCommandAnswer>
}

export function registerAppCommandsIpc(ipc: IpcRegistrar, { mainWindowId, mainWindow, inOwnWindow, timeoutMs = 20_000 }: AppCommandsDeps): AppCommandRunner {
  const pending = new Map<string, { windowId: number; resolve: (answer: AppCommandAnswer) => void }>()

  ipc.handle('appCommand:respond', (event, requestId: string, answer: AppCommandAnswer) => {
    const waiting = typeof requestId === 'string' ? pending.get(requestId) : undefined
    // Only the window that was asked may answer.
    if (!waiting || waiting.windowId !== event.sender.id) return
    const ok = !!answer && typeof answer === 'object' && (answer as { ok?: unknown }).ok === true
    waiting.resolve(ok
      ? { ok: true, result: (answer as { result?: unknown }).result ?? null }
      : { ok: false, error: typeof (answer as { error?: unknown })?.error === 'string' ? String((answer as { error: string }).error).slice(0, 500) : APP_COMMAND_MESSAGES.failed })
  })

  return {
    run(sessionId, companyId, commandId, args, signal) {
      if (typeof companyId !== 'string' || !companyId) return Promise.resolve({ ok: false, error: APP_COMMAND_MESSAGES.otherCompany })
      if (!isAiCommand(commandId)) return Promise.resolve({ ok: false, error: APP_COMMAND_MESSAGES.unknown })
      const def = (COMMANDS as Record<string, CommandDefinition>)[commandId]
      const parsed = def.args.safeParse(args ?? {})
      if (!parsed.success) return Promise.resolve({ ok: false, error: APP_COMMAND_MESSAGES.badArgs })
      if (inOwnWindow(sessionId)) return Promise.resolve({ ok: false, error: APP_COMMAND_MESSAGES.ownWindow })
      const windowId = mainWindowId()
      if (windowId === undefined) return Promise.resolve({ ok: false, error: APP_COMMAND_MESSAGES.noWindow })
      const requestId = crypto.randomUUID()
      return new Promise<AppCommandAnswer>(resolve => {
        const stop = { timer: undefined as ReturnType<typeof setTimeout> | undefined, aborted: () => {} }
        const done = (answer: AppCommandAnswer) => {
          if (!pending.delete(requestId)) return
          clearTimeout(stop.timer)
          signal?.removeEventListener('abort', stop.aborted)
          resolve(answer)
        }
        const aborted = () => done({ ok: false, error: APP_COMMAND_MESSAGES.failed })
        stop.aborted = aborted
        stop.timer = setTimeout(() => done({ ok: false, error: APP_COMMAND_MESSAGES.timeout }), timeoutMs)
        pending.set(requestId, { windowId, resolve: done })
        if (signal?.aborted) { aborted(); return }
        signal?.addEventListener('abort', aborted, { once: true })
        mainWindow.send('appCommand:request', { requestId, companyId, commandId, args: parsed.data })
      })
    },
  }
}
