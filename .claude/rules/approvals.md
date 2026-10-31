---
paths:
  - "shared/core/approvals.ts"
  - "shared/core/fixed-content.ts"
  - "shared/types/approvals.ts"
  - "server/src/services/approvals.ts"
  - "server/src/services/fixed-payloads.ts"
  - "server/src/routes/approvals.ts"
  - "server/src/ports/fixed-payloads.ts"
  - "server/src/adapters/sqlite/fixed-payloads.ts"
  - "server/src/lib/content-hash.ts"
  - "server/tests/integration/approvals.test.ts"
  - "client/shared/approvals.ts"
  - "client/electron/features/approvals/**"
  - "client/src/features/chat/components/ApprovalCard.tsx"
  - "client/src/features/chat/approvalStore.ts"
  - "client/src/features/chat/hooks/useApproval.ts"
  - "client/tests/approval-tools.test.ts"
  - "client/tests/approval-card-ui.tsx"
  - "client/tests/ui/approval-card.spec.ts"
---

# Approval requests with fixed content (承認のお願い, milestone 4 G6)

Owner design 「節目4 議事録・お礼メール・承認」 §1-7, §3-2, §3-4, §4-3, §4-5, §9 q1 / q3, §11. A
plugin operation whose policy is `prior` is not refused: a person approves what the AI (or the
member) asked, and the core runs it. Approving is a person's act through their session only.

## Fixed content (`fixed_payloads`; reused by outbound mail, G8)

- Table `fixed_payloads` (company handle `fixedPayloads`, `ports/fixed-payloads.ts`,
  `HANDLE_TABLES`): `(company_id, owner_kind 'approval' | 'outbound_message', owner_id, version,
  canonical, hash, created_at, body_deleted_at)`, one row per version. **Never rewritten**
  (trigger `fixed_payloads_immutable`, `db/index.ts` `migrateFixedPayloads`): no UPDATE of owner,
  version, hash or time; the text may only be cleared once, together with `body_deleted_at`
  (retention, design §9 q9).
- One hashing helper: `server/src/lib/content-hash.ts` `hashCanonical(text) → 'sha256:<hex>'`
  over the canonical text (`shared/core/fixed-content.ts` `canonicalJson` /
  `approvalPayloadCanonical`; mail brings its own canonical form). The app never hashes.
- `services/fixed-payloads.ts` (`createFixedPayloads`): `fix(companyId, kind, ownerId,
  canonical) → { version, hash } | null` (the next version; run it in the same transaction as the
  owner record), `current`, `currentOf`, `matches(companyId, kind, ownerId, shownHash)` (the hash
  the person was shown must be the newest version's and its text still kept: `changed` /
  `body-deleted` / `bad-hash` / `none`), `clearBodies` (retention).
- A difference of one space is a different content (§4-3, 「最初は甘くしない」).

## Making a request (`services/approvals.ts`)

- The operation routes (person: `routes/plugins.ts`; AI: `routes/records-ai.ts`) call
  `approvals.runOrRequest` / `createOrRequest`: the direct run first; on its `APPROVAL_REQUIRED`
  the request is made → **202** `{ outcome: 'approval-requested', approval: ApprovalView,
  existing }` (contract `shared/types/approvals.ts`). Nothing is sent.
- `prepareApproval` (plugins.md "The approval seam") runs every check and reads HubSpot's raw
  values now; the payload's canonical text is stored as version 1 and the `approval` record created
  by the service writer in **one transaction** (core types ensured first). Fields: requested_by =
  the member, assignee = next_actor = the approver, `approver_rule`, `operation`
  (`<plugin>.<operation>`), `payload_hash`, `payload_version`, `reason` = the AI's (or person's)
  note as the proposed reason; links `about` = the record, `minutes` = the basis (must be a minutes
  record the requester may read, else 400 `BAD_LINK`); folder = the record's. The ledger actor is
  the person or the AI (the credential decides). Title: what changes (「金額の変更」), never a name.
- **The approver is resolved by the server**: `self` → the requester; `dept_manager` → the
  managers of the department holding the folder, the first by id who can read it (any of them may
  approve), else an owner / admin; `admin` → the first owner / admin by id who can read it. Nobody
  → 409 `NO_APPROVER`; the writer refusing a person who cannot read → 400 `APPROVER_CANNOT_READ`
  (never names the place).
- An identical pending request (same payload hash, same requester) is the answer (`existing:
  true`); nothing new is made.
- The AI emergency stop stops the AI's requests (`prepareApproval`, and the token as a whole);
  people's requests and approvals go on.

## Reading

```
GET  /api/companies/:id/approvals?scope=mine|to-me&state=pending|any   session
GET  /api/companies/:id/approvals/:approvalId                          session
GET  /api/records-ai/approvals, /api/records-ai/approvals/:approvalId  record token (read only)
```

- Who reads a request: its requester, the person asked, whoever qualifies to approve it, owners /
  admins — and only while they may read its folder (`recordReader`). Anyone else, and another
  company's id, gets the same 404 `APPROVAL_NOT_FOUND` as a request that does not exist.
- The view: operation label, the record's title, each field before → after (the type's labels and
  `option_labels`, numbers with their % change), the basis (minutes quote; the minutes' title only
  when the viewer may read it), **precedents**, **materials**, the proposed reason, approver and
  rule, `hash` + `version`, `viewerMayApprove`, `viewerIsRequester`, the outcome (who, when, the
  note, the operation id). A create of a record also shows `similar` (`similarDeals`, readable
  records only; design §6-3).
- **Precedents** (design N8, §3-8): earlier approved / sent-back requests of the same company and
  operation sharing a field, whose folder is in the same department; each must be readable by the
  viewer, and so must its `about` record — **the count too** (an unreadable one is neither shown
  nor counted). Newest 5: date, before → after, outcome, reason, and the record's value now.
