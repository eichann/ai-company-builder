// A notice about moved or removed work must reach the member even when the
// window closes right after the sync (closing waits for it): it is kept on this
// PC until dismissed and shown again at the next launch, for this account and
// company only (it can name a private folder), and goes at sign-out.
import type { SyncNotice } from './model'

type NoticeStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const PREFIX = 'acb.sync.lastingNotice:'

/** Whose notice: the signed-in account in this company. */
export interface NoticeOwner {
  userId: string
  companyId: string
}

const key = ({ userId, companyId }: NoticeOwner) => `${PREFIX}${userId}:${companyId}`

const browserStore = (): Storage | null => {
  try { return localStorage } catch { return null }
}

/**
 * Keep a notice that must not get lost; null: it was dismissed. Other notices
 * leave what is kept alone. A later notice joins a kept `mustSee` one instead of
 * replacing it: the member may not have read it yet. Returns what to show.
 */
export function keepNotice(owner: NoticeOwner, notice: SyncNotice | null, store: NoticeStore | null = browserStore()): SyncNotice | null {
  try {
    if (notice === null) { store?.removeItem(key(owner)); return null }
    if (notice.type !== 'warning' && !notice.backupPath) return notice
    const earlier = keptNotice(owner, store)
    const joined = earlier?.mustSee && !notice.message.includes(earlier.message)
      ? { ...earlier, message: `${earlier.message}\n\n${notice.message}` }
      : notice
    store?.setItem(key(owner), JSON.stringify(joined))
    return joined
  } catch {
    return notice // shown for this session only
  }
}

export function keptNotice(owner: NoticeOwner, store: NoticeStore | null = browserStore()): SyncNotice | null {
  try {
    const value = JSON.parse(store?.getItem(key(owner)) ?? 'null') as Partial<SyncNotice> | null
    if (!value || typeof value.message !== 'string' || (value.type !== 'warning' && value.type !== 'error')) return null
    return {
      type: value.type,
      message: value.message,
      ...(typeof value.backupPath === 'string' ? { backupPath: value.backupPath } : {}),
      ...(value.mustSee === true ? { mustSee: true } : {}),
    }
  } catch {
    return null
  }
}

/** Sign-out: nothing of this account's stays for whoever signs in next. */
export function forgetNotices(userId: string, store: Pick<Storage, 'length' | 'key' | 'removeItem'> | null = browserStore()): void {
  try {
    if (!store) return
    const mine: string[] = []
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i)
      if (name?.startsWith(`${PREFIX}${userId}:`)) mine.push(name)
    }
    for (const name of mine) store.removeItem(name)
  } catch { /* nothing more to do */ }
}
