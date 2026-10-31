---
paths:
  - "shared/**"
  - "client/shared/write-access.ts"
  - "client/shared/sparse-paths.ts"
  - "server/src/lib/push-check/rules.ts"
  - "admin/src/lib/**"
  - "client/tests/rule-parity-*.test.ts"
  - "server/tests/unit/core-purity.test.ts"
  - "server/tests/integration/admin-contract.test.ts"
  - "server/tests/helpers/type-shape.ts"
---

# Shared rules (`shared/core`) and the tests that keep copies in agreement

The rules the server, the desktop app and the admin console must apply identically live in ONE
copy under `shared/core/`. Change a rule there (and its bytewise twin in the push checker, below,
in the same PR). Full text: `docs/architecture/shared-core.md` (internal).

## Purity

`shared/core` is pure TypeScript: its modules import only each other — no Node built-ins,
packages, Electron, React, Hono, database or git — so it can run in the renderer, main process,
server, push checker and admin alike. `server/tests/unit/core-purity.test.ts` enforces it.

| Module | Rules |
|---|---|
| `paths.ts` | `foldAsciiCase`, `normalizeRepoPath`, `pathKey` (NFC + A–Z fold), `nameKey`, `normalizeReservedPath` (paths/check contract; `\` is a separator), `isSameOrAncestorPath`, `compareScopePaths` |
| `names.ts` | department folder names (`isValidFolderName`, `suggestFolderName`; also private-folder names), skill names (`isValidSkillName`, …), `parseScopePath` (permission API) |
| `permissions.ts` | the permission model: `resolveAccess`, `writeAccessSummary`, `canReadPrivateScope`, `canWriteInPrivateFolder`, `FULL_ACCESS_ROLES`, … |
| `reserved-paths.ts` | `reservedPrefixOf` / `reservedAncestorOf` (push check `[RESERVED_PATH]`), `isPathUsable` (`POST …/paths/check`) |
| `instruction-files.ts` | `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` / `AGENTS.override.md`: names, who may change them |
| `write-access.ts` | `evaluateWrite` (the app's answer from `GET /me/write-access`), `foldScopePaths` (the push check's A–Z-folded pass) |
| `client-version.ts` | desktop-app build identity: `parseClientVersion`, `compareClientVersions` (the server's version gates re-export them from `server/src/lib/client-version.ts`), `ClientBuild` / `clientBuildOf` / `parseClientBuild` / `compareClientBuilds` (the API's parsed build; the admin members page ranks with them) |
| `agent-sandbox.ts` | the company's AI sandbox setting (「AI の囲い」): `AgentSandboxSettings`, the default host list, `normalizeSandboxDomain` / `normalizeDeniedReadPath` / `parseAgentSandboxSettings` (`agent-sandbox.md`) |
| `yaml-lite.ts` | the strict YAML subset of type definitions and record files (`parseYamlLite`, `splitFrontmatter`) (`records.md`) |
| `record-types.ts` | type definitions (`.acb/types/<name>.md`): `parseTypeFile`, `compareTypeDefinitions` (breaking changes, versions), `INTERFACES`; the push checker uses it too |
| `records.ts` | record files (`id` / `type` / `links` frontmatter): `parseRecordFile`, title / summary, `RECORD_ID_RE`, `newRecordId` |
| `key-broker.ts` | the API key broker (「API キー」): key scopes, service categories and rules, built-in services (+ how each sends its key), destination / audience (two dials: `companyKeyUsable`, `upgradeBrokerAudience`) / caps / secret validation, `chooseBrokerKeySource`, token shape and TTL bounds (`key-broker.md`) |

The admin console's permission preview (`admin/src/lib/edit-access.ts` `previewAccess`) evaluates
the draft with `resolveAccess` itself, the deciding place as the one scope with rules — no copy.

`shared/types/` holds API contracts (`private-folders.ts`, `company-files.ts`, `agent-events.ts`,
`records.ts`, `index.ts`).
`shared/package.json` is `"type": "module"` so tsx sees named exports.

## Naming rules (`names.ts`)

- Department folder names allow Japanese (hiragana, katakana, kanji) and ASCII:
  `/^[\w぀-ゟ゠-ヿ一-鿿][\w぀-ゟ゠-ヿ一-鿿._-]*$/`.
- Skill folder/file names stay ASCII: `/^[a-z0-9][a-z0-9_-]*$/`.
- Renderer dialogs must import these from `shared/core/names.ts` (checked from their source by
  the names parity test), not re-declare them.

## How each package imports it

- Server: through its `server/shared` symlink (`/app/shared` in the image), e.g.
  `import … from '../../shared/core/permissions'`.
- App (main process, preload, renderer): directly by relative path; `client/shared/write-access.ts`
  and `client/shared/sparse-paths.ts` re-export what they used to define; Vite bundles it.
- Admin: from `admin/src/lib`; its Dockerfile copies `shared/` into the build stage; Turbopack's
  root is the repository (`outputFileTracingRoot`).
- The push checker's `foldAsciiCase` / `INSTRUCTION_FILE_RE` (`server/src/lib/push-check/rules.ts`)
  stay bytewise twins over git's latin1 bytes by design; the regex is built from the core's name
  list.

## Parity tests (what can still drift is held together by tests, not review)

- `client/tests/rule-parity-write-access.test.ts` — seeded generated companies
  (`RULE_PARITY_SEEDS`, default 600): the chat guard's decision from `/me/write-access` +
  `/me/scopes` + `paths/check` must equal the push gate / `[RESERVED_PATH]` / scope-repository
  gate, and the push gate must not depend on scope order.
- `client/tests/rule-parity-names.test.ts` — path keys, department folder names, skill names and
  AI instruction files on one corpus, against the core and the push checker's twins; the renderer
  dialogs must import `shared/core/names.ts`.
- `server/tests/integration/admin-contract.test.ts` — every endpoint the admin calls, checked
  against `admin/src/lib/api.ts` with the TypeScript compiler (`tests/helpers/type-shape.ts`).
- `KNOWN_DIFFERENCES` / `KNOWN_MISMATCHES` are empty. A new entry needs a reported reason and must
  keep occurring: fixing it fails the test until the entry is removed.
