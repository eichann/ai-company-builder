/**
 * API contract of 「返事の下書きを、わたしの書き方に合わせる」 (shared/core/writing-style.ts). The server keeps
 * nothing: it hands a member their own newest sent messages, read now with their own permission, so their PC
 * makes and keeps the summary.
 *
 *   GET /api/companies/:companyId/me/writing-sources                         (session) → WritingSourcesView
 *   GET /api/companies/:companyId/me/writing-sources/:connectorId/samples    (session) → WritingSamplesView
 *     404 WRITING_SOURCE_NOT_FOUND (not a connector serving a role with the capability now),
 *     409 WRITING_SOURCE_NOT_READABLE (no permission / reading turned off), 503 WRITING_SOURCE_UNAVAILABLE
 *
 * A thread read for a reply (`ThreadView.writing`, shared/types/threads.ts) names which summary fits it.
 */
import type { WritingAudience, WritingSample } from '../core/writing-style'

export interface WritingSourceView {
  /** The connector's id (opaque to the core: the key a summary is kept under). */
  connectorId: string
  /** Its name as people know it. */
  label: string
  /** The member's own permission reads their sent messages now (else nothing is offered for it). */
  readable: boolean
}

export interface WritingSourcesView {
  sources: WritingSourceView[]
}

export interface WritingSamplesView {
  connectorId: string
  /** Newest first, at most `WRITING_SAMPLES_MAX`. */
  samples: WritingSample[]
}

/** Which summary fits a reply into a thread: the connector it goes through and whom it goes to. */
export interface WritingStyleKey {
  connectorId: string
  audience: WritingAudience
}
