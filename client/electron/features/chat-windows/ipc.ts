// 「別ウィンドウで開く」: a consultation in a window of its own (only the chat).
//   chatWindow:open, chatWindow:focus, chatWindow:list, chatWindow:closeAll  (the main window only)
//   chatWindow:getContext, chatWindow:reportStatus, chatWindow:openFile     (a consultation's window only)
//   event chatWindow:changed → the main window (statuses, a window that closed)
//   event chatWindow:fileRequested → the main window (a file link clicked in a consultation's window)
// Each handler checks who sent it: the main window manages the windows, a
// consultation's window reads only its own context, reports only its own
// status and asks only to open a file of its own company folder in the main
// window's editor. Nothing else is accepted from either.

import fs from 'fs'
import path from 'path'
import { notDownloadedFolderFor } from '../../sync/not-downloaded'
import {
  CLOSE_WHILE_WORKING_DETAIL, CLOSE_WHILE_WORKING_MESSAGE, OPEN_FILE_NO_MAIN, OPEN_FILE_NOT_FOUND, OPEN_FILE_OUTSIDE,
  closeStopsTheAI, openFileNotDownloaded, parseOpenRequest, parseWindowStatus, validSessionId,
  type ChatWindowContext, type ChatWindowOpenFileResult, type ChatWindowOpenResult,
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
  /** Brings the main window to the front; false when there is none. */
  focusMainWindow: () => boolean
  /** What `chatWindow:openFile` asks of the disk (`diskFiles` in the app). */
  files: {
    /** The folder (company-relative) left out on this computer that holds the path, or null. */
    notDownloadedFolder(absPath: string): string | null
    isFile(absPath: string): boolean
  }
  log?: Pick<Console, 'warn'>
}

/** `files` on this computer's disk. */
export const diskFiles: ChatWindowsDeps['files'] = {
  notDownloadedFolder: notDownloadedFolderFor,
  isFile: filePath => { try { return fs.statSync(filePath).isFile() } catch { return false } },
}

const MAX_FILE_PATH = 4096

/** `filePath` lies inside `root` (both already resolved; compared in NFC, as the allowed-roots check). */
function isInside(filePath: string, root: string): boolean {
  const rel = path.relative(root.normalize('NFC'), filePath.normalize('NFC'))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export interface ChatWindows {
  /** The window (webContents id) showing this consultation, if any: where its questions and approvals go. */
  windowForSession(sessionId: string): number | undefined
  isChatWindow(windowId: number): boolean
  /** Closes every consultation window without asking (sign-out, the main window closed, quitting). */
  closeAll(): void
}

const MAIN_ONLY = 'この操作はメインの画面からだけできます。'

export function registerChatWindowsIpc(ipc: IpcRegistrar, { host, paths, isMainWindow, mainWindow, focusMainWindow, files, log = console }: ChatWindowsDeps): ChatWindows {
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

  // A file link in a consultation's window (the window's `file.open` handler):
  // the editor lives in the main window, which runs `file.open` with the path
  // checked here. Only a file of the window's own company folder, as the main
  // window could open it: allowed roots (by real location), not inside a
  // folder left out on this computer, and present on disk (a private folder
  // the member cannot read is not; the refusal never names the path).
  ipc.handle('chatWindow:openFile', (event, filePath: string): ChatWindowOpenFileResult => {
    const entry = registry.get(event.sender.id)
    if (!entry) return { ok: false, error: OPEN_FILE_OUTSIDE }
    // No '..' segment: the main window gets the path as the window wrote it (its editor tabs are keyed by it).
    if (typeof filePath !== 'string' || filePath.length > MAX_FILE_PATH || filePath.includes('\0') || filePath.split(/[\\/]/).includes('..')) {
      return { ok: false, error: OPEN_FILE_OUTSIDE }
    }
    let safePath: string
    try {
      safePath = paths.validate(filePath)
      if (!isInside(safePath, path.resolve(entry.context.rootPath))) throw new Error('outside the window\'s company folder')
    } catch {
      return { ok: false, error: OPEN_FILE_OUTSIDE }
    }
    const notDownloaded = files.notDownloadedFolder(safePath)
    if (notDownloaded !== null) return { ok: false, error: openFileNotDownloaded(notDownloaded.normalize('NFC')) }
    if (!files.isFile(safePath)) return { ok: false, error: OPEN_FILE_NOT_FOUND }
    if (!focusMainWindow()) return { ok: false, error: OPEN_FILE_NO_MAIN }
    mainWindow.send('chatWindow:fileRequested', { path: filePath })
    return { ok: true }
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
