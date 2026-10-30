// 「別ウィンドウで開く」: a consultation in a window of its own (only the chat).
//   chatWindow:open, chatWindow:focus, chatWindow:list, chatWindow:closeAll  (the main window only)
//   chatWindow:getContext, chatWindow:reportStatus                          (a consultation's window only)
//   event chatWindow:changed → the main window (statuses, a window that closed)
// Each handler checks who sent it: the main window manages the windows, a
// consultation's window reads only its own context and reports only its own
// status. Nothing else is accepted from either.

import {
  CLOSE_WHILE_WORKING_DETAIL, CLOSE_WHILE_WORKING_MESSAGE, closeStopsTheAI, parseOpenRequest, parseWindowStatus, validSessionId,
  type ChatWindowContext, type ChatWindowOpenResult,
} from '../../../shared/chat-windows'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard, WindowPort } from '../ports'
import { createChatWindowRegistry } from './registry'

/** What the shell does with windows (electron-adapter.ts `createChatWindowHost`). */
export interface ChatWindowHost {
  /**
   * Opens a chat-only window with the app's hardened options; returns its id
   * (the webContents id its IPC arrives with). `confirmClose` is asked when the
   * member closes it: a question to show, or null to close at once.
   */
  open(options: {
    title: string
    confirmClose: () => { message: string; detail: string } | null
    onClosed: () => void
  }): number
  focus(windowId: number): void
  /** Closes without asking (the page still saves its conversation on unload). */
  close(windowId: number): void
}

export interface ChatWindowsDeps {
  host: ChatWindowHost
  paths: Pick<PathGuard, 'validate' | 'rootOf'>
  /** Whether an IPC sender is the app's main window. */
  isMainWindow: (senderId: number) => boolean
  /** Events to the main window. */
  mainWindow: WindowPort
  log?: Pick<Console, 'warn'>
}

export interface ChatWindows {
  /** The window (webContents id) showing this consultation, if any: where its questions and approvals go. */
  windowForSession(sessionId: string): number | undefined
  isChatWindow(windowId: number): boolean
  /** Closes every consultation window without asking (sign-out, the main window closed, quitting). */
  closeAll(): void
}

const MAIN_ONLY = 'この操作はメインの画面からだけできます。'

export function registerChatWindowsIpc(ipc: IpcRegistrar, { host, paths, isMainWindow, mainWindow, log = console }: ChatWindowsDeps): ChatWindows {
  const registry = createChatWindowRegistry()
  const broadcast = (closed?: { companyId: string; sessionId: string }) =>
    mainWindow.send('chatWindow:changed', { windows: registry.list(), ...(closed ? { closed } : {}) })

  function open(sessionId: string, context: ChatWindowContext): ChatWindowOpenResult {
    const existing = registry.find(sessionId)
    if (existing) {
      host.focus(existing.windowId)
      return { ok: true, focused: true }
    }
    // The callbacks run only after open() returned the id.
    const windowId: number = host.open({
      title: context.title || 'AIへの相談',
      confirmClose: () => closeStopsTheAI(registry.get(windowId)?.status)
        ? { message: CLOSE_WHILE_WORKING_MESSAGE, detail: CLOSE_WHILE_WORKING_DETAIL }
        : null,
      onClosed: () => {
        const entry = registry.release(windowId)
        if (entry) broadcast({ companyId: entry.context.companyId, sessionId: entry.context.sessionId })
      },
    })
    const claimed = registry.claim(windowId, context)
    if (!claimed.ok) {
      // Cannot happen (find and claim run in one turn); never show one consultation twice.
      host.close(windowId)
      host.focus(claimed.existing.windowId)
      return { ok: true, focused: true }
    }
    broadcast()
    return { ok: true, focused: false }
  }

  ipc.handle('chatWindow:open', (event, sessionId: string, request: unknown) => {
    if (!isMainWindow(event.sender.id)) return { ok: false, error: MAIN_ONLY }
    const parsed = parseOpenRequest(request)
    if (!validSessionId(sessionId) || !parsed) return { ok: false, error: '相談を別ウィンドウで開けませんでした。' }
    // The window's AI works in this folder: only a company folder the app registered.
    try {
      paths.validate(parsed.rootPath)
      if (paths.rootOf(parsed.rootPath) === null) throw new Error('not a company folder')
    } catch {
      return { ok: false, error: '会社フォルダが見つからないため、別ウィンドウで開けませんでした。' }
    }
    return open(sessionId, { ...parsed, sessionId })
  })

  ipc.handle('chatWindow:focus', (event, sessionId: string) => {
    if (!isMainWindow(event.sender.id) || !validSessionId(sessionId)) return false
    const entry = registry.find(sessionId)
    if (entry) host.focus(entry.windowId)
    return !!entry
  })

  ipc.handle('chatWindow:list', event => isMainWindow(event.sender.id) ? registry.list() : [])

  ipc.handle('chatWindow:closeAll', event => {
    if (isMainWindow(event.sender.id)) closeAll()
  })

  // A consultation's window learns what it shows; any other sender gets nothing.
  ipc.handle('chatWindow:getContext', event => registry.get(event.sender.id)?.context ?? null)

  ipc.handle('chatWindow:reportStatus', (event, status: unknown) => {
    const parsed = parseWindowStatus(status)
    if (!parsed || !registry.get(event.sender.id)) return false
    if (registry.setStatus(event.sender.id, parsed)) broadcast()
    return true
  })

  function closeAll() {
    for (const windowId of registry.windowIds()) {
      try { host.close(windowId) } catch (error) { log.warn('[chat-windows] close failed:', error instanceof Error ? error.message : error) }
    }
  }

  return {
    windowForSession: sessionId => registry.find(sessionId)?.windowId,
    isChatWindow: windowId => registry.get(windowId) !== undefined,
    closeAll,
  }
}
