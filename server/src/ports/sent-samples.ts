/**
 * The optional role capability 本人が送った文を読む (`sent_samples` of the roles `mail` and `chat`,
 * shared/core/connector-roles.ts): what a connector gives the core for 「返事の下書きを、わたしの書き方に
 * 合わせる」 (shared/core/writing-style.ts). Provider-neutral: the core asks the connector that serves the
 * role, never a service by name; each connector implements it in its own module and registers it under its id.
 *
 * Two operations, both with the member's own permission and only while the role's reading is on for them:
 * the member's newest sent messages in one fixed shape, and whether a thread's other side is inside the
 * company or not. Nothing is stored and nothing of a message is logged: the text goes to the member's PC,
 * which keeps only a summary.
 */
import type { WritingAudience, WritingSample } from '../../shared/core/writing-style'

export type SentSamplesFailure = 'not-allowed' | 'unavailable'
export type SentSamplesRead = { ok: true; samples: WritingSample[] } | { ok: false; reason: SentSamplesFailure }

/** One message of a thread as the core read it (the role's thread), for telling 身内 from よそ. */
export interface ThreadParty {
  /** The member wrote it. */
  mine: boolean
  /** Mail: the sender's address (lower case); chat: null. */
  fromAddress: string | null
  /** Mail: To / CC addresses. */
  to: readonly string[]
  cc: readonly string[]
  /** Chat: the sender is of another organisation (a shared channel's guest); absent = not known. */
  external?: boolean
}

export interface SentSamplesReader {
  /** Whether the member's own permission lets this read now (decided locally where possible). */
  readable(companyId: string, userId: string): Promise<boolean>
  /** The member's newest sent messages (newest first, at most `max`), each with whom it went to. */
  recentSent(companyId: string, userId: string, max: number): Promise<SentSamplesRead>
  /** Whether the other side of a thread is all inside the company; null when it cannot tell. */
  audienceOf(companyId: string, userId: string, thread: readonly ThreadParty[]): WritingAudience | null
}
