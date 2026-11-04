/**
 * Notification mails of services ACB is connected to (owner FB #18, 2026-11-04;
 * `.claude/rules/inbox.md` "Notification mails of connected services"): the
 * mail intake does not take in a mail a connected service sent to tell about
 * something ACB already gets through its own intake — a Google Meet / Gemini
 * meeting note (the meetings role), a Google Calendar invitation or reminder
 * (the calendar role), a Slack mention / DM digest (the chat role), a
 * business plugin's service notifications. Otherwise the same thing enters
 * twice and the AI makes duplicate tasks.
 *
 * Decided on the server from header facts only (the From address and, where
 * an entry says so, the Sender header: an invitation "via Google Calendar"
 * comes From its organizer with `Sender: calendar-notification@google.com`).
 * Never the body, never the subject.
 *
 * One list per sender: the built-in connectors' senders are here (one place);
 * a connector plugin declares its own (`notification_senders` in its
 * plugin.yaml, plugin-connector-declaration.ts) in the same entry form.
 *
 * Pure: imports only shared/core.
 */
import type { ConnectorRole } from './connector-roles'
import { emailDomain, normalizeEmail } from './mail'

/**
 * One sender entry: a whole address (`notification@slack.com`), or a domain
 * written with a leading `@` (`@notifications.hubspot.com`), which also
 * covers its subdomains. A bare domain is refused: an entry names a
 * machine sender, and a person of that domain must stay a person.
 */
export type NotificationSenderEntry = string

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** The entry as compared (lower case), or null when it is neither an address nor `@domain`. */
export function parseNotificationSender(raw: unknown): NotificationSenderEntry | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s.startsWith('@')) return DOMAIN_RE.test(s.slice(1)) ? s : null
  return normalizeEmail(s)
}

/** Whether a (normalized) address is the entry's address, or of its domain or a subdomain. */
export function senderEntryMatches(entry: NotificationSenderEntry, address: string): boolean {
  if (!entry.startsWith('@')) return address === entry
  const d = emailDomain(address)
  const want = entry.slice(1)
  return d === want || d.endsWith(`.${want}`)
}

/** A connected service whose notification mails are left out, with its senders. */
export interface ConnectedNotifier {
  /** What it is, for the counted log line only (`google_calendar`, `slack`, `plugin:<id>`). */
  service: string
  /** Matched against From. */
  from: readonly NotificationSenderEntry[]
  /** Matched against the Sender header too (a mail sent "via" the service for someone else). */
  sender: readonly NotificationSenderEntry[]
}

/**
 * The built-in connectors' notification senders (checked against real
 * mailboxes, 2026-11): by connector id, each with the core role whose own
 * intake already brings the thing in. `perMember`: only for a member whose
 * own grant of that connector reads (Slack: a member without a grant still
 * learns of mentions only by mail).
 */
export const BUILTIN_NOTIFICATION_SENDERS: Record<string, ReadonlyArray<{
  service: string
  role: ConnectorRole
  /** The role's operation that must resolve to this connector. */
  operation: string
  perMember: boolean
  from: readonly NotificationSenderEntry[]
  sender: readonly NotificationSenderEntry[]
}>> = {
  google: [
    {
      // Invitations, updates, cancellations, replies and reminders. An invitation comes From its
      // organizer "via Google Calendar": the Sender header names the calendar.
      service: 'google_calendar', role: 'calendar', operation: 'read', perMember: false,
      from: ['calendar-notification@google.com'],
      sender: ['calendar-notification@google.com'],
    },
    {
      // Gemini's meeting notes, Meet's own mails (a recording, a transcript, notes ready).
      service: 'google_meet', role: 'meetings', operation: 'read', perMember: false,
      from: ['gemini-notes@google.com', 'meetings-noreply@google.com', 'meet-recordings-noreply@google.com'],
      sender: [],
    },
  ],
  slack: [
    {
      // Mention / DM notification mails ("<workspace>（Slack 経由）"). Not no-reply@slack.com:
      // sign-in codes and account mail are not something the chat intake brings in.
      service: 'slack', role: 'chat', operation: 'receive', perMember: true,
      from: ['notification@slack.com', 'feedback@slack.com'],
      sender: [],
    },
  ],
}

/** The service of the first connected notifier a mail's From (or Sender, where declared) matches, else null. */
export function notificationServiceOf(
  mail: { from: string | null | undefined; sender?: string | null },
  connected: readonly ConnectedNotifier[],
): string | null {
  const from = normalizeEmail(mail.from ?? '')
  const sender = normalizeEmail(mail.sender ?? '')
  for (const n of connected) {
    if (from && n.from.some(e => senderEntryMatches(e, from))) return n.service
    if (sender && n.sender.some(e => senderEntryMatches(e, sender))) return n.service
  }
  return null
}
