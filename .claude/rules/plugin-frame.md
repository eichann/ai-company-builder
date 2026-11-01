---
paths:
  - "client/shared/plugin-bridge.ts"
  - "client/src/features/plugins/**"
  - "client/electron/features/plugins/protocol.ts"
  - "server/src/routes/plugin-bridge.ts"
  - "server/src/services/plugin-bridge.ts"
  - "shared/types/plugin-bridge.ts"
  - "server/tests/integration/plugin-bridge.test.ts"
  - "client/electron/features/plugins/bridge-ipc.ts"
  - "client/shared/plugin-bridge-ops.ts"
---


# A plugin's screen in a frame and its bridge (stage 4b, lanes A and B: A5 / A6 / B6)

A plugin's `ui/` runs in a frame served by `acb-plugin://` with a CSP that allows no network; it
never reaches `window.electronAPI` or storage. It talks only through a narrow bridge handed over
once; every bridge call is limited to the overlap of the person's permission, what the company
allowed and the operation's own scope (`via`). Approving and sending happen only on the core
app's cards. A5 (this file's first part) built the mechanism; A6 places frames (tab, record
section, file menu); B6 is the server's check.

## The frame: an iframe, not a WebContentsView

`client/src/features/plugins/components/PluginFrame.tsx`: `<iframe sandbox="allow-scripts"
allow="" referrerPolicy="no-referrer">` in the main window. Chosen over a `WebContentsView`
(design 節目5 §2-3): the core app's popups (peek, menus) stay on top, no size syncing, and the
isolation needed holds in an iframe — measured in Electron 45: the frame runs in **its own
renderer process** (site isolation for the custom scheme), its origin is opaque (no
`allow-same-origin`): `localStorage`, `indexedDB`, `document.cookie`, `parent.document`,
`parent.electronAPI` all throw `SecurityError`; the preload runs only in the main frame
(no `nodeIntegrationInSubFrames`), so the frame has no `electronAPI` of its own; popups and top
navigation are refused by the sandbox. Never add `allow-same-origin` (with `allow-scripts` it can
remove its own sandbox), `allow-popups`, `allow-forms`, `allow-top-navigation*` or
`allow-downloads`. Revisit a `WebContentsView` only for third-party plugins.

- **One frame per page.** `PluginFrame` keys the frame by its address; a new plugin or entry
  mounts a new frame. A frame showing a plugin's page navigates nowhere — not even within its
  package (`pluginFrameNavigationAllowed`, wired in `electron-adapter.ts`
  `keepAppPageInWindow` on `will-frame-navigate`); its `window.open` is denied without opening
  the browser; `will-navigate` to `acb-plugin:` is refused.
- **Permissions**: `permission-policy.ts` grants nothing to any page but the app's own, so the
  frame gets no device, clipboard or notification (`ipc-permissions.test.ts`).
- The app's CSP (`client/index.html`) allows `frame-src acb-plugin:`.

## `acb-plugin://<id>/<version>/ui/<file>`

`client/electron/features/plugins/protocol.ts` (no Electron; the shell's `servePluginFiles`
calls `protocol.handle`). The version is the first path segment: `<id>@<version>` in the host
is URL user-info (`acb-plugin://a@1.2.3/` has host `1.2.3`), and a dotted host reads as IPv4.

- Scheme privileges (`registerLocalFileScheme`, one list with `local-file`): `standard`,
  `secure`, `corsEnabled` (module scripts load in CORS mode from the opaque origin; the answer
  says `Access-Control-Allow-Origin: null`). Never `bypassCSP`, `supportFetchAPI`, `stream`,
  `allowServiceWorkers`.