- **Materials**: the record at the version the request was made on, the minutes — re-checked for
  the viewer every time; an unreadable one is left out (as if it did not exist). Files at a commit
  are not attached yet.
- No list screen (milestone 5): the chat's 「承認待ちを見せて」 uses the AI tools below.

## Approving, sending back, withdrawing (session only)

```
POST /api/companies/:id/approvals/:approvalId/approve     { hash, reason }
POST /api/companies/:id/approvals/:approvalId/send-back   { reason }
POST /api/companies/:id/approvals/:approvalId/withdraw
```

- **No other credential reaches them**: no record-token route (the AI lists and reads only), no
  admin-API or rule route. Tests: `approvals.test.ts` (an AI token on both route sets), the
  permission matrix rows.
- Approve, in order: readable (else 404) → **qualifies** (`mayApprove` with requester / manager of
  the department holding the request's folder / owner-admin, from the server's data; 403
  `NOT_APPROVER`) → `approvalReasonProblem` (400 `REASON_REQUIRED`) → pending (409 `NOT_PENDING`)
  → the hash is the newest version's (409 `CONTENT_CHANGED` 「内容が変わりました。もう一度確かめて
  ください」) → `executeApproved` (plugins.md). **Used once**: approve / send back / withdraw of one
  request are serialised in this server and every state change is a compare-and-set
  (`expectedVersion`) through the service writer.
- Outcome of `executeApproved`:
  - applied → `approved` (`result_operation_id`, the approver's reason as the decision reason,
    the requester told) and a **「決めたこと」** through the decisions service: important, decided
    by the approver, links `approval` + `deal`, the department of the request's folder, title
    「<what changed>を承認」 (no names), key `<approval id>:decision`. When the decisions service
    refuses (the place, a name in the reason → retried once with a neutral `why`), the approval
    stands and only the refusal's code is logged.
  - `CHANGED_OUTSIDE`, `APPROVAL_STALE`, `VERSION_CONFLICT`, `ACCOUNT_CHANGED`, `NOT_LINKED` →
    `stale`, nothing written; 409 with the code, 「HubSpot 側で変わっています。もう一度お願いし直して
    ください」 and the view.
  - a send that failed or whose answer was lost (`WRITE_FAILED` with an operation, or a state
    other than applied) → `failed` with the operation id; **never retried automatically**.
  - anything else (the plugin stopped or off, the requester no longer a member or allowed, the AI
    stopped for an AI's request) → the refusal as is; the request **stays pending** and can be
    approved after a resume.
- Send back: the approver, a reason required → `sent_back`, `next_actor` = the requester (their
  「あなたの番」; `sent_back` is not final in the type's version 2). Withdraw: the requester only,
  while pending or sent back → `withdrawn`.
- Never logged: reasons, values, the payload.

## The app

- The card is the app's own (`client/src/features/chat/components/ApprovalCard.tsx`), never drawn
  by a plugin or the AI's text. The reply holds a reference only — data part `data-approval`
  (`client/shared/approvals.ts` `ApprovalCardRef`), stored with the message as `approvals` — and
  the card reads the request by id with the member's **session** each time it is shown (IPC
  `approvals:get`; `approvalStore.ts` + `hooks/useApproval.ts`, loaded on first subscribe — no
  effect). Members are named from the company's member list (`/members`, in main), never ids.
- Shows: 1,200,000 → 1,500,000（+25%）, 理由（議事録の引用）, 前例 (count + items), 材料, 似ているもの
  (a create), 「AI のまとめ（参考）」, the reason box prefilled with the draft (editable), 「承認」 /
  「差し戻す」 for a viewer who may approve — 「承認」 sends **the hash of the content shown**
  (`approvals:approve`) with 「中身が変わっていないことを確かめて承認します」 — 「取り下げる」 for the
  requester; state lines 「承認待ち：<name>さんにお願いしました」 / 「承認されました。HubSpot の金額も …
  になりました」 / 「差し戻されました：理由」 / 「HubSpot 側で変わっています。…」. No jargon (プラグイン /
  型 / オントロジー / ハッシュ).
- IPC (`client/electron/features/approvals/ipc.ts`, session only): `approvals:get`,
  `approvals:approve`, `approvals:sendBack`, `approvals:withdraw`.
- AI tools (`client/electron/records/tools.ts`, read only, offered when the `approval` type
  exists): `approvals_list { scope?, state? }` and `approvals_show { id }` (puts the card in the
  reply). An operation tool whose answer is `approval-requested` puts the card in the reply
  instead of an operation card, and tells the AI nothing was written and it cannot approve
  (`approvalSummaryForAi`). The update and create tools take an optional `basis { minutesId?,
  quote? }`.

## Not yet

The list screen (「あなたの番」, milestone 5); file materials at a commit; a persisted claim for a
crash between approving and recording the result (today: serialised in this server, CAS on the
version; a create is never re-sent anyway); retention of approval texts (G8 decides for mail).

## Tests

`server/tests/integration/approvals.test.ts` (against the fake HubSpot; each guard
mutation-checked: no AI route and a token is no session, wrong / old hash, no reason, HubSpot
changed → stale, not the requester / not another department's manager, used once → one PATCH,
readers, precedents readable incl. counts (record and request separately), dedupe, AI stop,
retention clears only the text, CROSS), `server/tests/integration/plugin-operations.test.ts`
(prior → 202), permission matrix rows + `CROSS`, `company-scoped-sql.test.ts`,
`client/tests/approval-tools.test.ts`, `client/tests/ui/approval-card.spec.ts` (the shown hash
is sent; no approve button for a non-approver).
