---
paths:
  - "shared/core/identity.ts"
  - "server/src/ports/identities.ts"
  - "server/src/adapters/sqlite/identities.ts"
  - "server/src/services/identities.ts"
  - "server/src/db/schema/identities.ts"
---

# Matching people and companies (名寄せ, stage 3, lane B: B1)

Reserved for B1. Tells which customer and which deal an incoming message is about: the same mail
address or domain is linked automatically; anything else is an AI suggestion a person approves,
with history and a way to split a wrong link. The screen comes in stage 5. Write the rules here
as B1 builds them.
