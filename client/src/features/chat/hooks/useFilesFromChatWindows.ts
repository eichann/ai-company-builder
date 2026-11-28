import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { runCommand } from '../../../shared/commands/commands'
import { isHtmlDocumentName } from '../../../../shared/doc-frame'
import { onFileRequestedFromChatWindow } from '../api'

/**
 * The main window opens the files a consultation's own window asked for (a
 * file link there; main checked the path and brought this window to the
 * front): the same `file.open` command a link in this window runs. An HTML
 * page (a reply's page card, chat-ui-and-history.md "Page cards in a reply")
 * is shown as 見る even when its tab showed 中身, as the card does here.
 */
export function useFilesFromChatWindows(): void {
  useIpcEvent(onFileRequestedFromChatWindow, ({ path }) => {
    void (isHtmlDocumentName(path) ? runCommand('editor.viewDocument', { path }) : runCommand('file.open', { path }))
  })
}