- Served: only a `ui/` file a package may hold (`parsePluginFrameUrl`: no `%` escapes, `\`,
  `..`, user-info, other folders — `plugin.yaml`, `steps/`, `types/` are never served), of a
  package a company of the signed-in account lists now and the store kept
  (`store.ts` `keptPackage`). Everything else is 404.
- **Verified before serving**: the first time a package is served in a run, its whole folder is
  checked against the fingerprint it was kept with (v2: only regular files, no links, only
  package paths). Every answer is the bytes just read, hashed and compared with that listing: a
  file changed after the check is refused and the package is checked again from scratch.
- **CSP on every answer** (`pluginFrameCsp`): `default-src 'none'`, no `connect-src` (fetch,
  XHR, WebSocket, EventSource, beacons refused); `script-src` / `style-src` / `img-src` /
  `font-src` only this version's `ui/` base (not `'self'`, which would cover every version of
  the plugin); inline styles allowed, inline scripts not; `frame-src`, `child-src`,
  `worker-src`, `object-src`, `form-action`, `base-uri` `'none'`. Plus `nosniff`, `no-store`,
  `no-referrer`.

## The bridge (`bridge: 1`)

- **Handed once**: the host (`client/src/features/plugins/bridge-host.ts`) makes one
  `MessageChannel` on the frame's first `load` and posts one end with
  `{ type: 'acb-bridge', bridge: 1 }` (target `*`: the origin is opaque). A second load gets
  nothing. The host reads only that port; nothing listens to the window's `message` events, so
  `parent.postMessage` reaches nothing.
- **Messages**: `{ id, op, args }` and nothing else (`parseBridgeMessage`); answers
  `{ id, ok: true, data } | { id, ok: false, error: { code, message } }`. At most 8 calls in
  flight per frame (`BUSY`).
- **Ops**: the server's `PLUGIN_BRIDGE_OPS` (`shared/types/plugin-bridge.ts`, B6: `records.query`,
  `records.get`, `records.act`, `approvals.request` — asking only, approving is not on the bridge)
  plus `ui.open` (record, file or the record's consultation; opened by the core screen, never sent
  to the server). The app reads each op's arguments with exactly the keys B6's service takes
  (`client/shared/plugin-bridge-ops.ts` `parseBridgeCall`: no actor, provenance, attachments,
  `via` or plugin name). Adding an op is a reasoned, one-at-a-time decision made on both ends
  (reading a linked deliverable's pinned version comes with C7, server first). Not on the
  bridge: files, network, keys, other plugins, approving, sending, running the AI,
  notifications, settings.
- **Main** (`features/plugins/bridge-ipc.ts`, `plugins:bridge`, main window only) reads the call
  again, refuses a package the app does not keep for that company now, and sends B6's
  `PluginBridgeRequest` — `{ pluginId, version, op, args }` — to
  `POST /api/companies/:companyId/plugin-bridge` with the member's session. `pluginId` /
  `version` are the frame the host created: the frame never names itself. Server codes and words
  (`PLUGIN_BRIDGE_REFUSED`, `VERSION_CONFLICT`…) reach the frame as they are; a 5xx or no server
  is a generic `FAILED` / `OFFLINE`. Nothing of a call's arguments or answer is logged.

## Tests

- `client/tests/plugin-frame-protocol.test.ts` — only `ui/` files of a listed, verified
  package; traversal / escapes / other plugin or version refused; a folder or file that no
  longer matches its fingerprint (or a link) never served; the CSP's directives; `keptPackage`.
- `client/tests/plugin-bridge.test.ts` — the app's ops are exactly the server's plus `ui.open`;
  unknown ops and extra keys refused; main sends B6's request with the session and refuses
  before the server (package not kept for the company, `ui.open`, bad args); `PLUGIN_BRIDGE_REFUSED`
  reaches the frame; navigation rule.
- `client/src/features/plugins/bridge-host.test.ts` — port handed once; only bridge ops reach
  main; `ui.open` stays local.
- `client/tests/ui/plugin-frame.spec.ts` (Chromium, page `tests/plugin-frame-ui.html`) — with
  the real CSP and sandbox: fetch / XHR / WebSocket / beacon / outside image reach nothing,
  storage / cookies / `parent.electronAPI` throw, inline and other-version scripts do not run;
  one port; window messages reach nothing. Mutation-checked (CSP `default-src *`, adding
  `allow-same-origin`).
- `ipc-window-links.test.ts` (scheme privileges, frame navigation, popups),
  `ipc-permissions.test.ts` (a plugin page gets no permission).

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
