/**
 * shared/core — the rules the server, the desktop app and the admin console
 * must apply identically, in one copy:
 *
 *   paths.ts              path normalisation and keys (NFC + A–Z fold)
 *   names.ts              department / skill folder names, scope paths
 *   permissions.ts        the permission model (resolveAccess, writeAccessSummary)
 *   reserved-paths.ts     private-folder paths reserved in the company repository
 *   instruction-files.ts  CLAUDE.md / CLAUDE.local.md / AGENTS.md / AGENTS.override.md
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
 *   fixed-content.ts      canonical JSON of content a person approves or sends (the server hashes it)
 *   approvals.ts          approval requests: who approves, reasons, the fixed payload
 *   mail.ts               outgoing mail: verified recipients, limits, canonical form
 *   minutes.ts            minutes handed to the AI as outside text; quotes
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
