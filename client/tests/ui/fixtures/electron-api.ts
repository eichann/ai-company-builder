// Typed fake of the preload API for preview pages (runs in the browser).
// `Window['electronAPI']` is declared by src/shared/ipc/electron-api.ts (part of the
// tests/ui/tsconfig.json program), so a fixture that implements a method with
// the wrong shape fails `tsc -p tests/ui`.
// Anything not implemented answers like an idle app: `on…` subscriptions
// return an unsubscribe no-op, every other call resolves to undefined.

export type ElectronAPI = Window['electronAPI']

const noop = () => {}

export function installElectronAPI(implemented: Partial<ElectronAPI>): ElectronAPI {
  const api = new Proxy(implemented as ElectronAPI, {
    get(target, name) {
      if (typeof name !== 'string') return undefined
      if (name in target) return target[name as keyof ElectronAPI]
      if (name.startsWith('on')) return () => noop
      return async () => undefined
    },
  })
  ;(window as unknown as { electronAPI: ElectronAPI }).electronAPI = api
  return api
}

/** A listener set for an `on…(callback) => unsubscribe` preload method. */
export function emitter<T>() {
  const listeners = new Set<(value: T) => void>()
  return {
    subscribe: (callback: (value: T) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    emit: (value: T) => { for (const callback of [...listeners]) callback(value) },
    get size() { return listeners.size },
  }
}
