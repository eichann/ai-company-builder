---
paths:
  - "client/shared/plugin-bridge.ts"
  - "client/src/features/plugins/**"
  - "client/electron/features/plugins/protocol.ts"
  - "server/src/routes/plugin-bridge.ts"
  - "server/src/services/plugin-bridge.ts"
  - "shared/types/plugin-bridge.ts"
  - "server/tests/integration/plugin-bridge.test.ts"
---

# A plugin's screen in a frame and its bridge (stage 4b, lanes A and B: A5 / A6 / B6)

Reserved for A5, A6 and B6. A plugin's `ui/` runs in a frame served by `acb-plugin://` with a CSP
that allows no network; it never reaches `window.electronAPI` or storage. It talks only through
a narrow bridge handed over once; every bridge call is limited to the overlap of the person's
permission, what the company allowed and the operation's own scope (`via`). Approving and sending
happen only on the core app's cards. Write the rules here as these items are built.

## The server end (B6 「橋の関所」, `services/plugin-bridge.ts`)

```
POST /api/companies/:companyId/plugin-bridge   { pluginId, version, op, args }   the member's session
```

Contract: `shared/types/plugin-bridge.ts` (`PluginBridgeRequest`, `PLUGIN_BRIDGE_OPS`,
`PLUGIN_BRIDGE_REFUSED`). The app's main process (A5) sends each call for the frame with the
member's session; `pluginId` / `version` are the package it opened the frame from. Route guards:
`companyMember` + `body(zod)` (another shape → 400 fixed text; non-members 404).

| op | args | answer |
|---|---|---|
| `records.query` | `{ type, state?, fields?, linkedTo?, link?, sort?, text?, limit?, offset?, countOnly? }` | 200 `RecordQueryResult` |
| `records.get` | `{ recordId }` | 200 `RecordDetail`, links only to records of the plugin's types (no file links) |
| `records.act` | `{ recordId, action, expectedVersion, note?, args?, links?, decision? }` | 200 `{ record, entry }` |
| `approvals.request` | `{ recordId: string \| null, operation, input }` (`input` = the operation's body) | 202 `{ outcome: 'approval-requested', approval, existing }` |

A call passes only in the overlap of three things:

1. **The company's grant**: the version is one `pluginsFor` lists now (contract-2 business plugin,
   turned on, on the shelf for this company, not stopped by the operator, the chosen fingerprint
   — the same list the app keeps packages by, pins included) and its package declares `ui` with
   `bridge: 1` (`PLUGIN_BRIDGE_VERSION`).
2. **The operation's scope**: only records of the plugin's own `types` (no `implements`, no files);
   an action only where its type says `via: [… plugin …]`; a plugin operation only where the
   business plugin's use says `via: [… plugin …]` (in the frame's version, and again in the
   installed one by the operation checks) and **only as an approval request** — there is no
   direct run, so money fields and `prior` writes can only be asked (`prepareApproval` refuses
   `APPROVAL_NOT_NEEDED` for an all-`auto` write). Approving, sending back and sending stay on the
   core's cards (`approvals.md`, `outbound-mail.md`).
3. **The person's rights**: every call runs as the member (actor `human`) through the core's own
   services — read filters, `who`, `expectedVersion`, the step gate.

The bridge's own refusals are **one answer**, 403 `PLUGIN_BRIDGE_REFUSED`
「この画面からはできない操作です」: another company's plugin, one off or stopped, a version without a
screen, an op's key the bridge does not take, a type that is not the plugin's, a record the person
cannot read or that does not exist, an action or operation without `plugin` in `via` (the engine's
`NOT_VIA` and a missing action / operation are mapped to it). After the bridge let a call through,
the service's own refusal answers (`VERSION_CONFLICT`, `NOT_ALLOWED`…): the person may see that
record anyway.

**Ledger**: the actor carries `via: { plugin, version }` (set by the bridge service only; a body's
`via` is never read). `record_ledger.via` (JSON, `db/schema/plugin-bridge.ts`) keeps it on the
action's entry and on an approval request's first entry; `ledgerCause` answers `plugin` for a
person's entry with `via` (`person` without) — the person's authority, the plugin's button.

## `via`: where an action or operation may be called from (plan §5-13)

`shared/core/record-types.ts` `ACTION_VIA` = `screen` (the core's screens and the member's
consultation) / `plugin` (a plugin's screen) / `run` (an automated run, S10b). A type's action and
a contract-2 business plugin's operation use may say `via: [...]`; absent = `[screen, run]`
(`DEFAULT_ACTION_VIA`), so nothing existing changed. `plugin` on an action with `approval: prior`
is refused by the parser and by the engine. Enforced for every caller: the engine's `act`
(`callVia(actor)`, 403 `NOT_VIA`) and the plugin operation checks (`recordChecks` /
`newRecordChecks`, after the step gate).

Tests: `server/tests/integration/plugin-bridge.test.ts` (grant: listed version, screen, off,
stopped, other company; scope: types, action `via`, operation `via` and request-only; `who`; the
ledger's `via` and cause, a forged body ignored; `via` for the core's screens and runs),
`plugin-run-gate.test.ts` "an operation's via", `tests/unit/record-types.test.ts` and
`plugin-contract-v2.test.ts` (syntax) — each guard mutation-checked.
