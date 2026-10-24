// The main process's side of the IPC contract (shared/ipc-contract.ts): a
// registrar whose `handle` / `on` accept only the contract's channels, and
// check each handler's parameters and result against them at compile time.
//
// No Electron import: the shell (main.ts) wraps Electron's ipcMain with
// `typedIpc(ipcMain)`, and code that registers handlers depends only on the
// `IpcRegistrar` interface — under test it is the fake ipcMain, and another
// shell would wrap its own IPC the same way.
//
// Register handlers as `ipc.handle('channel', (event, ...) => ...)` with the
// channel as a string literal: tests/ipc-harness reads the registrations from
// the source (the variable must be named `ipc` or `ipcMain`).

import type {
  InvokeArgs, InvokeChannel, InvokeResult, SendArgs, SendChannel, SyncArgs, SyncChannel, SyncResult,
} from '../../shared/ipc-contract'

/** The renderer (window) an IPC message came from, as handlers use it. */
export interface IpcSender {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** What an ipcMain.handle handler receives first. */
export interface IpcInvokeEvent { sender: IpcSender }
/** What an ipcMain.on listener receives first; a sendSync listener answers through `returnValue`. */
export interface IpcMessageEvent { sender: IpcSender; returnValue: unknown }

type MaybePromise<T> = T | Promise<T>

export interface IpcRegistrar<HandleEvent = IpcInvokeEvent, MessageEvent = IpcMessageEvent> {
  /** ipcRenderer.invoke(channel, ...args) answers what `handler` returns (or throws). */
  handle<C extends InvokeChannel>(channel: C, handler: (event: HandleEvent, ...args: InvokeArgs<C>) => MaybePromise<InvokeResult<C>>): void
  /** ipcRenderer.send(channel, ...args). */
  on<C extends SendChannel>(channel: C, listener: (event: MessageEvent, ...args: SendArgs<C>) => void): void
  /** ipcRenderer.sendSync(channel, ...args) returns what the listener puts in `event.returnValue`. */
  on<C extends SyncChannel>(channel: C, listener: (event: MessageEvent & { returnValue: SyncResult<C> }, ...args: SyncArgs<C>) => void): void
}

/** The part of Electron's ipcMain the registrar needs. */
export interface IpcMainLike<HandleEvent, MessageEvent> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, handler: (event: HandleEvent, ...args: any[]) => unknown): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, listener: (event: MessageEvent, ...args: any[]) => void): unknown
}

/** Type the given ipcMain against the contract. Registers nothing by itself. */
export function typedIpc<HandleEvent, MessageEvent>(ipcMain: IpcMainLike<HandleEvent, MessageEvent>): IpcRegistrar<HandleEvent, MessageEvent> {
  return {
    handle: (channel, handler) => ipcMain.handle(channel, handler as (event: HandleEvent, ...args: unknown[]) => unknown),
    on: ((channel: string, listener: (event: MessageEvent, ...args: unknown[]) => void) => { ipcMain.on(channel, listener) }) as IpcRegistrar<HandleEvent, MessageEvent>['on'],
  }
}
