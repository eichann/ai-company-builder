import { useEffect } from 'react'
import { runCommand } from '../../../shared/commands/commands'
import { onFileRequestedFromChatWindow } from '../api'

/**
 * The main window opens the files a consultation's own window asked for (a
 * file link there; main checked the path and brought this window to the
 * front): the same `file.open` command a link in this window runs.
 */
export function useFilesFromChatWindows(): void {
  useEffect(() => onFileRequestedFromChatWindow(({ path }) => { void runCommand('file.open', { path }) }), [])
}
