---
paths:
  - "server/src/services/inbox.ts"
  - "server/src/routes/inbox.ts"
  - "server/src/routes/records-ai-inbox.ts"
  - "shared/core/intake-settings.ts"
  - "shared/types/inbox.ts"
  - "server/src/db/schema/inbox.ts"
---

# Incoming messages (来た連絡, stage 3, lane B)

Reserved for B2 and later. Incoming mail and Slack messages are noticed on the server (Gmail by
the server clock, Slack by its events) through the core roles (`connector-roles.md`), never by a
service name; judging them is the member's PC's AI turn. One interaction per message id per
company, no body stored; the To person is the first owner, CC is never told, what cannot be
decided waits for confirmation, a shared address goes to the department's turn, internal mail
and newsletters are left out (with a 「やることにしなかった一覧」). The fine rules are the
company's intake settings (`intake-settings.ts`), not the core's. Write the rules here as B2
builds them.
