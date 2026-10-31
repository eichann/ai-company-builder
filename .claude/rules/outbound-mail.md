---
paths:
  - "shared/core/mail.ts"
  - "shared/types/outbound-mail.ts"
  - "server/src/services/outbound-mail.ts"
  - "server/src/routes/outbound-mail.ts"
  - "server/src/ports/outbound-mail.ts"
  - "server/src/adapters/sqlite/outbound-mail.ts"
  - "server/src/lib/mail-message.ts"
  - "server/src/lib/mail-body-retention.ts"
  - "server/tests/integration/outbound-mail.test.ts"
  - "server/tests/unit/mail-message.test.ts"
  - "client/shared/outbound-mail.ts"
  - "client/electron/features/outbound-mail/**"
  - "client/src/features/chat/components/MailDraftCard.tsx"
  - "client/tests/outbound-mail-tools.test.ts"
  - "client/tests/mail-draft-card-ui.*"
  - "client/tests/ui/mail-draft-card.spec.ts"
---

# Outbound mail (milestone 4 G8: お礼メールを確かめて送る)

The member's AI drafts a mail in the consultation; the app draws the draft as a card; the member
presses 「確かめて送る」, sees everything once more and sends it from their own Gmail. Design 節目4
§1-6, §3-5, §3-7, §4-2 … §4-5, §5-2 (`gmail.send` only), §9 q8 / q9, §11 (no reader AI: the
consultation AI drafts through a tool). Sending reaches outside and cannot be undone, so the
server is the gate: **only a person's session sends, only the version shown, only to addresses
still at their source**.

## Verified recipients (`services/outbound-mail.ts` `collect`)

A draft is about a minutes record and/or a deal record the member may read (a minutes' `deal` link
is taken along). Its recipients come only from, read fresh on every call:

| source | where | label |
|---|---|---|
| `calendar` | the meeting's attendees outside the company's domain (`minutes.meetingAttendees`, the minutes' calendar event re-read from Google with the member's own permission — only for the minutes' assignee or an attendee, `minutes.md`; internal = the Google client's domain + the author's) | カレンダーの参加者 |
| `hubspot` | the deal's contacts: the connector's declared `get` of the deal with `associations=contacts`, then each contact's `get` (`plugin-import.ts` `dealContacts`; object `contact` in the declaration, HubSpot's `email` / `firstname` / `lastname`). Only for a deal the member may read, imported through the current connection, by a member in the connection's read scope (`plugins.readAllowed`). Nothing is stored | HubSpot の連絡先 |
| `member` | the company's members (for CC), the author left out | ACB のメンバー |
| `typed` | an address a **person** typed for this draft (`POST …/recipients`, session only; `normalizeEmail`, a name without line breaks or `<>"`) | あなたが入力 |

Each is offered as a `ref` = `r` + 24 hex of sha256(author | minutes | deal | source | address)
(`typed|<draft>` for typed ones): stable for the draft's context, meaningless elsewhere. A draft
names recipients by ref only; a ref resolves only to an address a source offers now (or one already
in the current version, for an edit that keeps it). The AI's tools take refs only (the schema
refuses an address field), so **an address the AI wrote is never offered** (400
`RECIPIENT_NOT_OFFERED`). A source that cannot be read is reported (`unreadable`) and offers
nothing. 「この宛先に送るのは初めてです」 = an external address whose domain no earlier *sent* mail
of the company went to (`outbound.sentDomains()`).

## Drafts and versions

- Record `outbound_message` (server only, `records.md`), created / changed only through the
  service writer; folder = the deal's (else the minutes') folder; `requested_by` / `assignee` =
  the author; fields `subject`, `payload_hash`, `payload_version`, `channel: email`; links
  `about` (deal), `minutes`.
- Every change is a new version: the canonical content (`mailContentCanonical` — From = the
  member's ACB email, which G3 requires the Google account to be; To / CC addresses, subject,
  body; NFC, `\n`; nothing trimmed) in `fixed_payloads` (owner kind `outbound_message`,
  `services/fixed-payloads.ts` `fix`, its hash), its recipients (ref, address, name, source) in
  `outbound_mail_versions`, the record's fields — in one transaction (all or nothing).
  `mailContentProblems` decides what is refused (400 `MAIL_INVALID` + `problems`). Plain text, no
  attachments.
- Only the author sees or changes a draft: anyone else, another company's id or a missing one
  answer the same 404 `MAIL_NOT_FOUND`. A stale `expectedVersion` → 409 `VERSION_CONFLICT`.

## Sending (`POST /outbound/:id/send { hash }`, a person's session only)

In this order, nothing sent unless all pass:
1. records on, the author's own draft, state `draft` (else 409 `NOT_DRAFT`);
2. the hash equals the current version's (record and fixed payload), else 409 `CONTENT_CHANGED`
   「内容が変わりました。もう一度確かめてください。」 with the current draft;
3. the member's Google grant is active with `gmail.send` (else 409 `GOOGLE_CONSENT_NEEDED`,
   `needsGoogleConsent: 'mail'` — the card offers 「メールを送る許可」 = G3's
   `google:connect(['mail'])`), and its account is the draft's From (else 409 `FROM_CHANGED`);
4. every recipient is still at its source right now (only the sources the version uses are
   read): unreadable → 409 `RECIPIENTS_UNVERIFIABLE` 「…確かめられないため送れません…」;
   gone → 409 `RECIPIENT_GONE` + `goneRefs`;
