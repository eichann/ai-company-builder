// The inbox's contacts as last read (「連絡」1枚, inbox.md "One contact"): one store per inbox, which the rows (one row per
// contact) and the card read alike, so a press on the card moves its row at once. Memory only; each read and each press
// is bound to the company era it started in (shared/lib/companyEra.ts): an answer that comes back after a company change
// or a sign-out changes nothing on screen. One contact's ids (its interaction and each 返事のお願い) are one group: when one
// of them is no longer the member's to read, the whole group goes, so the contact's title is shown by no id of it.
// Pure TypeScript (no React): the hook useContacts subscribes.
import { currentCompanyEra, inEra, type CompanyEra } from '../../shared/lib/companyEra'
import type { ContactReadResult, ContactView } from '../../../shared/contact-card'

export type ContactEntry =
  | { kind: 'shown'; view: ContactView }
  | { kind: 'gone' }
  | { kind: 'failed'; offline: boolean; error: string }

/** The era a read or a press started in, and whether it still holds (injected in tests). */
export interface EraPort { now: () => CompanyEra; holds: (started: CompanyEra) => boolean }
export const SCREEN_ERA: EraPort = { now: currentCompanyEra, holds: inEra }

/** At most this many contacts are read for the rows of one inbox look (the newest notices'). */
export const CONTACT_ROW_READS = 30

export type ContactRead = (companyId: string, recordId: string) => Promise<ContactReadResult>

export interface ContactStore {
  /** What is known of a record (a contact's interaction or one of its 返事のお願い), or undefined (not read yet). */
  entry: (recordId: string) => ContactEntry | undefined
  /** The contact's view for a record id, when one was read. */
  view: (recordId: string) => ContactView | undefined
  /** Read each `id@stamp` not read at that stamp yet (a new notice, a card opened), and each whose last read failed. */
  want: (companyId: string, wanted: readonly string[]) => void
  /** Read again now (after a press on the card, answered or not). */
  refresh: (companyId: string, recordId: string) => void
  subscribe: (listener: () => void) => () => void
  /** Every entry now: a new map after each change (what a draw reads, so a memo keyed by it is fresh). */
  snapshot: () => ReadonlyMap<string, ContactEntry>
}

/** A contact's view out of an entry. */
export const shownView = (e: ContactEntry | undefined): ContactView | undefined => (e?.kind === 'shown' ? e.view : undefined)

/**
 * What a row may use of an entry (`inboxView`'s `ContactsOfRows`): the view, `'gone'` — no row at all, since the notices on
 * screen were read before the server stopped showing it and still carry its title —, or undefined (not read: the notice's row).
 */
export const rowContact = (e: ContactEntry | undefined): ContactView | 'gone' | undefined =>
  (e?.kind === 'shown' ? e.view : e?.kind === 'gone' ? 'gone' : undefined)

/**
 * The notices read again after a contact became not the member's to read: the record ids they name (null: not read).
 * Those ids the server still lists are its to show — their notices' own rows come back (`gone` is lifted); the others stay.
 */
export type NoticesAgain = (companyId: string) => Promise<ReadonlySet<string> | null>

/** A contact's ids that went `gone` together (one 404), the read's era and its mark in `written`. */
interface GoneGroup { companyId: string; started: CompanyEra; ids: readonly string[]; mark: number }

