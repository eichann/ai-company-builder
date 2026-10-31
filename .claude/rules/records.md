---
paths:
  - "shared/core/yaml-lite.ts"
  - "shared/core/record-types.ts"
  - "shared/core/records.ts"
  - "shared/types/records.ts"
  - "server/src/routes/records.ts"
  - "server/src/services/records.ts"
  - "server/src/services/record-index.ts"
  - "server/src/services/record-access.ts"
  - "server/src/ports/records.ts"
  - "server/src/ports/record-files.ts"
  - "server/src/adapters/sqlite/records.ts"
  - "server/src/adapters/record-files.ts"
  - "server/src/lib/record-files.ts"
  - "server/tests/unit/record-*.test.ts"
  - "server/tests/integration/records.test.ts"
---

# Records: type definitions and the company map (light ontology, stage 4-1 / 4-2)

The core foundation of the light ontology (owner design 「段4 本体の土台」, decisions 0.18–0.23):
types are defined in files, records are Markdown files (or server-only rows), and the server
keeps the **company map** — an index of every record, its links and its server-sourced state —
answering a fixed-shape query filtered by what the caller may read. The state engine (4-3),
interfaces (4-4), core types (4-5) and typed tools (4-6) build on this; they are not here yet.

## Off per company

Everything is behind a per-company switch (`record_settings.enabled`, default off): owner/admin
turn it on with `PUT /records/settings { enabled: true }`. While off, nothing is indexed (pushes
schedule nothing) and every route except the settings answers 404 `RECORDS_DISABLED`. The one
thing that applies to every company is the push checker's rule on `.acb/types/` (below): nobody
used that folder before, and a type someone added while the switch was off would steer the
engine the day it is turned on.

## Type definitions (`shared/core/record-types.ts`)

