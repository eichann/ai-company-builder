import { useEffect } from 'react'
import { matchesVoiceShortcut, voiceShortcut } from '../../voice/voiceShortcut'
import { commands, runCommand } from '../../../shared/commands/commands'

/**
 * The member's voice key (default ⌘⇧M): one `window` listener for the whole
 * page however many composers ask for it, running `chat.toggleVoiceInput`
 * for the chat pane used last. Window-wide on purpose: the key works while
 * the focus is in the editor or the file tree too, as it always has. The key
 * is the member's choice, so it is not a catalog keybinding.
 */
let users = 0

function onKeyDown(event: KeyboardEvent) {
  if (event.isComposing || event.repeat || document.querySelector('[role="dialog"]')) return
  if (!matchesVoiceShortcut(event, voiceShortcut.getSnapshot()) || !commands.has('chat.toggleVoiceInput')) return
  event.preventDefault()
  event.stopPropagation()
  void runCommand('chat.toggleVoiceInput')
}

export function useVoiceShortcut(): void {
  useEffect(() => {
    if (users++ === 0) window.addEventListener('keydown', onKeyDown, true)
    return () => {
      if (--users === 0) window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}
