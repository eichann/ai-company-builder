// 「別ウィンドウで開く」: one consultation shown in a window of its own (only
// the chat), next to the main window. Shared by main (the window registry,
// electron/features/chat-windows) and the renderer (the main window's list,
// the chat-only shell). Pure: no Node, no Electron, no React.

/** A skill's slash command, as the main window's composer offers it. */
export interface ChatWindowSkillCommand { command: string; name: string; description?: string; color?: string }

/** What the main window hands over when it opens a consultation in its own window. */
export interface ChatWindowOpenRequest {
  companyId: string
  companyName: string
  /** The company folder; main accepts only a registered one. */
  rootPath: string
  /** The department the main window showed (the AI's working context); none = company-wide. */
  department?: { name: string; folder: string }
  slashCommands?: ChatWindowSkillCommand[]
  /** The window's first title, until the page names it after the consultation. */
  title?: string
}

/** What a consultation's window shows: asked by that window only (`chatWindow:getContext`). */
export interface ChatWindowContext extends ChatWindowOpenRequest { sessionId: string }

/** The window's status for the main window's 「AIへの相談」 list (same shape as the renderer's ConsultationStatus). */
export interface ChatWindowStatus {
  state: 'needs-you' | 'working' | 'unseen' | 'failed' | 'idle'
  kind?: 'approve' | 'question' | 'review'
  line: string
}

export const IDLE_WINDOW_STATUS: ChatWindowStatus = { state: 'idle', line: '' }

/** One consultation open in a window of its own. */
export interface ChatWindowInfo { companyId: string; sessionId: string; status: ChatWindowStatus }

/** `chatWindow:changed`: every open window, and the one that just closed (it returns to the main window). */
export interface ChatWindowsChange {
  windows: ChatWindowInfo[]
  closed?: { companyId: string; sessionId: string }
}

export type ChatWindowOpenResult = { ok: true; focused: boolean } | { ok: false; error: string }

const STATES = new Set<ChatWindowStatus['state']>(['needs-you', 'working', 'unseen', 'failed', 'idle'])
const KINDS = new Set<NonNullable<ChatWindowStatus['kind']>>(['approve', 'question', 'review'])
const MAX_LINE = 200
const MAX_COMMANDS = 500
const MAX_TEXT = 500
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === 'string' && value.length <= max ? value : undefined

/** A conversation id as the history store makes them (UUIDs); anything else is refused. */
export function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/** The renderer's request, checked and copied field by field (nothing else reaches the new window). Null = refused. */
export function parseOpenRequest(value: unknown): ChatWindowOpenRequest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const companyId = text(raw.companyId, 128)
  const companyName = text(raw.companyName)
  const rootPath = text(raw.rootPath, 4096)
  if (!companyId || companyName === undefined || !rootPath) return null
  const request: ChatWindowOpenRequest = { companyId, companyName, rootPath }
  if (raw.department && typeof raw.department === 'object') {
    const department = raw.department as Record<string, unknown>
    const name = text(department.name)
    const folder = text(department.folder, 4096)
    if (name === undefined || folder === undefined) return null
    request.department = { name, folder }
  }
  if (Array.isArray(raw.slashCommands)) {
    request.slashCommands = raw.slashCommands.slice(0, MAX_COMMANDS).flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Record<string, unknown>
      const command = text(entry.command, 128)
      const name = text(entry.name)
      if (!command || name === undefined) return []
      const description = text(entry.description, 2000)
      const color = text(entry.color, 64)
      return [{ command, name, ...(description !== undefined ? { description } : {}), ...(color !== undefined ? { color } : {}) }]
    })
  }
  const title = text(raw.title)
  if (title) request.title = title
  return request
}

/** A status the window reports, checked (an unknown state is refused, the line is cut). */
export function parseWindowStatus(value: unknown): ChatWindowStatus | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!STATES.has(raw.state as ChatWindowStatus['state'])) return null
  const kind = KINDS.has(raw.kind as NonNullable<ChatWindowStatus['kind']>) ? raw.kind as ChatWindowStatus['kind'] : undefined
  const line = typeof raw.line === 'string' ? raw.line.slice(0, MAX_LINE) : ''
  return { state: raw.state as ChatWindowStatus['state'], ...(kind ? { kind } : {}), line }
}

/**
 * Closing the window would stop the AI: a turn runs, or the AI waits for an
 * approval or an answer (both belong to the running turn). Turns are driven by
 * the window's page (its request to the chat server), so they end with it.
 */
export function closeStopsTheAI(status: ChatWindowStatus | undefined): boolean {
  if (!status) return false
  return status.state === 'working' || (status.state === 'needs-you' && status.kind !== 'review')
}

export const CLOSE_WHILE_WORKING_MESSAGE = 'AIが作業中です。閉じると止まります'
export const CLOSE_WHILE_WORKING_DETAIL = 'このウィンドウを閉じると、AIの作業はそこで止まります。ここまでのやり取りは保存され、相談はメインの画面の一覧に戻ります。'

/**
 * A file link in a consultation's window (a 「確認をお願いします」 file): the
 * editor is in the main window, so the window's `file.open` handler asks main
 * (`chatWindow:openFile`), which checks the path and hands it to the main
 * window (`chatWindow:fileRequested`), where it runs as `file.open`.
 */
export type ChatWindowOpenFileResult = { ok: true } | { ok: false; error: string }

/** `chatWindow:fileRequested`: the main window opens this file (main checked it). */
export interface ChatWindowFileRequest { path: string }

/** The refusals never name the path (a private folder's name stays out of the window's text). */
export const OPEN_FILE_NOT_FOUND = 'このファイルが見つからないため、開けませんでした。'
export const OPEN_FILE_OUTSIDE = 'この相談の会社フォルダの外にあるため、開けませんでした。'
export const OPEN_FILE_NO_MAIN = 'メインの画面が開いていないため、開けませんでした。'
/** A folder left out on this computer (a department folder of the company repository, never a private folder's). */
export function openFileNotDownloaded(folder: string): string {
  return `このフォルダ（${folder}）はダウンロードしていないため、開けません。設定の「ダウンロードするフォルダ」でダウンロードしてから開いてください。`
}
