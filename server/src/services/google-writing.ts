/**
 * Gmail's 本人が送った文を読む (`sent_samples` of the role メールを読む・送る; ports/sent-samples.ts): the
 * member's newest mails from their Sent label, each as the text they wrote (the quoted conversation and
 * the forwarded part cut off) with whom it went to, and whether a mail thread's other side is inside the
 * company. Only with the member's own 受信を読む permission (`gmail.readonly`, the `inbox` feature, and both
 * switches of 受信を読む: google-client.ts refuses the call before anything leaves otherwise) — no new
 * permission. Inside = every address of the company's domains (shared/core/intake-settings.ts
 * `companyDomains`: the intake settings' and the members' own, never free mail).
 *
 * Nothing is stored and nothing of a mail is logged (google-mail.ts's action-log lines name the
 * operation only).
 */
import { normalizeEmail } from '../../shared/core/mail'
import { WRITING_SAMPLE_TEXT_MAX, type WritingAudience, type WritingSample } from '../../shared/core/writing-style'
import type { MailReader } from '../ports/mail'
import type { SentSamplesReader, ThreadParty } from '../ports/sent-samples'

/** How far back the Sent label is read (a year: someone who rarely writes still has 20). */
export const SENT_SAMPLES_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000
/** At most this many of the newest sent mails are looked at to find `max` usable ones. */
const LISTED_MAX = 40

export interface GoogleWritingDeps {
  mail: Pick<MailReader, 'listMessages' | 'getMessage'>
  /** The member's 受信を読む works now (the inbox source's `ready`: decided before Google is asked where possible). */
  ready(companyId: string, userId: string): Promise<boolean>
  /** The company's own domains (lower case). */
  internalDomains(companyId: string): readonly string[]
  /** The member's ACB email (lower case) or null. */
  emailOf(companyId: string, userId: string): string | null
  nowMs(): number
}

// Where the member's own words end: the quoted conversation, a forwarded mail, a signature.
const CUT_MARKERS: readonly RegExp[] = [
  /^On .{1,300} wrote:\s*$/m,
  /^\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?.{0,200}(?:書きました|wrote)[:：]?\s*$/m,
  /^.{0,100}(?:さんは|様は).{0,100}書きました[:：]?\s*$/m,
  /^-{2,}\s*(?:Original Message|Forwarded message|転送されたメッセージ|元のメッセージ)\s*-{2,}/im,
  /^(?:From|差出人|送信者)\s*[:：].*\n(?:.*\n){0,3}?(?:Sent|Date|送信日時|日時)\s*[:：]/m,
  /^--\s*$/m,
]

/** The part of a sent mail the member wrote themselves: before any quoted or forwarded part, `>` lines out. */
export function ownWords(text: string): string {
  let end = text.length
  for (const re of CUT_MARKERS) {
    const m = re.exec(text)
    if (m && m.index < end) end = m.index
  }
  // The line introducing the first quoted block (「2026年11月27日(木) 10:00 山田 <…>:」) in whatever wording.
  const lines = text.slice(0, end).split('\n')
  const firstQuote = lines.findIndex(l => /^\s*>/.test(l))
  if (firstQuote > 0) {
    let i = firstQuote - 1
    while (i > 0 && lines[i].trim() === '') i--
    if (/[:：]\s*$/.test(lines[i])) lines.length = i
  }
  const kept = lines.filter(l => !/^\s*>/.test(l)).join('\n')
  const trimmed = kept.replace(/\n{3,}/g, '\n\n').trim()
  return Array.from(trimmed).slice(0, WRITING_SAMPLE_TEXT_MAX).join('')
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1)

/** Inside when every address other than the member's own is of the company's domains; null with none. */
export function audienceOfAddresses(addresses: readonly string[], me: string | null, domains: readonly string[]): WritingAudience | null {
  const others = [...new Set(addresses.map(a => normalizeEmail(a)).filter((a): a is string => a !== null && a !== me))]
  if (others.length === 0) return null
  return others.every(a => domains.includes(domainOf(a))) ? 'inside' : 'outside'
}

export function createGoogleSentSamples(deps: GoogleWritingDeps): SentSamplesReader {
  return {
    readable: (companyId, userId) => deps.ready(companyId, userId),

    async recentSent(companyId, userId, max) {
      const listed = await deps.mail.listMessages(companyId, userId, {
        afterMs: deps.nowMs() - SENT_SAMPLES_LOOKBACK_MS, max: LISTED_MAX, label: 'sent',
      })
      if (!listed.ok) return { ok: false, reason: listed.reason === 'unavailable' || listed.reason === 'not-found' ? 'unavailable' : 'not-allowed' }
      const me = deps.emailOf(companyId, userId)
      const domains = deps.internalDomains(companyId)
      const samples: WritingSample[] = []
      for (const m of listed.value.messages) {
        if (samples.length >= max) break
        // A machine's mail (an auto-reply, a list) is not how the member writes.
        if (m.automated || m.bulk) continue
        const audience = audienceOfAddresses([...m.to, ...m.cc].map(a => a.email), me, domains)
        if (!audience) continue
        const full = await deps.mail.getMessage(companyId, userId, m.id)
        if (!full.ok) {
          if (full.reason === 'not-found') continue
          return { ok: false, reason: full.reason === 'unavailable' ? 'unavailable' : 'not-allowed' }
        }
        const text = ownWords(full.value.text)
        if (Array.from(text).length < 2) continue
        samples.push({ text, at: m.receivedAt, audience })
      }
      return { ok: true, samples }
    },

    audienceOf(companyId, userId, thread: readonly ThreadParty[]) {
      const addresses = thread.flatMap(m => (m.mine ? [...m.to, ...m.cc] : [m.fromAddress ?? '', ...m.to, ...m.cc]))
      return audienceOfAddresses(addresses, deps.emailOf(companyId, userId), deps.internalDomains(companyId))
    },
  }
}
