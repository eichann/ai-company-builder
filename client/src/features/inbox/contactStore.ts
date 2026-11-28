// The inbox's contacts as last read (「連絡」1枚, inbox.md "One contact"): one store per inbox, which the rows (one row per
// contact) and the card read alike, so a press on the card moves its row at once. Memory only; each read and each press
// is bound to the company era it started in (shared/lib/companyEra.ts): an answer that comes back after a company change
// or a sign-out changes nothing on screen. Pure TypeScript (no React): the hook useContacts subscribes.
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
  /** Read each `id@stamp` not read at that stamp yet (a new notice, a card opened). */
  want: (companyId: string, wanted: readonly string[]) => void
  /** Read again now (after a press on the card, answered or not). */
  refresh: (companyId: string, recordId: string) => void
  subscribe: (listener: () => void) => () => void
  /** Every entry now: a new map after each change (what a draw reads, so a memo keyed by it is fresh). */
  snapshot: () => ReadonlyMap<string, ContactEntry>
}

/** A contact's view out of an entry (a row needs only what was shown). */
export const shownView = (e: ContactEntry | undefined): ContactView | undefined => (e?.kind === 'shown' ? e.view : undefined)

export function createContactStore(read: ContactRead, era: EraPort = SCREEN_ERA): ContactStore {
  let entries = new Map<string, ContactEntry>()
  /** The stamp each id was last asked at, and the newest read of it (an older answer landing later never wins). */
  const asked = new Map<string, string>()
  const newest = new Map<string, number>()
  /** The read (its ticket) whose answer each id shows now. */
  const written = new Map<string, number>()
  let company: string | null = null
  let seq = 0
  const listeners = new Set<() => void>()
  const notify = () => { for (const l of [...listeners]) l() }

  const forCompany = (companyId: string) => {
    if (company === companyId) return
    company = companyId
    entries = new Map(); asked.clear(); newest.clear(); written.clear()
  }

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
        if ((written.get(id) ?? 0) > ticket) return
        written.set(id, ticket)
        entries.set(id, entry)
      }
      if (r.success) {
        // One contact answers for its interaction and every 返事のお願い of it: a row keyed by either finds it.
        const shown: ContactEntry = { kind: 'shown', view: r.contact }
        for (const id of [recordId, r.contact.interaction.id, ...r.contact.replyRequests.map(x => x.id)]) put(id, shown)
      } else if (r.gone) put(recordId, { kind: 'gone' })
      // A failure keeps what was shown (offline must not empty the card); only a first read shows the failure.
      else if (!entries.has(recordId)) put(recordId, { kind: 'failed', offline: r.offline, error: r.error })
      notify()
    })
  }

  return {
    entry: id => entries.get(id),
    view: id => shownView(entries.get(id)),
    want(companyId, wanted) {
      forCompany(companyId)
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