- One file per type at `.acb/types/<name>.md` in the company repository (direct children; not
  in private folders' repositories); the definition is the YAML frontmatter, the body is for
  people. Keys are English, `label`s Japanese (0.24-7). YAML is the strict subset of
  `shared/core/yaml-lite.ts`: no anchors, aliases, tags, block scalars, merge keys, duplicate
  keys or prototype keys — every reader (server, push checker, app) gets the same meaning.
- A definition can say only what the engine does (案 B, ontology §17.7): `fields` (kind,
  `source: file | server`), `links` (target type or `file`, cardinality, inverse label),
  `states`, `initial`, `actions` (from / to / who / notify / attach / note / history_line /
  decision / approval / args), `implements` (interfaces, `INTERFACES`: `request` needs
  `requested_by`, `assignee`, `next_actor`, `waiting_on`, `due` on the server), `storage`
  (`file` / `server` / `either`). Any other key is an error — there is no place for an
  expression, computed field, cascade, timer or outside send. `args` name server fields of the
  same kind (an action sets them; nothing is computed).
- Versions (0.18-3): `compareTypeDefinitions` — adding is free but a changed definition needs a
  higher `version`; removing or renaming a field / link / state / action / interface, or
  changing a field's kind / source / target, a link's target / cardinality, or `storage`, is
  **breaking** and refused until a migration tool exists. Every accepted version is kept
  (`record_types`); a record remembers the version it was indexed under.
- Who: only owner/admin change `.acb/types/` (0.23-3), enforced by the push checker
  (`push-check.md`): non-admins get `[PROTECTED_CONFIG]` (own sub-list, existing client
  recovery); a breaking change is refused for owner/admin too (a reason line under the path).
  Deleting a definition file is accepted; the index keeps the definition in force and reports
  `type_file_removed`. Invalid YAML is accepted by the checker and reported by the index (the
  last valid version stays). No screen creates types yet (0.23-4).

## Record files (`shared/core/records.ts`)

- Frontmatter holds only `id`, `type`, `links` (0.3-8): state, assignee, due… live on the server.
  Other keys are ignored and reported (`ignored_keys`), never read — so an AI writing
  `state: done` into a file changes nothing. Title = first `# ` heading (else the file name),
  summary = the first paragraph after it (≤ 300 characters); those two are what text search
  reads (0.23-1).
- Ids: `<type>-<6–32 [0-9a-z]>` (`RECORD_ID_RE`, `newRecordId`). Records name people and
  customers by id, never by name (13.10). Link values are record ids, or company paths for
  links whose target is `file`.

## The company map (server)

Tables (all `company_id`, all behind the company handle `records` — `ports/records.ts`,
`adapters/sqlite/records.ts`): `record_settings`, `record_types`, `records` (index: id, type,
type version, scope id, path or null = server-only, folder, title, summary, removed_at),
`record_links`, `record_state` (state, server fields JSON, version — **not rebuildable**, covered
by the backups; written only by the engine, 4-3), `record_index_heads` (last commit indexed per
repository), `record_index_problems` (for owners/admins). Ids are bound as one JSON array
(`IN (SELECT value FROM json_each(?))`).

### Indexing (`services/record-index.ts`, git in `lib/record-files.ts`)

- After every accepted push over git-http (company or private-folder repository:
  `services.records.afterPush`), when the switch is turned on, and on `POST /records/reindex
  { full: true }`. One run per company at a time; pushes meanwhile fold into one more run. Each
  repository is read from its last indexed commit (`diff-tree`), or in full (`git grep` for files
  with `id:` and `type:` lines, plus `.acb/types/`) the first time or when that commit is gone.
  Files over 1 MB are not records. Never in the request: a failure is logged (`logError`) and the
  next push retries from the last indexed commit. The server's own commits (departments) are
  picked up by the next diff.
- Safety, the only thing the server refuses (4-1); the rest is reported for the app to fix:
  - **id hijack**: a file claiming the id of another live record is not indexed
    (`duplicate_id`; the app gives the copy a new id); a move in the same push keeps the record;
    a removed record comes back when its file does (same repository); a server-only record gets
    its file only from the company repository, inside its folder. A record never crosses into or
    out of a private folder by id (`moved_across_folders`) — except a folder **made public**,
    whose records the company repository adopts at the same path.
  - a record's `type` never changes (`type_changed`).
  - **public → private links** are stored but never shown or followed, for anyone
    (`linkAllowed`): a record outside a private folder never reveals or reaches one inside it.
- A removed file marks the record removed (`removed_at`); its state is kept.

### Reading (`services/records.ts`, `services/record-access.ts`; contract `shared/types/records.ts`)

```
GET|PUT /records/settings          owner/admin
GET     /records/problems          owner/admin (paths may be private: owners/admins read all)
POST    /records/reindex           owner/admin, { full: true }
GET     /records/types             any member: definitions in force + stored versions
POST    /records/query             any member: { type?, implements?, state?, fields?, linkedTo?: { id, hops: 1|2 },
                                   text?, limit ≤ 200, offset ≤ 10000, countOnly? } → { total, records }
GET     /records/item/:recordId    any member: the record + its readable links (both directions)
```

- **No leaks** (0.13-1, 4-2): a record is readable exactly when its file is (`resolveAccess`
  read; inside a private folder also `canReadPrivateScope`), a server-only record when its
  folder is (none = everyone). Answers, `total`, link lists and traversals all apply it, so an
  unreadable private record is identical to a nonexistent one (same 404 body). `total` counts up
  to `MAX_CANDIDATES` (20,000) rows.
- Fixed shape only — no free SQL (0.23-1): type or interface, states, server-field equality (`{
  in: [...] }`), links up to 2 hops (traversal passes only through readable records), substring of
  title / summary. With `type`, field names must be server fields of it.
- Cross-company: the handle is `member.companyId`; another company's record id is a record that
  does not exist (permission matrix `CROSS` row, `tests/unit/record-index.test.ts`).
- The detail route is `/records/item/:recordId`, not `/records/:recordId`: a parameter next to the
  static `/records/settings` etc. made Hono fall back from RegExpRouter to TrieRouter, under which
  `/api/auth/**` stopped matching (the permission matrix's auth rows caught it).

## Not yet (later PRs of milestone 2)

The state engine and ledger (4-3), the `request` interface's "your turn" (4-4), core types
`task` / `interaction` (4-5), typed AI tools / commands and the client wiring (4-6) — including
the chat write guard refusing `.acb/types/` for non-admins and record frontmatter edits (today
only the push checker refuses the former) — the app's id assignment and duplicate repair,
archiving finished tasks (0.6).

## Tests

`server/tests/unit/record-types.test.ts` (YAML subset, definitions, versions, record files),
`server/tests/unit/record-index.test.ts` (hijack, moves, private ↔ public, type versions, read
filtering incl. counts and links, cross-company), `server/tests/integration/records.test.ts`
(switch, full index, a member's push over git-http indexed, `.acb/types/` push rules),
permission matrix rows + `CROSS`.
