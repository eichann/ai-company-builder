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
| `paths.ts` | `foldAsciiCase`, `normalizeRepoPath`, `pathKey` (NFC + A–Z fold: naming a place), `diskKey` (Unicode case folding, exactly what APFS does: where a spelling lands), `lookalikeKey` (diskKey over NFKC, without default-ignorables: testing protected names only), `nameKey`, `normalizeReservedPath` (paths/check contract; `\` is a separator), `isSameOrAncestorPath`, `compareScopePaths` |
| `names.ts` | department folder names (`isValidFolderName`, `suggestFolderName`; also private-folder names), skill names (`isValidSkillName`, …), `parseScopePath` (permission API) |
| `permissions.ts` | the permission model: `resolveAccess`, `writeAccessSummary`, `canReadPrivateScope`, `canWriteInPrivateFolder`, `FULL_ACCESS_ROLES`, … `listIncludes` (a members-only record's list in subject form, matched by `applicableRules`, never including a role: records.md "Members-only records"). Rule subjects by precedence on the deciding scope: `user` > `department` (the people who belong to it, 所属: `memberIds` filled by whoever reads the rules — the server's permission store, the push snapshot, the admin console's preview; absent = nobody) and `group` (見える人のまとまり, the members in it; one level with `department`, unioned) > `role` > `everyone`. Gates (`isGate`: a private folder, or a `readRestricted` place of a company without the shared folder) narrow everything inside them; `canReadGate`, `scopesKnownTo` (`server.md` "Groups and read-restricted places") |

| `reserved-paths.ts` | `reservedPrefixOf` / `reservedAncestorOf` (push check `[RESERVED_PATH]`), `isPathUsable` (`POST …/paths/check`); compared as `diskKey`s |
| `instruction-files.ts` | `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` / `AGENTS.override.md` and `.claude/rules/*.md` (`RULES_FILE_PATTERN`): names, who may change them |
| `skill-files.ts` | everything under `.claude/skills|agents|commands` and `.agents/skills` (`SKILL_FOLDERS`, `SKILL_FOLDER_PATTERN`): `isSkillFile`, who may change it (`mayChangeSkillFile`, `skillFileAllowed`, `SkillEditing`) |
| `agent-config.ts` | what the agents load and run, owner/admin only: the named config (`AGENT_CONFIG_PATTERN`) and the default-deny of the rest of `.claude/` / `.agents/` (`AGENT_FOLDER_PATTERN`): `isAgentConfig`; the push checker builds its bytewise regexes from the patterns |
| `write-access.ts` | `evaluateWrite` (the app's answer from `GET /me/write-access`), `foldScopePaths` (the push check's A–Z-folded pass) |
| `client-version.ts` | desktop-app build identity: `parseClientVersion`, `compareClientVersions` (the server's version gates re-export them from `server/src/lib/client-version.ts`), `ClientBuild` / `clientBuildOf` / `parseClientBuild` / `compareClientBuilds` (the API's parsed build; the admin members page ranks with them) |
| `agent-sandbox.ts` | the company's AI sandbox setting (「AI の囲い」): `AgentSandboxSettings`, the default host list, `normalizeSandboxDomain` / `normalizeDeniedReadPath` / `parseAgentSandboxSettings` (`agent-sandbox.md`) |
| `yaml-lite.ts` | the strict YAML subset of type definitions and record files (`parseYamlLite`, `splitFrontmatter`) (`records.md`) |
| `record-types.ts` | type definitions (`.acb/types/<name>.md`): `parseTypeFile`, `compareTypeDefinitions` (breaking changes, versions), `INTERFACES` (`request`, `bundle`), the tags kind's value rule (`normalizeTag` / `normalizeTagsValue` / `parseTagsValue`), who-entries (`linkWhoName`, `linkPersonWho` — `link:<interface link>.<person field>`) and `who_fallback`; the push checker uses it too |
| `records.ts` | record files (`id` / `type` / `links` frontmatter): `parseRecordFile`, title / summary, `RECORD_ID_RE`, `newRecordId`, `appendHistoryLine` |
| `record-ledger.ts` | the state engine's ledger entry shape and `replayRecordState` (a record at version N) |
| `core-types.ts` | the core types `task` and `interaction`, in the definition format |
| `slack.ts` | the Slack connection's member features (`SLACK_FEATURES`), host, callback / events paths, practice values (`isPracticeSlackSecret`) (`slack-connector.md`) |
| `key-broker.ts` | the API key broker (「API キー」): key scopes, service categories and rules, built-in services (+ how each sends its key; HubSpot's read-only POSTs, `brokerRelayReadOnlyAllows`), destination / audience (two dials: `companyKeyUsable`, `upgradeBrokerAudience`) / caps / secret validation, `chooseBrokerKeySource`, token shape and TTL bounds (`key-broker.md`) |
| `fixed-content.ts` | `canonicalJson` (sorted keys, NFC, nothing trimmed): what the server hashes (`sha256:…`) to fix approved / sent content; the app only echoes a hash |
| `approvals.ts` | approval requests: `ApproverRule`, `mayApprove`, `approvalReasonProblem`, `ApprovalPayload` |
| `source-slots.ts` | 出どころ: `resolveSource` (follow-up round → meeting → thread; none — a まとまり alone included — = exempt), `sourceKey` / `parseSourceKey`, `sourceRecordId`; the reader-filtered lookup is the server's `services/source-slots.ts` (`outbound-mail.md` "One send per source", `approvals.md`). Outside acts (a send, a pending create); what an AI makes shared from a source is `source-slot-candidates.ts` |
| `source-slot-candidates.ts` | 出どころの枠 for what an AI makes shared (a meeting's tasks and decisions): `slotQuote` / `slotQuoteKey` (the basis quote, the candidate's identity), `slotTitlesClose` (「似ている案があります」), the words told to the AI and the person; the reader-filtered decision is the server's `services/source-slot-candidates.ts` `decideSlot` (`minutes.md` "Outputs made once"). A sibling of `source-slots.ts`, kept apart for now |

| `mail.ts` | outgoing mail: `VerifiedRecipient` sources, `normalizeEmail` (no header / recipient injection), `mailContentProblems`, `mailContentCanonical`, `countLinks`, attachments (`ATTACHMENT_LIMITS`, `sanitizeAttachmentName`, `looksLikePdf`, `attachmentListProblems`) |
| `minutes.ts` | minutes handed to the AI as outside text (`MINUTES_TEXT_HEADER`), `quoteAppearsIn` |
| `calendar.ts` | 「今日の予定」: the neutral `CalendarEvent`, `CalendarTodayReason`, `dayWindow` (the company's day), `DEFAULT_COMPANY_TIME_ZONE` (`calendar.md`) |
| `ai-turn-routes.ts` | the server's scope of a built-in 「AI の番」 step's record token: `AI_ROUTES` (every AI route), `AI_TURN_STEP_ROUTES` (grants, with `RouteCondition`s), `aiTurnRouteAllowed`, `matchAiRoute` (`ai-turns.md`) |
| `outside-text.ts` | the one standard for outside text handed to an AI: `wrapOutsideText` (header, text with `【】` → `〔〕`, footer: no source can close its block), `neutralizeOutsideText`, `outsideTextFlags` (instruction-like + `wrapper-spoof`), `outsideBracketsNote`, `outsideTitle` (a subject / title quoted on one line of a prompt). Used by contract-3 answers, inbox threads, minutes, Drive, web research and every 「AI の番」 first message |
| `instruction-like.ts` | `findInstructionLikeText` / `INSTRUCTION_LIKE_WORDS`: instruction-like phrases in outside text (web pages, minutes) — a flag, never a filter (`web-research.md`, `minutes.md`) |
| `upstream-path.ts` | `checkUpstreamPath`: the one rule for a path sent to an outside service (the relay's `ACB_BAD_PATH`, plugin declarations) |
| `business-days.ts` | business days: weekends, Japanese public holidays calculated from the law (no network; `LAW_EXCEPTIONS` for year-specific changes), company holidays, `nextBusinessDay` (`tasks.md`) |
| `viewers.ts` | 見られる人: the phrase for who can see a record or a file (`viewersLabel`, `records.md` "Who can see it") |
| `bundle-place.ts` | which department a new 案件・プロジェクト belongs to by default (`defaultBundleFolder`: the creator's 所属; `records.md` "A task and its 案件・プロジェクト") |
| `task-settings.ts` | the company's task settings (`parseTaskSettings`, defaults, `workSwitchPoliciesOf`) and `replyTarget` (返事の目安, Japan time) (`tasks.md`) |
| `features.ts` | the company's 「使う機能」: feature ids, lenient `featuresFrom`, which types / tools / notice kinds each owns, `typeIsViewOnly`, `toolAllowed`, `noticeTurnedOff`, `noticeKindsShown`, the words (`records.md` "Features on and off") |
| `work-switches.ts` | each member's own 受信を読む / AI が自動で進める within the company's (`workSwitchOn`, `chooseWorkSwitch`; `tasks.md`) |
| `absences.ts` | absence and the delegate (代わりの人): `delegation(periods, day)` → `actsFor` / `coverOf` (the one resolution, no chains), `parseAbsenceInput` (`records.md` "Absence and the delegate") |
| `plugins.ts` | connector plugins, the one entry point (re-exports; `plugins.md`): the declaration (`plugin-declaration.ts` shape, `plugin-declaration-rules.ts`, `plugin-manifest.ts` `parsePluginManifest` with `plugin-connector-declaration.ts` / `plugin-business-declaration.ts` / `plugin-call-declaration.ts`, `plugin-call-answer.ts` what is kept of a call's answer), the package (`plugin-package.ts` `validatePluginPackage`, `combineUse`), the mapping (`plugin-mapping.ts` `parsePluginMapping`), field policies (`plugin-policies.ts`: external never auto; `CLOSING_FIELDS` and `closingMoveFields`, `approverFor`), creates, value translation both ways (`plugin-values.ts`), `available_to` |
| `company-folder.ts` | a company with or without the shared company folder (`git` / `none`, owner decision 2026-11-07): `parseCompanyFolderKind` (requests), `storedCompanyFolderKind` (only an exact `git` has one), `hasCompanyFolder`, the refusal `NO_COMPANY_FOLDER` (+ its file-link wording) (`server.md` "Companies without a shared folder") |
| `connector-roles.ts` | the core roles (役目) `calendar` / `mail` / `meetings` / `chat` with their operations and optional capabilities (`CONNECTOR_ROLES`; Drive is not a role), `roleServingProblems`, `resolveRole` (the admin's choice when two could serve), `hasRoleCapability` (`connector-roles.md`) |
| `identity.ts` | 名寄せ: a 相手's matching keys (`identityKeysOf`, `normalizeDomain`), `FREE_MAIL_DOMAINS` / `isFreeMailDomain` (never a company domain), `autoMatch` (same address, same company domain, same kind, never a held record), `readIdentityProposal` (`identity.md`) |
| `intake-settings.ts` | 来た連絡: the company's intake settings (`parseIntakeSettings`, defaults), `routeIncoming` (who a new message belongs to: internal / To / CC / shared address / bulk), `companyDomains`, `pollWindow` (7 days read back, the rest a gap) (`inbox.md`) |

The admin console's permission preview (`admin/src/lib/edit-access.ts` `previewAccess`) evaluates
the draft with `resolveAccess` itself, the deciding place as the one scope with rules — no copy.

`shared/types/` holds API contracts (`private-folders.ts`, `company-files.ts`, `agent-events.ts`,
`records.ts`, `plugins.ts`, `task-settings.ts`, `index.ts`).
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
- The push checker's `foldAsciiCase` / `INSTRUCTION_FILE_RE` / `SKILL_DIR_RE` / `PROTECTED_RE` /
  `AGENT_FOLDER_RE` (`server/src/lib/push-check/rules.ts`) stay bytewise twins over git's latin1
  bytes by design; the regexes are built from the core's name lists and patterns.

## Parity tests (what can still drift is held together by tests, not review)

- `client/tests/rule-parity-write-access.test.ts` — seeded generated companies
  (`RULE_PARITY_SEEDS`, default 600; everyone / role / department / user rules): the chat guard's decision from `/me/write-access` +
  `/me/scopes` + `paths/check` must equal the push gate / `[RESERVED_PATH]` / scope-repository
  gate, and the push gate must not depend on scope order.
- `client/tests/rule-parity-names.test.ts` — path keys, department folder names, skill names and
  AI instruction files and skill files on one corpus, against the core and the push checker's twins; the renderer
  dialogs must import `shared/core/names.ts`.
- `server/tests/integration/admin-contract.test.ts` — every endpoint the admin calls, checked
  against `admin/src/lib/api.ts` with the TypeScript compiler (`tests/helpers/type-shape.ts`).
- `KNOWN_DIFFERENCES` / `KNOWN_MISMATCHES` are empty. A new entry needs a reported reason and must
  keep occurring: fixing it fails the test until the entry is removed.
