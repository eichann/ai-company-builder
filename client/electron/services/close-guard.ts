// Closing the main window (or quitting) first lets the renderer save every
// open tab: the window's close is held, the renderer is asked
// (`app:closeRequested`), saves, asks the member about what it could not
// save, and answers `close` or `stay` (`app:closeResponse`). A renderer that
// does not acknowledge within `ackTimeoutMs` (still loading, hung) does not
// keep the window open. No Electron here: electron-adapter.ts wires the window.

export type CloseAnswer = 'ack' | 'close' | 'stay'

export interface CloseGuardDeps {
  /** Ask the renderer (a window event). */
  ask: () => void
  /** Close the window for real (the next `onClose` passes). */
  close: () => void
  /** Quit the app (used when the close came from a quit). */
  quit: () => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  ackTimeoutMs?: number
}

export interface CloseGuard {
  /** The window's `close` event: true when it may close now; false = held (preventDefault). */
  onClose(): boolean
  /** The app is quitting (`before-quit`): after the renderer says close, quit instead of only closing. */
  onQuitRequested(): void
  /** The renderer's answer. */
  answer(answer: CloseAnswer): void
}

export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
  const ackTimeoutMs = deps.ackTimeoutMs ?? 3000
  let allowed = false
  let waiting = false
  let quitting = false
  let ackTimer: unknown = null

  const release = () => {
    allowed = true
    waiting = false
    if (ackTimer !== null) { deps.clearTimer(ackTimer); ackTimer = null }
    if (quitting) deps.quit()
    else deps.close()
  }

  return {
    onClose() {
      if (allowed) return true
      if (!waiting) {
        waiting = true
        deps.ask()
        ackTimer = deps.setTimer(() => { ackTimer = null; if (waiting) release() }, ackTimeoutMs)
      }
      return false
    },
    onQuitRequested() {
      quitting = true
    },
    answer(answer) {
      if (!waiting) return
      if (answer === 'ack') {
        if (ackTimer !== null) { deps.clearTimer(ackTimer); ackTimer = null }
        return
      }
      if (answer === 'close') { release(); return }
      waiting = false
      quitting = false
      if (ackTimer !== null) { deps.clearTimer(ackTimer); ackTimer = null }
    },
  }
}
