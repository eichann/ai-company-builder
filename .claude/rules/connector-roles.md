---
paths:
  - "shared/core/connector-roles.ts"
  - "server/src/ports/connector-roles.ts"
  - "server/src/services/connector-roles.ts"
  - "server/tests/unit/connector-roles.test.ts"
---

# The core roles (役目) and which connector serves them (stage 3)

The core app asks a core connector (Google Workspace, Microsoft 365, Slack) for a **role**, never
for a service by name. The four roles, their operations and optional capabilities live in one
place, `shared/core/connector-roles.ts` (`CONNECTOR_ROLES`): `calendar` 予定を読む (read),
`mail` メールを読む・送る (read, send), `meetings` 会議の記録を読む (read; optional `transcript`,
`attendees`), `chat` チャットの連絡を受け取る・返す (receive, reply). Drive is not a role: it is a
Google-specific capability a business plugin uses by name. A connector declares what it serves
(`RoleServing`; `roleServingProblems` refuses unknown roles, operations, capabilities, a role
twice); `services/connector-roles.ts` registers connectors (`RoleConnector`: id, servings,
`usable(companyId)` = set up, on, not operator-stopped; a throw counts as not usable) and
resolves with the pure `resolveRole`: the only usable connector serving the role (and
operation), else the admin's choice for the role among the usable ones
(`ConnectorRoleChoiceRepository`; asked once, only when two exist), else `choice-needed` — never
a guess; a chosen connector that is off is not replaced while two remain; a choice is per
company. An optional capability is asked (`hasRoleCapability`), never assumed. Not wired yet
(B0): `composition/connectors.ts` (S2) creates it, A1 registers Google and adds the choice's
table, A3 registers Slack. Tests: `server/tests/unit/connector-roles.test.ts`.