5. the send row (`outbound_sends`, outcome `sending`) is written **before** Gmail is called — at
   most one live send per draft (`startSend`), else 409 `SEND_IN_PROGRESS`;
6. the RFC 2822 message (`lib/mail-message.ts`: UTF-8, RFC 2047 subject words ≤ 60 characters,
   base64 body, From = the version's, To / Cc from the version; it throws on anything that is not
   one plain address or a subject with a control character — no header injection) →
   `googleClient.request` Gmail `POST /gmail/v1/users/me/messages/send { raw }`, **never retried**
   (G3: writes are not retried; every Google switch is checked there: operator stop, company
   client off, vault, membership, grant, scope);
7. 2xx → record `sent` (`sent_at`, `provider_message_id` = Gmail's id), the retention clock starts,
   and an `interaction` (やりとり) on the deal (`SERVICE_RECEIPT_TYPES`: channel `email`, title /
   summary = subject, counterpart = recipient **domains** only, `source_ref` `gmail:<id>`, folder
   = the deal's). 4xx / 429 / not sent → stays `draft` (409 `SEND_REFUSED` / 503
   `GOOGLE_UNAVAILABLE`). A lost answer or a 5xx → `unknown`
   「届いたか分かりません。Gmail の送信済みを確かめてください。」; ACB cannot read Gmail (no
   `gmail.readonly`), so the person answers `POST …/resolve { sent }`: true → `sent`, false →
   `draft` (sending again is a new 「確かめて送る」).

The AI emergency stop does not block a person's send (design §4-5); the Google stops do. It
does stop the AI's drafting: every record token is refused while the company's AI is stopped
(403 `ACB_STOPPED`, `records.md`).
`POST …/discard` (draft / unknown → `discarded`) is the person's too.

## Retention (§9 q9)

`cleanupBodies` at startup + every 24 h (`lib/mail-body-retention.ts`, one run per server, each
company through its handle): a mail `sent` or `discarded` more than 30 days ago loses its body —
the fixed payloads' canonical text (`clearBodies`); the hash, recipients, subject, Gmail id, state
and ledger stay. The view says `bodyDeleted`.

## Routes (contract `shared/types/outbound-mail.ts`)

```
/api/companies/:companyId (session)        /api/records-ai (record token)
POST /outbound-recipients                  POST /outbound-recipients   (read; mail_recipients)
POST /outbound                             POST /outbound              (act; mail_draft_create)
GET|PUT /outbound/:messageId               GET /outbound/:messageId (read), PUT (act; mail_draft_update)
GET|POST /outbound/:messageId/recipients   —
POST /outbound/:messageId/send             —   (no route: the AI cannot send)
POST /outbound/:messageId/resolve          —
POST /outbound/:messageId/discard          —
```

`/outbound-recipients`, not `/outbound/recipients`: a static segment next to `:messageId` makes
Hono change routers (`records.md`). Permission matrix rows + `CROSS` for every `:messageId` route.

## The app

- Tools on `acb_records` (where the type `outbound_message` exists): `mail_recipients` (read,
  Codex too) and, with an act token, `mail_draft_create` / `mail_draft_update`; there is no send
  tool. The AI is told the draft is NOT sent (`aiMailSummary`, `RECORDS_INSTRUCTIONS`).
- A draft becomes the data part `data-mail-draft` (`MailDraftCard`, stored with the message as
  `mailDrafts`), drawn by `src/features/chat/components/MailDraftCard.tsx`: From, To / CC with
  each source's label, subject, the **whole** body, 「本文にリンクが N つあります」,
  「この宛先に送るのは初めてです」, 直す (a new version), 「確かめて送る」 → a confirm step showing
  everything again with 「中身が変わっていないことを確かめて送ります」 → send with the hash shown;
  states sent / unknown (送られていた／送られていなかった) / discarded. No ハッシュ / OAuth on screen.
- IPC (main, the session stays there): `outboundMail:get`, `:recipients`, `:update`,
  `:addRecipient`, `:send`, `:resolve`, `:discard` (`client/electron/features/outbound-mail/ipc.ts`;
  ids and hashes checked before anything leaves).

## Logs

Never a subject, body or address: ids and fixed words only (`logError`). Test: the integration
test greps every log line.

## Tests (each guard mutation-checked)

`server/tests/integration/outbound-mail.test.ts` against the fake Google and fake HubSpot: an AI
token reaches no send / resolve / discard / typed path and the session routes refuse it; an
address not from a source (or as a ref) refused; old / malformed hash → nothing sent; no consent
→ `needsGoogleConsent`; header injection through subject or a typed address refused; another
company's / member's draft → the same 404, nothing changed; an attendee removed from the calendar
→ not sent; HubSpot unreadable → not sent; the send (From, To, Cc, subject, body as written; the
interaction with domains only); a lost answer → `unknown`, exactly one mail, no resend, resolve;
no token in any answer, log or table, no content in logs; retention with a fake clock.
`server/tests/unit/mail-message.test.ts` (encoding, no header injection).
`client/tests/outbound-mail-tools.test.ts` (tools, refs only, token not session, the card stored,
the send with the session and the shown hash). `client/tests/ui/mail-draft-card.spec.ts` (sources
shown, confirm step, the shown hash sent). Permission matrix + `CROSS`, `company-scoped-sql.test.ts`.
