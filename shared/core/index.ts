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
