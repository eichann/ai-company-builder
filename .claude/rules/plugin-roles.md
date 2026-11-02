---
paths:
  - "shared/core/plugin-roles.ts"
  - "server/src/services/plugin-roles.ts"
  - "server/src/db/schema/plugin-roles.ts"
  - "server/src/ports/plugin-roles.ts"
  - "server/src/adapters/sqlite/plugin-roles.ts"
  - "server/tests/integration/plugin-roles.test.ts"
  - "server/tests/unit/plugin-roles.test.ts"
  - "admin/src/app/companies/*/integrations/roles.tsx"
---

# Business roles of a plugin (役割, stage 4a, lane C: C3)

Not the connector roles (`connector-roles.md`): these are the people roles a business plugin
declares (who approves, who closes a 案件). Owner decision (統合版 「役割（段階4a）」): ① the business
plugin declares the roles it needs ② the company (FDE) assigns who holds each ③ the core keeps,
per まとまり, who holds which role. The core roles 本人 (`self`), 部署の管理役 (`dept_manager`), 管理者
(`admin`) stay built in (`CORE_ROLE_LABELS`) and are not assigned here.

## Declaring and naming

- A contract-2 business plugin declares `roles: { <name>: { label, description? } }` (C1,
  `plugins.md` "Contract 2"). A role is named `role:<name>` (`ROLE_NAME_RE`, `roleRefName`):
  in an operation's `who` (C1), in **a type's action `who`** (`record-types.ts` `ROLE_REF_RE`; a
  plugin package may name only roles it declares — `validatePluginPackage`, so contract 1 none),
  and in a mapping's **`approval_by`** (`plugin-mapping.ts`: a declared role or a core rule).
- A role ranks between `dept_manager` and `admin` (`stricterApprover`); two different roles in one
  request need an owner / admin.

## Who holds a role (`services/plugin-roles.ts`, the one resolution)

- Tables (company handle `pluginRoles`, `db/schema/plugin-roles.ts`): `plugin_role_assignments`
  (company × plugin × role → member ids, ≤ 20), `plugin_role_overrides` (+ the まとまり's record id),
  `plugin_role_history` (append-only: an `UPDATE` trigger refuses; `assign` / `override` /
  `clear-override`, the ids, who, when). Member ids only. Not the record ledger (its format is
  unchanged): the history table is the ledger of these changes.
- `holders(company, plugin, role, bundle)`: the まとまり's override when it has one, else the
  company's assignment (`holdersOf`; never merged), only current members. Fails closed: a plugin
  not installed or whose installed version is not on the shelf, an undeclared role, nothing
  assigned → nobody. The plugin's switch does not matter (its types stay the company's).
- `holdsOnRecord(company, type, record, role, user)` (the engine): the plugin = the installed
  business plugin owning the type (one owner per type name); the まとまり = the record when its
  type implements `bundle`, else its `bundle` link.
- Bound once in `composition/plugins.ts` (`recordEngine.useRoles`, `approvals.useRoles`); before
  binding a `role:` entry matches no one.

- Starting value (管理画面の見直し 2-4): a declared role never assigned gets the 部署の管理役 of the
  departments the business plugin is used in, when its first install or first mapping names them
  (`plugins.ts` `seedStartingValues`, history `assign` by the admin who installed). Nothing a company
  assigned is changed; a role assigned `[]` stays nobody.

## Hook points

- **Engine `who`** (`record-engine/act.ts` `mayAct(..., holdsRole)`): `role:<name>` is met by the
  member who holds it on that record.
- **Approvers** (`services/approvals.ts`): `approverFor` may return `role:<name>`; the request is
  asked of the first holder (sorted) for the work's まとまり who can read the place, else an owner /
  admin (`NO_APPROVER` only when nobody can read it). Stored on the approval (core type **version
  5**): `approver_rule: role`, `approver_role: <name>`; the card shows the role's label
  (`ApprovalView.approverRole`). `mayApprove`: a role is met by its holders and owners / admins
  only — a department manager as such does not qualify.
- **Absence** (`actsFor`): no code of its own — the engine and `standing` already ask "does the
  absentee hold it?" for whom a delegate covers, so a delegate stands in for any holder of the
  role (not only the one asked).
- **Operation `who`** (`plugin-operation-checks.ts` `mayRunAt`): `role:<name>` is met by the
  member holding that plugin's role for the operation's record (`holdsForPlugin`: the まとまり's
  override, else the company's; a create of a record not made yet: the company's), or by a
  delegate of an absent holder (`actsFor`, applied in the binding in `composition/plugins.ts`).
- Not yet: the notice `role_unassigned` (reserved in
  `NOTIFICATION_KINDS`) is not sent yet; an unassigned role's approval goes to an owner / admin.

## Routes (`routes/plugins.ts`)

```
GET /api/companies/:companyId/plugins/:pluginId/roles                          owner/admin   PluginRolesView
PUT /api/companies/:companyId/plugins/:pluginId/roles/:role                    owner/admin   { userIds } (this company's members, ≤ 20; [] = nobody)
PUT /api/companies/:companyId/plugins/:pluginId/roles/:role/bundles/:recordId  owner/admin or the まとまり's department manager
                                                                                             { userIds | null } (null: back to the company's)
```

A plugin not installed here (or another company's) is 404 `PLUGIN_NOT_FOUND`; an undeclared role
404 `ROLE_NOT_FOUND`; a まとまり not readable, not a `bundle` or not of this plugin's types 404
`BUNDLE_NOT_FOUND`; ids not of members 400 `ROLE_HOLDERS_INVALID`. Overrides show the まとまり's
title only to a viewer who may read it.

## Admin (`admin/src/app/companies/[id]/integrations/roles.tsx`)

The FDE-facing 「役割」 section of a business on 「つなぎ先」: each declared role by its label with one
checkbox per member and 保存 (sends exactly the chosen ids), 「まだ誰も選ばれていません。」 when
nobody holds it, the まとまり overrides (read only; set from the app later) and the history. No
jargon. A business declaring no role shows nothing.

## Tests

`server/tests/integration/plugin-roles.test.ts` (assignment owner/admin only and members only;
the approval goes to the holder, a non-holding manager cannot approve; a まとまり override wins for
that deal only and only an owner / admin or its manager sets it; an absent holder's delegate;
nobody assigned → an admin; the engine's `role:` action by the holder only),
`server/tests/unit/plugin-roles.test.ts` (`mayApprove` / `stricterApprover` for roles, undeclared
roles refused in a package's types and in `approval_by`), `server/tests/integration/plugin-run-gate.test.ts`
(an operation's `who` with `role:`: company, まとまり override, delegate), `admin/tests/integrations.test.tsx`
「役割」, permission matrix rows + `CROSS`, `company-scoped-sql.test.ts` — each guard
mutation-checked.
