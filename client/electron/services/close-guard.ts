// Closing the main window (or quitting) first lets the renderer save every
// open tab: the window's close is held, the renderer is asked
// (`app:closeRequested`), saves, asks the member about what it could not
// save, and answers `close` or `stay` (`app:closeResponse`). A renderer that
// does not acknowledge within `ackTimeoutMs` (still loading, hung) does not
// keep the window open. Then, with a sync running, the member is asked:
// quitting half-way leaves a stopped rebase for the next sync to clean up, so
// the default is to wait for it (sync-guards.md). The window stays usable while
// waiting, so the renderer saves again before it closes; another close during
// the wait asks again, so a hung sync cannot trap the member. No Electron here:
// electron-adapter.ts wires the window.

export type CloseAnswer = 'ack' | 'close' | 'stay'

export type CloseDuringSyncChoice = 'wait' | 'stay' | 'quit-now'

/** The question, in button order of `CLOSE_DURING_SYNC_CHOICES`. */
export const CLOSE_DURING_SYNC_QUESTION = {
  title: '同期の途中です',
  message: '同期の途中です。終わるまで待ちますか？',
  detail: '今すぐ終了すると、アプリが終了して同期が途中で止まります。止まっていた間に変わったファイルは、次の同期で .backups に保存されます。',
  buttons: ['終わったら閉じる', '閉じない', 'すぐに終了する'],
  defaultId: 0,
  cancelId: 1,
}
export const CLOSE_DURING_SYNC_CHOICES: readonly CloseDuringSyncChoice[] = ['wait', 'stay', 'quit-now']

/** What closing needs to know about sync. */
export interface CloseGuardSync {
  running(): boolean
  /** Ask the member what to do. */
  confirm(): Promise<CloseDuringSyncChoice>
  /** Resolves when nothing is syncing any more; automatic runs are held from now on. */
  done(): Promise<void>
  /** The member stayed: automatic runs go on. */
  resume(): void
}

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
  sync?: CloseGuardSync
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
  const sync = deps.sync
  let allowed = false
  let phase: 'idle' | 'saving' | 'asking' | 'waiting' = 'idle'
  let quitting = false
  let ackTimer: unknown = null
  /** done() was called and the member has not stayed since. */
  let holding = false
  /** すぐに終了する: only saving is left, the running sync is not asked about again. */
  let quitNow = false

  const clearAck = () => {
    if (ackTimer !== null) { deps.clearTimer(ackTimer); ackTimer = null }
  }

  const release = () => {
    allowed = true
    phase = 'idle'
    clearAck()
    if (quitting) deps.quit()
    else deps.close()
  }

  const stay = () => {
    phase = 'idle'
    quitting = false
    quitNow = false
    clearAck()
    if (holding) { holding = false; sync?.resume() }
  }

  // save → (no answer) finish → askAboutSync → save: set below.
  let finish: () => Promise<void> = async () => {}

  const save = () => {
    phase = 'saving'
    deps.ask()
    ackTimer = deps.setTimer(() => { ackTimer = null; if (phase === 'saving') void finish() }, ackTimeoutMs)
  }

  const askAboutSync = async () => {
    if (!sync) return
    phase = 'asking'
    clearAck()
    // A question that could not be shown counts as the safe default.
    const choice = await sync.confirm().catch((): CloseDuringSyncChoice => 'wait')
    if (choice === 'stay') { stay(); return }
    // Really quits, also where closing the window alone would leave the sync running
    // without a window, and what was typed during a wait is saved first.
    if (choice === 'quit-now') { quitting = true; quitNow = true; save(); return }
    phase = 'waiting'
    holding = true
    await sync.done()
    // Typing went on during the wait: what is in the tabs now is saved before closing.
    if (phase === 'waiting') save()
  }

  /** Tabs are saved (or the renderer is gone): only a running sync can still hold the close. */
  finish = async () => {
    if (sync?.running() && !quitNow) await askAboutSync()
    else release()
  }

  return {
    onClose() {
      if (allowed) return true
      if (phase === 'idle') save()
      else if (phase === 'waiting') void askAboutSync()
      return false
    },
    onQuitRequested() {
      quitting = true
    },
    answer(answer) {
      if (phase !== 'saving') return
      if (answer === 'ack') { clearAck(); return }
      if (answer === 'close') { void finish(); return }
      stay()
    },
  }
}
