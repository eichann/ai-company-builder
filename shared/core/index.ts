/**
 * shared/core — the rules the server, the desktop app and the admin console
 * must apply identically, in one copy:
 *
 *   paths.ts              path normalisation and keys (NFC + A–Z fold)
 *   names.ts              department / skill folder names, scope paths
 *   permissions.ts        the permission model (resolveAccess, writeAccessSummary)
 *   reserved-paths.ts     private-folder paths reserved in the company repository
 *   instruction-files.ts  CLAUDE.md / CLAUDE.local.md / AGENTS.md / AGENTS.override.md, .claude/rules/*.md
 *   skill-files.ts        .claude/skills|agents|commands, .agents/skills: who may change them
 *   agent-config.ts       what the agents load and run: owner/admin only (default-deny in .claude/, .agents/)
 *   write-access.ts       evaluating GET /me/write-access for a path (the app)
 *   client-version.ts     desktop-app build identity: parsing and ordering
 *   agent-sandbox.ts      the company's AI sandbox setting (「AI の囲い」): shape, validation
 *   key-broker.ts         the API key broker (「API キー」): services, rules, input validation
 *   yaml-lite.ts          the strict YAML subset of type definitions and record files
 *   record-types.ts       type definitions (.acb/types/<name>.md): parse, validate, compare versions
 *   records.ts            record files (id / type / links frontmatter): parse, title, summary, ids
 *   record-ledger.ts      the state engine's ledger and replaying a record at a version
 *   core-types.ts         the core types task and interaction
 *   upstream-path.ts      the one check of a path sent to an outside service (relay, plugins)
 *   plugins.ts            connector plugins: declaration, mapping, field policies, value translation
 *                         (re-exports the plugin-*.ts modules, one per responsibility)
 *   fixed-content.ts      canonical JSON of content a person approves or sends (the server hashes it)
 *   approvals.ts          approval requests: who approves, reasons, the fixed payload
 *   mail.ts               outgoing mail: verified recipients, limits, canonical form
 *   minutes.ts            minutes handed to the AI as outside text; quotes
 *   ai-turn-routes.ts     which AI routes a built-in 「AI の番」 step's token may use (the server's scope)
 *   outside-text.ts       the one standard for outside text in an AI prompt (blocks that cannot be closed, titles)
 *   calendar.ts           the member's own calendar today: event shape, reasons, the day window
 *   business-days.ts      business days: weekends, Japanese public holidays (calculated), company holidays
 *   task-settings.ts      the company's task settings (task list departments, reply 目安, auto-run); replyTarget
 *   features.ts           the company's 「使う機能」: feature switches, defaults, what each owns, their words
 *   turn-timing.ts        which of the member's 「あなたの番」 is this week's (title bar, list, morning summary)
 *   absences.ts           absence and the delegate (代わりの人): the one resolution of who acts for whom today
 *   connector-roles.ts    the core roles (役目) a core connector serves, and resolving which one serves a role
 *   company-folder.ts     a company with or without the shared company folder: its kind, the refusal
 *
 * Dependency rule: nothing here imports anything outside shared/core — no
 * Node built-ins, Electron, React, Hono, database or git (enforced by
 * server/tests/unit/core-purity.test.ts). Callers import the module they need
 * by relative path (the server through its shared/ symlink).
 */
export * from './paths'
export * from './names'
export * from './permissions'
export * from './reserved-paths'
export * from './instruction-files'
export * from './write-access'
export * from './client-version'
export * from './agent-sandbox'
export * from './key-broker'
export * from './yaml-lite'
export * from './record-types'
export * from './records'
export * from './record-ledger'
export * from './core-types'
export * from './upstream-path'
export * from './plugins'
export * from './fixed-content'
export * from './approvals'
export * from './mail'
export * from './minutes'
export * from './calendar'
export * from './business-days'
export * from './task-settings'
export * from './features'
export * from './absences'
export * from './connector-roles'
export * from './company-folder'
