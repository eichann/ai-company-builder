// What feature modules (electron/features/*) get from the shell. Features
// never import Electron (eslint enforces it): the composition root, main.ts,
// passes these in — Electron's implementations come from
// electron/electron-adapter.ts, tests pass fakes, another shell its own.

import type { EventChannel, EventPayload } from '../../shared/ipc-contract'
import type { ValidateOptions } from '../allowed-roots'

/**
 * The allowed-roots check (electron/allowed-roots.ts AllowedRoots): every
 * local path from the renderer goes through `validate` before it is used —
 * inside a company folder by name AND by real location; throws otherwise.
 */
export interface PathGuard {
  validate(inputPath: string, options?: ValidateOptions): string
  add(dirPath: string): void
  /** The allowed root containing the path (by name), or null. */
  rootOf(inputPath: string): string | null
}

/** The app's window: main → renderer events (dropped while there is no live window). */
export interface WindowPort {
  send<C extends EventChannel>(channel: C, ...payload: EventPayload<C>): void
}

/** OS integration the shell provides. */
export interface DesktopShell {
  /** Open a folder in Finder / Explorer. Resolves to an error message, '' on success. */
  openPath(path: string): Promise<string>
  /** Open a URL in the default browser / mail app. */
  openExternal(url: string): Promise<void>
}
