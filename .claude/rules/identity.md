---
paths:
  - "shared/core/identity.ts"
  - "server/src/ports/identities.ts"
  - "server/src/adapters/sqlite/identities.ts"
  - "server/src/services/identities.ts"
  - "server/src/db/schema/identities.ts"
  - "server/src/routes/identities.ts"
  - "server/src/routes/records-ai-identities.ts"
  - "server/tests/unit/identit*.test.ts"
---

# Matching people and companies (名寄せ, stage 3, lane B: B1)

Tells which 相手 an incoming message is about (the inbox, B2), and later the minutes' candidates,
precedent search and the company map. This is the core's **cross-service** layer: one identity
(背番号) gathers the 相手 records — records whose type implements the `counterpart` interface
(`record-types.ts` `INTERFACES`; display name = title, `counterpart_kind`, `domain`, `email`) —
that are the same company or person. The other layer (an outside id ↔ an ACB record, e.g. HubSpot
company #12345 ↔ a 顧客 record) is the business plugin's mapping (`plugins.md`); plugins and
connectors only propose here. No screen until stage 5.

## Rules (`shared/core/identity.ts`, `services/identities.ts`)

- **Automatic, only when certain** (`autoMatch`): the same address (`normalizeEmail`) → the same
  identity; for companies, the same domain → the same company. A company's domain is its `domain`
  field (normalized: lower case, no `@` / `www.` / trailing dot), else its address's domain.
  **Free-mail and carrier domains** (`FREE_MAIL_DOMAINS`, subdomains included: gmail.com,
  yahoo.co.jp, docomo.ne.jp, …) are never a company domain. Persons are never matched by domain.
  Only the same kind (company / person / unstated) is matched. The oldest member wins a tie.
- **Catch-up**: every call first lets live 相手 that are in no identity join one (record id order,
  one transaction). A record keeps the keys it joined with.
- **Anything else is a proposal a person approves.** The AI proposes through its record token
  (`POST /api/records-ai/identities/proposals`, an act token; it can never approve), a person
  through the member route. Both records must be readable 相手 of the same kind, not already one
  identity. The same pending pair returns the existing proposal (`created: false`); a pair once
  rejected is refused (`IDENTITY_REJECTED_BEFORE`). Reason: one line, control characters out,
  ≤ `IDENTITY_REASON_MAX` (300). Approving merges b's identity into a's (every member, readable
  or not); the two named records become `approved`.
- **Split** (undo a match): the record moves to a new identity of its own, `held` — automatic
  matching never takes a held record as a target, so it is not put back; new records with the
  same address join the original identity. Only an approved proposal brings it back. A split
  always makes a new identity, even when the record looks alone (the caller may not see every
  member — answering "already alone" would leak).
- **History** (`identity_history`) is append-only: `joined` (auto, with `how` = new / email /
  domain), `proposed`, `approved`, `rejected`, `split`, with the actor (auto / human / ai).

## No leaks

- Readability is `services/record-access.ts` `recordReader` (folders, private folders, owner-only
  records — owners and admins included). A record the caller cannot read is left out of an
  identity's members, its history and pending proposals, and of address lookups; a proposal with
  one unreadable side does not exist for the caller.
- Naming such a record (view, split, propose) gets exactly the missing record answer (404
  `RECORD_NOT_FOUND`); such a proposal exactly the missing proposal answer (404
  `IDENTITY_PROPOSAL_NOT_FOUND`) — checked before "already decided" (409).
- Answers hold record ids, types and titles of readable records and opaque identity ids; never a
  folder or a private folder's name. Counts are not answered.
- Company: behind the handle (`handle.identities`, four tables with `company_id`); another
  company's records and proposals are missing and unchanged. Records switched off → 404
  `RECORDS_DISABLED` as the records routes.

## API

Member session, `/api/companies/:companyId` (`routes/identities.ts`):
`GET /identities/records/:recordId` (identity view), `POST /identities/records/:recordId/split`,
`GET /identities/proposals` (pending, both sides readable), `POST /identities/proposals`
`{ a, b, reason, confidence? }`, `POST /identities/proposals/:proposalId/approve | reject`. Any
member who can read the records may decide (no role gate).
AI, `/api/records-ai/identities` (`routes/records-ai-identities.ts`, record token):
`POST /proposals` (act), `GET /records/:recordId` (read).
Service only (for B2): `resolveAddress(member, address)` → `{ person, company }` record ids — the
person's identity by address, the company's by the address's domain (never free mail).

## Tests

`server/tests/unit/identities.test.ts` (matching, free mail, kinds, proposals, rejection, split
and held, history, no leaks through private folders and owner-only records, cross-company);
`server/tests/unit/identity-core.test.ts` (free-mail domains however written, proposal bodies);
the permission matrix rows (lane B).

## Not yet

- A record whose `email` / `domain` changes after joining is not re-matched (keys are those it
  joined with); split and propose cover it until then.
- Outside ids without an ACB record, folders (e.g. 顧客/A社 — a private folder's name must never
  leak), and person ↔ company affiliation as stored links: later, with the inbox and plugins.
- Proposal reasons stay in `identity_proposals` (short); the content store and erasure come
  with the screen (stage 5).
