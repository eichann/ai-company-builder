---
paths:
  - "shared/core/plugin-roles.ts"
  - "server/src/services/plugin-roles.ts"
  - "server/src/db/schema/plugin-roles.ts"
  - "admin/src/app/companies/*/integrations/roles.tsx"
---

# Business roles of a plugin (役割, stage 4a, lane C: C3)

Reserved for C3. Not the connector roles (`connector-roles.md`): these are the people roles a
business plugin declares (e.g. who approves). The company's default assignment is set on the FDE
screen, a group's override lives in the core table with its ledger, and approver rules point at
`role:<name>` — resolved in the approver, the delegate and the engine's who. Write the rules here
as C3 builds them.
