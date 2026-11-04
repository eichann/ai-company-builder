// ACB foundation (settings: 設定 →「Google」 and 「仕事の道具をつなぐ」 read the permission; tasks:
// today's calendar re-reads when it changes): the member's Google permission as this app last read
// it, per company, and a renderer-local signal when it changes, so the list does not wait for its
// 10-minute look (tasks-ui.md). Nothing leaves the renderer; the server decides what is allowed.

/** What decides what ACB may read: connected, the grant's status, the features and those turned off. */
export interface GooglePermissionState {
  connected: boolean
  status: string | null
  features: readonly string[]
  featuresOff?: readonly string[]
}

/** Equal keys = the same permission (what was shown on 「仕事の道具をつなぐ」, `seen`, does not count). */
export function googlePermissionKey(state: GooglePermissionState | null): string {
  return state ? `${state.connected}|${state.status}|${state.features.join()}|${(state.featuresOff ?? []).join()}` : ''
}

type Listener = (companyId: string) => void

const lastKey = new Map<string, string>()
const listeners = new Set<Listener>()

export const googlePermission = {
  /** Hears the company id whose permission changed; returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /**
   * A permission this app just read or got back from the server. Tells the listeners when it
   * differs from the one read before for that company; the first read only remembers it.
   */
  seen(companyId: string, state: GooglePermissionState): void {
    const key = googlePermissionKey(state)
    const before = lastKey.get(companyId)
    lastKey.set(companyId, key)
    if (before === undefined || before === key) return
    for (const listener of [...listeners]) {
      try {
        listener(companyId)
      } catch (error) {
        console.warn('[google-permission] listener failed:', error)
      }
    }
  },
}
