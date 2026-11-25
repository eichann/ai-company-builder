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
| `skill-autorun.ts` | the auto-run parts of a Skill's Markdown (`autorunFindingsInText`): the push checker (`rules.ts` `autorunFindings`) and the Skill shelf |
| `skill-shelf.ts` | the server's Skill shelf of a company without the shared folder (`plugins.md` "The Skill shelf"): kinds, names, upload paths, `shelfPlacePath`, `shelfChangeProblems` (the push checker's file rules asked of the place path), `shelfListing` (the version), requests to publish (`SHELF_REQUEST_LIMITS`, `shelfRequestProblems`: what only an owner/admin may publish, refused when a request is sent), `outputLikePaths` (files of a Skill that look like outputs — folders `output(s)` / `result(s)` / `成果物` / `出力` directly in it, a `.pdf` / `.docx` / `.xlsx` / `.pptx` at its top: asked about by the app, refused by the server when publishing or asking; `OUTPUT_FOLDER_NAMES`, `OUTPUT_FILE_EXTENSIONS`) |
| `secret-patterns.ts` | `SECRET_PATTERNS` (`[SECRET_DETECTED]`, re-exported by `rules.ts`), `secretIn` (the Skill shelf, the holding place's contents) and `isSecretFileName` (`.env` / `.env.*` but the templates: the holding place keeps their names only, `private-folders.md`) |
| `agent-config.ts` | what the agents load and run, owner/admin only: the named config (`AGENT_CONFIG_PATTERN`) and the default-deny of the rest of `.claude/` / `.agents/` (`AGENT_FOLDER_PATTERN`): `isAgentConfig`; the push checker builds its bytewise regexes from the patterns |
| `write-access.ts` | `evaluateWrite` (the app's answer from `GET /me/write-access`), `foldScopePaths` (the push check's A–Z-folded pass) |
| `client-version.ts` | desktop-app build identity: `parseClientVersion`, `compareClientVersions` (the server's version gates re-export them from `server/src/lib/client-version.ts`), `ClientBuild` / `clientBuildOf` / `parseClientBuild` / `compareClientBuilds` (the API's parsed build; the admin members page ranks with them) |
| `agent-sandbox.ts` | the company's AI sandbox setting (「AI の囲い」): `AgentSandboxSettings`, the default host list, `normalizeSandboxDomain` / `normalizeDeniedReadPath` / `parseAgentSandboxSettings` (`agent-sandbox.md`) |
| `browser-operation.ts` | the company's browser-operation setting (「ブラウザ操作」, design memo 2026-11-20): `BrowserOperationSettings` (mode off / on, sites: one operated host + exact asset hosts — since plan B a developer setting, the declaration's decide (`agent-browser.md` "Asset hosts") — + level 見るだけ / 入力・保存まで / 削除も), `parseBrowserOperationSettings`, `normalizeBrowserHost` (the sandbox's host rules without `*.`), `levelAllows`, a person's level on a registered site (`BrowserPersonLevel` 使わない / 見るだけ / 変えてよい, default 見るだけ, `browserPersonAllows` capped by the site's level: `agent-browser.md` "Who may use a site"), `decideBrowserRequest` (the browser window's one request rule: HTTPS / WSS on default ports; the operated host any method; asset hosts GET / HEAD of script, stylesheet, font, image only — scripts only from `scriptHosts` when a site carries that list (a company-entered domain); everything else refused), `browserLoginStorage` (login on disk only when the member's sandbox is `enforce`), `browserAiStopped` (which stops stop browser operation: the app's window and the server's plans) |
| `browser-site-parts.ts` | a registered domain's 「詳しい設定」 (`agent-browser.md` "A domain's parts and login helpers"; knows no site): `BrowserSiteParts` (parts hosts, the ones whose scripts load, login helpers), `parseBrowserSiteParts` (exact hosts, never a registered domain, once, a helper never a part, a script host one of the parts hosts, a POST helper framed and ≥ 2 path segments, the declaration's limits and path rule), `validBrowserSiteParts` (re-checked against the registered domains now) |
| `plugin-browser-declaration.ts` | a browser connector's declaration (`browser` in `plugin.yaml`, contract only; `plugins.md` "Browser connectors"): the operated host and exact asset hosts, its login helpers (`login_helpers`: exact host, path prefix, frame / post; the window's rule is the app's), per-site operation types (effect, reviewed checker id, `shared` note, `irreversible`, target / change fields, the only writes, `expect`, `lock`, `delivers`, `facts`), the preview's declared reads (`explore` with an optional exact `query`, `explorePath`, `exploreAddressProblem`), `matchDeclaredWrite` (a request is one declared write with exactly the plan's values), `browserPlanProblem`, `expectedAfter` (the state after the writes, from `expect`), `browserOperationsAllowed` (the declaration against the company's browser setting), `browserFirstVersionProblem` (what the first version of plans runs), `isPlainBrowserText` |
| `browser-plans.ts` | the server's plans of 「ブラウザ操作」 (`agent-browser.md` "Plans, executions, permits and locks"): the fact shape and one value schema per facts version and checker (`BROWSER_FACT_SCHEMAS`, `browserFactsProblem`: required / known / complete / shape / across), `browserLockKey` (canonical JSON of company, host, account, kind, target fields), plan / execution states, `BROWSER_PLAN_TIMES` (1 h, 2 min, 5 s, 30 s, 24 h); since generalization PR 4 the opened lines' plan / execution / write states and `browserObjectLockKey` (a map object's key, byte-equal to `browserLockKey` for the same object) |
| `browser-map.ts` | the read side of a site's map for 「ブラウザ操作」's generalization (`agent-browser.md` "The read-side words"; knows no site): field kinds, things, key uses, `browserMapProblem`, the strict read `readBrowserThing` (every key known, required keys present, the reader's state exactly the map's fields), `BrowserShapeNotice` (no key name) and `BROWSER_SHAPE_WORDS`; since PR 6 html things (no keys; the reader gets the page and the ids asked) and a thing's `writes` / `delivers` (`BROWSER_WRITE_VERBS`, `BROWSER_MAP_DELIVERS`; PR 8: `create_from`'s fields, only of a thing that `delivers: none`) |
| `browser-write-line.ts` | the write part of an opened line (`agent-browser.md` "The write words and the first write line", "Creating on the new path"; knows no site): `browserLineWritesProblem` (only what the map lets, the harmless prefix §4-1, value-named objects, what is added or set is read; since PR 8 `create_from` — a copy with fields set, `{ created }` of an earlier write only), `browserWritesPlanProblem` (an id a copy sets must differ from its original's), `predictBrowserWrites`, `judgeBrowserWrites` (only exactly the prediction is `as_predicted`, created objects included), `browserLineWriteLocks` (the old path's key for the same object; a copy's: its original's root) |
| `browser-read-line.ts` | the read part of an opened line (same section): value kinds, roles and sources (`BROWSER_ROLE_SOURCES`: which / when only from a bound record field or a person's confirmation), the closed check words (`BROWSER_CHECK_WORDS`), `browserReadLineProblem`, `browserLineValuesProblem`, `evaluateBrowserReadLine` (only `ok` is ✓), `dateInText`, `siblingNameKey`, `sourceUnchanged`; since PR 3 the word `changed_from`, a read's `parent`, the must-hold facts applied (account, parent: `agent-browser.md` "The first map and the inspection line") |
| `browser-opened.ts` | the opened list's line (same section): `BrowserOpenedLine`, `browserOpenedLineProblem`, the two hashes' canonical JSON `browserLineMeaning` (a member's grant) / `browserLineMechanics`, the rows of `opened.json` (a row's reviewed `grantsFrom`: whose grants it carries, PR 4) |
| `browser-card.ts` | the one generic card (same section): `BrowserCard` (rows of one value or before / after, ✓ / ✗ / 「読み取れませんでした」, must-hold notes), `buildBrowserReadCard` (unreadable never ✓) |
| `browser-recording.ts` | 「ブラウザ操作」 の記録 (`agent-browser.md` "Recording"; knows no site): the kept forms — `browserAddressPattern`, `browserKeyPattern`, `browserLabel`, `isSensitiveFieldName`, `browserBodyFields`, `browserJsonShape`, the per-recording symbols `createBrowserValueSymbols` (digest injected) —, the server's check `browserRecordingProblem` (every string already in its kept form), `browserRecordingWithout`, the lines' words `browserRecordingLine` |
| `browser-skill.ts` | a company Skill's `browser.yaml` (`agent-browser.md` "A Skill's browser declaration and its approval"; knows no site): `parseBrowserSkillDeclaration` (the strict YAML subset, then exactly its keys, limits, the path grammar with the recording's `{n}` / `{x}` and `{created}` after writing, `_method` only on a POST, no login / CSRF field), `browserSkillDomainProblem` (a registered domain), `browserSkillFrames` (a frozen copy the server builds), `browserSkillWriteLine` |
| `browser-run-log.ts` | the operator's runs of 「ブラウザ操作」 (`agent-browser.md` "The operator's window tools"; knows no site): the actions, outcomes, states and fixed end reasons, `BROWSER_RUN_LIMITS` (the lease, the run's limit), the run id's shape, the log step and `browserRunLogProblem` (the server's check: pages and labels in the recording's kept form, `browser-recording.ts`) |
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
| `minutes.ts` | minutes handed to the AI as outside text (`MINUTES_TEXT_HEADER`), `quoteAppearsIn`; `hasOutsideAttendee` (the stored count: a member's automatic reading and a set watch's `outside_attendee`), `meetingAutoReads` (series choice, then the member's setting: `minutes.md`) |
| `calendar.ts` | 「今日の予定」: the neutral `CalendarEvent`, `CalendarTodayReason`, `dayWindow` (the company's day), `DEFAULT_COMPANY_TIME_ZONE` (`calendar.md`) |
| `manual.ts` | the user manual's built site (`server.md` "The user manual"): page ids, the file-name rule (`isManualFilePath`: `<page>.html`, `manual.css`, `images/<name>.png|jpg|jpeg|webp`, nothing else), `parseManualManifest` (format 1, every path once, sha256, sizes within `MANUAL_LIMITS`), content types — what the server serves and the app copies |
| `ai-turn-routes.ts` | the server's scope of a built-in 「AI の番」 step's record token: `AI_ROUTES` (every AI route), `AI_TURN_STEP_ROUTES` (grants, with `RouteCondition`s), `aiTurnRouteAllowed`, `matchAiRoute` (`ai-turns.md`) |
| `outside-text.ts` | the one standard for outside text handed to an AI: `wrapOutsideText` (header, text with `【】` → `〔〕`, footer: no source can close its block), `neutralizeOutsideText`, `outsideTextFlags` (instruction-like + `wrapper-spoof`), `outsideBracketsNote`, `outsideTitle` (a subject / title quoted on one line of a prompt). Used by contract-3 answers, inbox threads, minutes, Drive, web research and every 「AI の番」 first message |
| `instruction-like.ts` | `findInstructionLikeText` / `INSTRUCTION_LIKE_WORDS`: instruction-like phrases in outside text (web pages, minutes) — a flag, never a filter (`web-research.md`, `minutes.md`) |
| `upstream-path.ts` | `checkUpstreamPath`: the one rule for a path sent to an outside service (the relay's `ACB_BAD_PATH`, plugin declarations) |
| `notification-settle.ts` | which unread notices are settled (片付いた) from the current state of what they tell of: `NOTICE_SETTLE_RULES` (`minutes_arrived`, `job_failed`, `job_expired`, `job_paused`), `noticeSettled` (any other kind never) — the server marks them, the inbox counts them out of あなた待ち (`notifications.md` "Settled notices") |
| `job-words.ts` | scheduled jobs' plain Japanese (trigger, what runs, the grant's lines, missed policy, pause reasons, `waiting`, occurrence states / codes, a slot): the admin's 「定期の仕事」 and the app's 「受け取る」 read one copy (`jobs.md` "The screens") |
| `business-days.ts` | business days: weekends, Japanese public holidays calculated from the law (no network; `LAW_EXCEPTIONS` for year-specific changes), company holidays, `nextBusinessDay` (`tasks.md`) |
| `viewers.ts` | 見られる人: the phrase for who can see a record or a file (`viewersLabel`, `records.md` "Who can see it") |
| `bundle-place.ts` | which department a new 案件・プロジェクト belongs to by default (`defaultBundleFolder`: the creator's 所属; `records.md` "A task and its 案件・プロジェクト") |
| `task-settings.ts` | the company's task settings (`parseTaskSettings`, defaults, `workSwitchPoliciesOf`) and `replyTarget` (返事の目安, Japan time) (`tasks.md`) |
| `jobs.ts` | scheduled jobs (定期の仕事): the strict definition parser `parseJobDefinition` (schema 1: trigger list shapes, check, run, placement e / a, missed, grant in the step tools' words), `jobConsentCanonical` (what the responsible person accepts), the set watch's words and the one list of opened combinations (`JOB_SET_WATCH_WORDS`, `JOB_SET_WATCH_OPENED`, `jobSetWatchOpened`, `parseJobDecisionFile`: schema 5, `jobs.md` "The set watch (schema 5)"), job / occurrence ids (`occ.` + hex, never a record id), occurrence states and outcome codes, `JOB_ACTOR` (`jobs.md`) |
| `job-proposals.ts` | member proposals of a time job (`jobs.md` "Member proposals"): candidate / proposal ids, limits, states, the fixed return reasons and their words, `parseJobCandidateInput` (list values only), `proposalDefinition` (schema 4), `proposalJobName`, `proposalDeliverableFolder`; a set watch from the app (schema 5, 4b-4 PR6b): `parseJobSetWatchCandidateInput`, `setWatchProposalDefinition`, `candidateSchemaOf` |
| `job-schedule.ts` | when a job's occurrences fall, in company time: `jobSlotDates`, `latestJobSlot`, `nextJobSlot` (business days from `business-days.ts`, which also has `previousBusinessDay`) (`jobs.md` "The clock") |
| `features.ts` | the company's 「使う機能」: feature ids, lenient `featuresFrom`, which types / tools / notice kinds each owns, `typeIsViewOnly`, `toolAllowed`, `noticeTurnedOff`, `noticeKindsShown`, the words (`records.md` "Features on and off") |
| `work-switches.ts` | each member's own 受信を読む / AI が自動で進める within the company's (`workSwitchOn`, `chooseWorkSwitch`; `tasks.md`) |
| `absences.ts` | absence and the delegate (代わりの人): `delegation(periods, day)` → `actsFor` / `coverOf` (the one resolution, no chains), `parseAbsenceInput` (`records.md` "Absence and the delegate") |
| `plugins.ts` | connector plugins, the one entry point (re-exports; `plugins.md`): the declaration (`plugin-declaration.ts` shape, `plugin-declaration-rules.ts`, `plugin-manifest.ts` `parsePluginManifest` with `plugin-connector-declaration.ts` / `plugin-business-declaration.ts` / `plugin-call-declaration.ts`, `plugin-call-answer.ts` what is kept of a call's answer), the package (`plugin-package.ts` `validatePluginPackage`, `combineUse`), the mapping (`plugin-mapping.ts` `parsePluginMapping`), field policies (`plugin-policies.ts`: external never auto; `CLOSING_FIELDS` and `closingMoveFields`, `approverFor`), creates, value translation both ways (`plugin-values.ts`), `available_to` |
| `plugin-trust-sshsig.ts`, `plugin-trust-documents.ts`, `plugin-trust.ts`, `plugin-trust-distribution.ts` | plugin trust (`plugin-trust.md`): OpenSSH signatures (ed25519, P-256) with the crypto injected (`PluginTrustCrypto`), strict base64, the root / company list / freshness documents, the root chain and the trust record's state machine (server × company × key generation); P2: what the server hands one company (`companyTrustToServe`) and what the app takes in (`takeCompanyTrust`), the route's answer, file names. Stored and handed out, not enforced yet |
| `company-folder.ts` | a company with or without the shared company folder (`git` / `none`, owner decision 2026-11-07): `parseCompanyFolderKind` (requests), `storedCompanyFolderKind` (only an exact `git` has one), `hasCompanyFolder`, the refusal `NO_COMPANY_FOLDER` (+ its file-link wording) (`server.md` "Companies without a shared folder") |
| `connector-roles.ts` | the core roles (役目) `calendar` / `mail` / `meetings` / `chat` with their operations and optional capabilities (`CONNECTOR_ROLES`; Drive is not a role), `roleServingProblems`, `resolveRole` (the admin's choice when two could serve), `hasRoleCapability` (`connector-roles.md`) |
| `identity.ts` | 名寄せ: a 相手's matching keys (`identityKeysOf`, `normalizeDomain`), `FREE_MAIL_DOMAINS` / `isFreeMailDomain` (never a company domain), `autoMatch` (same address, same company domain, same kind, never a held record), `readIdentityProposal` (`identity.md`) |
| `intake-settings.ts` | 来た連絡: the company's intake settings (`parseIntakeSettings`, defaults), `routeIncoming` (who a new message belongs to: internal / To / CC / shared address / bulk), `companyDomains`, `pollWindow` (7 days read back, the rest a gap) (`inbox.md`) |

The admin console's permission preview (`admin/src/lib/edit-access.ts` `previewAccess`) evaluates
the draft with `resolveAccess` itself, the deciding place as the one scope with rules — no copy.

`shared/types/` holds API contracts (`private-folders.ts`, `company-files.ts`, `agent-events.ts`,
`records.ts`, `plugins.ts`, `task-settings.ts`, `browser-plans.ts`, `private-holding.ts`, `index.ts`).
`shared/browser-connectors/approved.json` is data, not a rule module: the approved browser connector
combinations the server reads (`agent-browser.md`); `opened.json` beside it is the generalization's opened list (site
maps and opened lines, provisional; "The first map and the inspection line"); `carried.json` beside it is the combinations this
app build carries (the app's own, written by the same script).
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
