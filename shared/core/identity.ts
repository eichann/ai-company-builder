/**
 * Matching people and companies across services (名寄せ, `.claude/rules/identity.md`,
 * stage 3 B1): the one copy of the keys a 相手 (a record implementing the
 * `counterpart` interface) is matched by and of the automatic rule.
 *
 * - The same mail address is the same 相手 (person or company alike).
 * - The same domain is the same company — never a free-mail domain
 *   (gmail.com, yahoo.co.jp, …): two people writing from Gmail are not one company.
 * - Only records of the same kind (company / person / unstated) are matched.
 * - Anything else is an AI's proposal that a person approves (server).
 *
 * Pure: imports only shared/core.
 */
import { emailDomain, normalizeEmail } from './mail'
import { RECORD_ID_RE } from './records'

export const IDENTITY_KINDS = ['company', 'person'] as const
export type IdentityKind = typeof IDENTITY_KINDS[number]

/**
 * Free-mail and mobile-carrier domains: anyone can have an address there, so
 * the domain says nothing about the company. A subdomain of one counts too.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  // Global
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com',
  'naver.com', 'hanmail.net', 'fastmail.com', 'tutanota.com', 'hey.com',
  // Japan
  'yahoo.co.jp', 'ymail.ne.jp', 'outlook.jp', 'hotmail.co.jp', 'live.jp', 'docomo.ne.jp', 'ezweb.ne.jp', 'au.com',
  'softbank.ne.jp', 'i.softbank.jp', 'disney.ne.jp', 'willcom.com', 'ymobile.ne.jp', 'uqmobile.jp', 'rakuten.jp',
  'nifty.com', 'biglobe.ne.jp', 'ocn.ne.jp', 'so-net.ne.jp', 'excite.co.jp', 'livedoor.com', 'infoseek.jp',
  'goo.jp', 'mail.goo.ne.jp', 'dion.ne.jp', 'plala.or.jp', 'eonet.ne.jp', 'jcom.home.ne.jp', 'zoho.jp',
]

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`)

/** A domain as matching compares it (trimmed, lower case, no leading `@` / `www.`), or null when it is not one. */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let d = raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '')
  if (d.startsWith('www.')) d = d.slice(4)
  return DOMAIN_RE.test(d) ? d : null
}

/** Is this (normalized) domain one anyone can have an address at? */
export function isFreeMailDomain(domain: string): boolean {
  const d = domain.toLowerCase()
  return FREE_MAIL_DOMAINS.some(f => d === f || d.endsWith(`.${f}`))
}

/** What a 相手 is matched by: its kind, its address, and the domain of a company (never a free-mail one). */
export interface IdentityKeys {
  kind: IdentityKind | null
  email: string | null
  domain: string | null
}

/**
 * The keys of a 相手 from its `counterpart` fields. A company's domain is its
 * `domain` field, else its address's domain; a person has no company domain
 * (the person's company is found through the domain of the address, `resolve`).
 */
export function identityKeysOf(fields: { counterpart_kind?: unknown; domain?: unknown; email?: unknown }): IdentityKeys {
  const kind = (IDENTITY_KINDS as readonly unknown[]).includes(fields.counterpart_kind) ? fields.counterpart_kind as IdentityKind : null
  const email = normalizeEmail(fields.email)
  let domain: string | null = null
  if (kind === 'company') {
    domain = normalizeDomain(fields.domain) ?? (email ? emailDomain(email) : null)
    if (domain !== null && isFreeMailDomain(domain)) domain = null
  }
  return { kind, email, domain }
}

/** The domain a mail address speaks for as a company, or null for a free-mail address. */
export function companyDomainOfAddress(email: string): string | null {
  const d = normalizeDomain(emailDomain(email))
  return d !== null && !isFreeMailDomain(d) ? d : null
}

/** A member of an identity as automatic matching sees it. */
export interface MatchCandidate {
  identityId: string
  kind: IdentityKind | null
  email: string | null
  domain: string | null
  /** Split off by a person: never a target of automatic matching. */
  held: boolean
}

export type AutoMatch = { identityId: string; how: 'email' | 'domain' } | null

/**
 * The identity a new 相手 joins automatically, or null (a new identity of its
 * own): the same address first, then the same company domain; same kind only;
 * a member a person split off is never a target. Candidates come oldest first;
 * the first match wins.
 */
export function autoMatch(keys: IdentityKeys, candidates: readonly MatchCandidate[]): AutoMatch {
  const live = candidates.filter(c => !c.held && c.kind === keys.kind)
  if (keys.email !== null) {
    const byEmail = live.find(c => c.email === keys.email)
    if (byEmail) return { identityId: byEmail.identityId, how: 'email' }
  }
  if (keys.kind === 'company' && keys.domain !== null && !isFreeMailDomain(keys.domain)) {
    const byDomain = live.find(c => c.domain === keys.domain)
    if (byDomain) return { identityId: byDomain.identityId, how: 'domain' }
  }
  return null
}

/** How a member came to be in its identity. */
export const IDENTITY_HOWS = ['new', 'email', 'domain', 'approved', 'split'] as const
export type IdentityHow = typeof IDENTITY_HOWS[number]

export const IDENTITY_REASON_MAX = 300

/** An AI's (or a person's) proposal that two 相手 are the same. */
export interface IdentityProposalInput {
  a: string
  b: string
  reason: string
  confidence: number | null
}

/** The proposal in a request body, or what is wrong with it (Japanese, for the caller). */
export function readIdentityProposal(body: unknown): IdentityProposalInput | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return '内容が読めません'
  const v = body as Record<string, unknown>
  if (typeof v.a !== 'string' || !RECORD_ID_RE.test(v.a) || typeof v.b !== 'string' || !RECORD_ID_RE.test(v.b)) return 'a と b には相手の記録の番号を書いてください'
  if (v.a === v.b) return '同じ記録どうしは提案できません'
  if (typeof v.reason !== 'string') return '理由（reason）を書いてください'
  // Control characters out; one line of plain text.
  // eslint-disable-next-line no-control-regex
  const reason = v.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().normalize('NFC')
  if (reason.length === 0) return '理由（reason）を書いてください'
  if (reason.length > IDENTITY_REASON_MAX) return `理由は${IDENTITY_REASON_MAX}文字までです`
  let confidence: number | null = null
  if (v.confidence !== undefined && v.confidence !== null) {
    if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return '確からしさ（confidence）は 0 から 1 の数です'
    confidence = v.confidence
  }
  return { a: v.a, b: v.b, reason, confidence }
}

// ── Answers (the API's shapes; the screen comes in stage 5) ──

export interface IdentityMemberView {
  recordId: string
  type: string
  title: string
  how: IdentityHow
  /** Split off by a person: automatic matching leaves it alone. */
  held: boolean
  joinedAt: string
}

export type IdentityHistoryAction = 'joined' | 'proposed' | 'approved' | 'rejected' | 'split'

export interface IdentityHistoryView {
  at: string
  action: IdentityHistoryAction
  recordId: string
  how: IdentityHow | null
  proposalId: string | null
  actor: { kind: 'auto' | 'human' | 'ai'; userId: string | null }
}

export interface IdentityProposalView {
  id: string
  a: string
  b: string
  reason: string
  confidence: number | null
  proposedBy: { kind: 'human' | 'ai'; userId: string }
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedBy: string | null
  decidedAt: string | null
}

/** One 相手's identity as the caller may see it: only records the caller can read. */
export interface IdentityView {
  identityId: string
  kind: IdentityKind | null
  members: IdentityMemberView[]
  proposals: IdentityProposalView[]
  history: IdentityHistoryView[]
}
