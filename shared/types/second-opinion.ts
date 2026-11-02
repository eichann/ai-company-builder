/**
 * 「もう一方の AI に聞く」 as a company setting (owner decision 2026-11-02; chat-and-agents.md
 * "Asking the other AI"): whether a consultation may ask the other AI vendor at all. The server
 * keeps and distributes it; the member's app enforces it (the other AI runs on the member's
 * computer), so the app offers the tool only when its policy says `allowed: true`.
 *
 * - `GET|PUT /api/companies/:companyId/second-opinion` (owner/admin): `SecondOpinionView`;
 *   PUT takes `{ allowed: boolean }`.
 * - `GET /me/agent-policy` → `secondOpinion: SecondOpinionPolicy` (any member).
 */
export interface SecondOpinionPolicy {
  allowed: boolean
}

export interface SecondOpinionView extends SecondOpinionPolicy {
  /** null = never changed (the starting value). */
  updatedAt: string | null
  updatedByName: string | null
}