/** `onGone`: a contact became not the member's to read — the notices on screen are older than that and are read again. */
export function createContactStore(read: ContactRead, era: EraPort = SCREEN_ERA, onGone?: NoticesAgain): ContactStore {
  let entries = new Map<string, ContactEntry>()
  /** The stamp each id was last asked at, and the newest read of it (an older answer landing later never wins). */
  const asked = new Map<string, string>()
  const newest = new Map<string, number>()
  /** The read (its ticket) whose answer each id shows now. */
  const written = new Map<string, number>()
  /** Each id's contact group (every id one shown contact answered for; the same set object for all of them). */
  const groups = new Map<string, Set<string>>()
  /** Gone groups whose notices could not be read again yet (offline): asked again at the next `want`. */
  let unlifted: GoneGroup[] = []
  let company: string | null = null
  let seq = 0
  const listeners = new Set<() => void>()
  const notify = () => { for (const l of [...listeners]) l() }

  const forCompany = (companyId: string) => {
    if (company === companyId) return
    company = companyId
    entries = new Map(); asked.clear(); newest.clear(); written.clear(); groups.clear(); unlifted = []
  }

  /** The ids as one group, merged with the groups any of them was in already. */
  const join = (ids: readonly string[]) => {
    const group = new Set<string>()
    for (const id of ids) for (const known of groups.get(id) ?? [id]) group.add(known)
    for (const id of group) groups.set(id, group)
    return group
  }
  /** The ids of `recordId`'s contact as last read (itself alone when none was). */
  const groupOf = (recordId: string): ReadonlySet<string> => groups.get(recordId) ?? new Set([recordId])

  function start(companyId: string, recordId: string) {
    const ticket = ++seq
    newest.set(recordId, ticket)
    const started = era.now()
    void read(companyId, recordId).then(r => r, () => ({ success: false as const, gone: false as const, offline: true, error: '連絡を読めませんでした' })).then(r => {
      if (!era.holds(started) || company !== companyId || newest.get(recordId) !== ticket) return
      entries = new Map(entries)
      // Each id keeps the read that started last: an older read through another id of the same contact (its
      // 返事のお願い, read for a notice before the card's press) never puts back what a newer one replaced.
      const put = (id: string, entry: ContactEntry) => {
        if ((written.get(id) ?? 0) >= ticket) return
        written.set(id, ticket)
        entries.set(id, entry)
      }
      if (r.success) {
        // One contact answers for its interaction and every 返事のお願い of it: a row keyed by either finds it.
        const shown: ContactEntry = { kind: 'shown', view: r.contact }
        for (const id of join([recordId, r.contact.interaction.id, ...r.contact.replyRequests.map(x => x.id)])) put(id, shown)
      } else if (r.gone) {
        // Not the member's to read (or removed): every id of that contact goes — an older view kept under its 返事のお願い
        // would show the title the server no longer shows them —, and no read already on its way may put it back.
        const gone: ContactEntry = { kind: 'gone' }
        const ids = [...groupOf(recordId)]
        const mark = seq
        for (const id of ids) { written.set(id, mark); entries.set(id, gone); groups.delete(id) }
        if (onGone) lift({ companyId, started, ids, mark }, onGone(companyId))
      } else {
        // Not read: asked again the next time the names are (a reconnect, the panel shown again) — never on a timer.
        asked.delete(recordId)
        // A failure keeps what was shown (offline must not empty the card); only a first read shows the failure.
        if (!entries.has(recordId)) put(recordId, { kind: 'failed', offline: r.offline, error: r.error })
      }
      notify()
    })
  }

  /**
   * After the notices were read again: an id of the gone group the server still lists is forgotten (its notice is a plain
   * row again, the server's to show), unless a read since wrote it or the company or era changed. Not read (offline): asked
   * once more at the next `want` (back online, the panel shown again, a new notice) — never on a timer.
   */
  function lift(gone: GoneGroup, again: Promise<ReadonlySet<string> | null>) {
    const { companyId, started, ids, mark } = gone
    void again.then(listed => {
      if (!era.holds(started) || company !== companyId) return
      if (!listed) { unlifted.push(gone); return }
      const back = ids.filter(id => listed.has(id) && entries.get(id)?.kind === 'gone' && written.get(id) === mark)
      if (back.length === 0) return
      entries = new Map(entries)
      for (const id of back) entries.delete(id)
      notify()
    }, () => { if (era.holds(started) && company === companyId) unlifted.push(gone) })
  }

  return {
    entry: id => entries.get(id),
    view: id => shownView(entries.get(id)),
    want(companyId, wanted) {
      forCompany(companyId)
      if (onGone && unlifted.length > 0) for (const gone of unlifted.splice(0)) lift(gone, onGone(companyId))
      for (const w of wanted.slice(0, CONTACT_ROW_READS)) {
        const at = w.lastIndexOf('@')
        const id = at < 0 ? w : w.slice(0, at)
        const stamp = at < 0 ? '' : w.slice(at + 1)
        if (!id || asked.get(id) === stamp) continue
        asked.set(id, stamp)
        start(companyId, id)
      }
    },
    refresh(companyId, recordId) {
      if (company !== companyId) return
      start(companyId, recordId)
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => entries,
  }
}
