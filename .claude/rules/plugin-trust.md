---
paths:
  - "shared/core/plugin-trust*.ts"
  - "client/electron/features/plugins/trust*.ts"
  - "client/electron/features/plugins/trust-roots/**"
  - "client/tests/plugin-trust*.test.ts"
  - "client/tests/fixtures/plugin-trust/**"
  - "client/scripts/plugin-trust-*.ts"
  - "client/scripts/check-trust-root.ts"
  - "client/scripts/before-pack.mjs"
  - "server/src/**/plugin-trust*.ts"
  - "server/tests/**/plugin-trust*.test.ts"
---

# Plugin trust: signed lists of the code a package may carry (P1 format and verification, P2 storage and distribution)

Design: 署名の検証の設計 v3 + v3.1 (owner decisions 2026-11-21; internal). Goal: on a new app, code
a package carries (`ui/`, `checkers/`, `steps/`, the declaration — every file) runs only when div
signed **that company's list** with that fingerprint in it — even if the server is taken over.

## What P1 and P2 provide — and what they do not yet

- **Provides**: the signed documents' shapes, OpenSSH signature (SSHSIG) verification, the root
  chain, the acceptance rules for a company's list and its freshness document, and the trust
  record's state machine — pure functions in `shared/core/` over an injected clock (`now`) and
  injected crypto, plus the app's `node:crypto` adapter and the tests.
- **P2 provides** (section "P2" below): the app's trust record on disk, the root each build
  carries (and the release build's check of the production root: a warning until the switch), the server reading
  `PLUGINS_DIR/trust/` and handing each company only its own documents, and the owner's and
  operator's tools (`sign-targets` and the rest).
- **Does not do yet**: **no enforcement** — no package is refused, hidden or stopped because of
  trust (P3 shelf, P4 the app's one gate / frozen copy / `acb-plugin://<ref>`, P5 the isolated
  checker runtime). Packages keep running exactly as before; `signature.yaml` (`plugins.md`
  "Signature slot") stays shape-only and is not part of this.

## Modules (`shared/core`, pure: no Node built-ins — `core-purity.test.ts`)

| Module | What |
|---|---|
| `plugin-trust-sshsig.ts` | `PluginTrustCrypto` (the port: `sha256`, `sha512`, `verify(type, key, data, sig)` never throws), strict base64 (`decodeBase64Strict`: the one canonical spelling), OpenSSH public keys (`decodeSshPublicKey`, `parseRootKey`; ed25519 32 bytes, P-256 uncompressed point **on the curve**, `isP256Point` with BigInt), `parseSshSig` (armored, magic, version 1, empty reserved, sha256/sha512, signature type = key type, ECDSA mpints → r ‖ s), `sshSigSignedData`, `verifySshSig` (namespace and key must match) |
| `plugin-trust-documents.ts` | `PLUGIN_TRUST_POLICY` (10 min skew, list ≤ 90 days, freshness ≤ 3 days, version step ≤ 1000, root threshold ≥ 2, envelope limits), namespaces `acb-root-v1` / `acb-targets-v1` / `acb-freshness-v1`, `ROLE_KEY_TYPES`, refusal codes, `openEnvelope` (threshold counted **by distinct decoded key**), `parseRoot`, `parseTargets`, `parseFreshness` (all closed shapes), `roleGeneration` |
| `plugin-trust.ts` | `bakedRoot`, `stepRoot`, `startTrust`, `serializeTrustState`, `updateTrustRoot`, `acceptTargets`, `acceptFreshness`, `codeMayRunUntil`, `markKey` |
| `plugin-trust-distribution.ts` (P2) | `trustServerOf` (a URL → `http(s)://host[:port]` or null), `companyTrustFiles` (a company's two file names, only from an id the core accepts), `PluginTrustDocuments` + `parsePluginTrustDocuments` (the route's answer, strict), `companyTrustToServe` (what the server hands one company), `takeCompanyTrust` (what the app takes in), `TRUST_NOTICE_BEFORE_MS` (48 h) |

App adapter: `client/electron/features/plugins/trust-crypto.ts` (`nodePluginTrustCrypto`; JWK
import, Ed25519 `verify(null)`, P-256 `verify('sha256', …, { dsaEncoding: 'ieee-p1363' })`). The
server has the same computation in `server/src/adapters/plugin-trust-crypto.ts` (it cannot import
the app); both run over the same fixtures, so they cannot drift apart unnoticed.

## Keys and roles (v3.1 §1)

| Role | Key type | Threshold | Signs | Where the key lives |
|---|---|---|---|---|
| `root` | ssh-ed25519 only | ≥ 2 (3 keys, 2 sign) | the root document only | offline, encrypted USB × 3 |
| `targets` | ecdsa-sha2-nistp256 only | 1 | one company's list | Secretive (Secure Enclave), Touch ID per signature |
| `freshness` | ed25519 or P-256 | 1 | freshness documents only | GitHub Actions secret (ed25519) + emergency Secretive key (P-256) |

`parseRoot` refuses: unknown keys, a key id outside `^[a-z0-9][a-z0-9._-]{0,63}$`, a key in
non-canonical base64, **one public key under two ids** (compared decoded), a role with no keys /
repeated / unknown ids, a threshold out of range, a key type a role may not hold, **one key in
two roles**. A signature counts only for a key the role lists, in the role's namespace.

## Root: history separate from freshness; a conflict halts for good

- **History** (`stepRoot`): N → N+1 needs the threshold of N's root keys **and** of N+1's own,
  version exactly +1, a valid shape. An intermediate root's expiry is **not** looked at (v1 → an
  expired v2 → v3 authenticates).
- **Freshness**: only the newest root's `expires` — past it, nothing is accepted and no code runs
  until a newer root arrives.
- **Stored as two values** (`serializeTrustState` → `{ record, halt }`; P2 writes `halt` to its
  own small file): the record (chain envelopes, records, the halt again) and the halt alone.
- **Start** (`startTrust(bakedEnvelope, { record, halt })`): the app's own root (a build carrying
  one that fails its own threshold throws). **First the halt**: from the halt file, the record's
  copy, or — when either text is damaged — a `"halted": { "version": N` still found in the raw
  text; a halt file present but unreadable counts as a halt at the app's version. A halt at or
  above the app's root version → halted, whatever the record says. Then the record: unreadable,
  or a stored chain with **any** entry that is not an envelope or not the next authentic step
  above the app's version → the app's root, **no records**, `problem` set (unknown, never
  "empty"). Stored entries at or below the app's version are its own history (a same-version
  text differing from the app's loses to it).
- **Updates** (`updateTrustRoot`): every envelope offered for a version is tried — junk, or the
  same text with too few signatures, never blocks the real root. A version where none
  authenticates stops the update there (`problem`; an earlier `problem` from the start is kept,
  not overwritten).
- **Conflict** (Codex condition 3): another text for a known version that is itself a valid step
  from the version before it, or two different texts for a new version that both authenticate
  (one answer) → `halted { version, reason }`; every accept and `codeMayRunUntil` answers
  `halted`, after a restart, after the record is damaged and whatever roots the server sends.
  Only an app carrying a root **newer** than the halted version starts clean. A differing text
  that does not authenticate is noise (no halt: a server without root keys cannot stop everyone).
  The app's own root version has no predecessor in the app, so a differing text **for the app's
  own version** cannot be authenticated and is ignored (anyone can self-sign a "v1"; halting on it
  would let a server stop every app).

## A company's list (`acceptTargets`, v3 §4–§5)

One list per company (packages for everyone included in each company's list; no snapshot /
timestamp role, so no mix-and-match). In order: not halted; newest root fresh; targets threshold
in `acb-targets-v1`; closed shape (`tag` = `id@version`, fingerprint v2 hex, commit hex,
optional `min_app_version` / `checker_api` / `facts_version` / `ui_bridge`; `floors` id →
version); `scope` = `company:<this company>`, `server` = this server (exact string); `issued` ≤
now + 10 min, `issued < expires ≤ issued + 90 days`, `expires > now`; no `id@version` twice; then
against the record of this **server × company × targets generation** (Codex condition 2): clock
not 10 min behind its `issued`, no lower version (across restarts), the same version only with
the same text (sha256), a step ≤ 1000, a higher version not issued earlier. Accepted → the
record moves to `{ generation, version, sha256, issued, expires }` — **only values read from the
verified text**. The returned `AcceptedList` is a handle: what it carries is never trusted later
(its `sha256` only says which document is meant).

**Generation** = the role's threshold + its keys' decoded identities. A root that replaces the
targets key changes it: the old generation's records stop applying (a stolen key's huge version
or near-future `issued` cannot block recovery) and lists under the old key no longer verify.
**Any change to a role's key set changes its generation**, an addition too: adding the emergency
freshness key in a root update restarts the freshness records (the next freshness document is
judged with nothing to compare, as on a first start; lists are untouched). Make such additions
together with a planned rotation, or accept that one restart.

**Shapes**: every level is closed (a key named `""` is an unknown key too); times are
`YYYY-MM-DDTHH:MM:SS(.mmm)Z` and must be real calendar times (no `02-30`, no `24:00`); a signed
text with a lone surrogate is refused (it has no one UTF-8 form, so two such strings could sign
the same bytes).

## Freshness (`acceptFreshness`, v3.1 §2)

A closed document "this list (its version and the sha256 of its signed text) is still current
until X": the list must be the record's current one; freshness threshold in `acb-freshness-v1`;
scope and server; bound to the **recorded** list's version **and** hash; the same time rules with
≤ 3 days; monotonic per server × company × freshness generation. Its record also keeps the list
it is bound to (`boundTo`).

## May code run? (`codeMayRunUntil`)

`min(newest root, list, freshness)` expiry **taken from the record** (never from the handles'
documents), only when not halted, the list is still the current record of the current targets
generation (a newer list or a rotated key revokes it), the freshness handle is the current record
of the current freshness generation and that record is bound to this list, and the clock is not
behind the newest `issued` seen. P4 closes frames and engines at that time.

## P2: storage, the carried root, distribution and the tools (v3 §13 P2 + v3.1 §3–§4, §7)

**The app** (`client/electron/features/plugins/`):

- `trust-store.ts`: `<userData>/trust/record.json` and, alone, `halt.json` — outside every company
  folder and **apart from the package store** (`<userData>/plugins/`; its sweep never reaches
  here). Reading: only ENOENT is "none"; a record that exists but cannot be read is handed on as
  unreadable text (→ `problem`: unknown, never empty); a halt file that exists but cannot be read
  **or is empty** is a halt at the app's version. Writing: each file to a fresh `.tmp`, `fsync`,
  rename, folder `fsync`; the halt **before** the record; the halt file removed only when the
  state is not halted (an app carrying a newer root). A leftover `.tmp` is never read and is
  swept at the next start; a record the start could not use is copied to `record.unusable.json`
  first (diagnosis).
- `trust.ts` (`createPluginTrust`): one state per computer (records keyed server × company ×
  generation inside it), started lazily from the carried root; `refresh(companyId)` fetches the
  route with the member's session, parses strictly, `takeCompanyTrust` with **the app's clock**,
  writes, and only then moves the state in memory (a failed write → `not-saved`, nothing moved).
  Refreshes run one at a time. Handles (`AcceptedList`, `AcceptedFreshness`) live in memory per
  server × company; after a restart the next refresh re-accepts the same text (the record refuses
  anything older). `status(companyId)` is `codeMayRunUntil` — **nobody calls it yet** (P4). A
  build whose root cannot start keeps no trust and logs it (`no-trust`), never throws.
- **"Unknown" is kept** (`TrustState.unknown`, stored in the record): an unreadable record or a
  stored chain that did not authenticate sets it; every later write keeps it and every restart
  reads it back (`health().unknown`), so one refresh never turns lost records into a clean
  history. Only `clearTrustUnknown` (a deliberate step; nothing calls it in P2) ends it. What was
  taken while unknown is judged as on a first start (an older still-valid list can be taken —
  nothing is left to compare); P4 decides what "unknown" allows.
- `trust-roots.ts` + `trust-roots/development.json` / `production.json` (`carriedTrustRoot`): an
  unpackaged app carries the development root; a packaged one the production root **when it is a
  real one** (`releaseTrustRootProblem`: not the placeholder, its own root threshold, **no** key
  shared with the development root, ≥ 30 days left), else — while `RELEASE_REQUIRES_PRODUCTION_ROOT`
  is `false` — the development root, logged at start, and `health().root` says `development`.
  **Enforcement (P4) must act on trust only when `health().root` is `production`.** The
  development root has its own keys (`scripts/plugin-trust-dev-root.ts`; the private keys are
  deleted unless `--keep <folder outside the repository>`). `production.json` is a **placeholder**
  until the owner makes the root keys. `scripts/check-trust-root.ts` runs first in `pnpm build` and
  in electron-builder's `beforePack` (`scripts/before-pack.mjs`, which then runs the bundled-git
  merge): today a loud warning ("this build carries the DEVELOPMENT plugin trust root") and the
  build goes on; with the switch `RELEASE_REQUIRES_PRODUCTION_ROOT = true` (one line, the
  enforcement PR, owner decision pending) it exits 1 and a packaged app never falls back.
- **One record per carried root**: `<userData>/trust/<development|production>/`, so a development
  app and a packaged app on one computer never share (or overwrite) a record or a halt.
- Wiring: `trust-wire.ts` (main.ts passes it to `wireAgentControl`); the policy's `pluginTrust`
  marker (a hex digest; anything else dropped by `parseAgentPolicy`) starts a refresh once per new
  marker per company (`refreshTrustOnMarker`). A marker is done only when the refresh was
  `settled`: the documents were taken in or refused for good. A failed refresh, or a refusal that
  may pass by itself (`TRANSIENT_TRUST_REFUSALS`: `issued-in-future`, `clock-went-back` — this
  computer's clock), is tried again at the next policy answer with the same marker.

**The server** (`server/src/`):

- `PLUGINS_DIR/trust/` (read only; `adapters/plugin-trust-files.ts`, port `ports/plugin-trust.ts`):
  `root/<version>.json`, `targets/company-<id>.json`, `freshness/company-<id>.json`. `trust` itself
  may be a link (the install's swap); every step below it is `lstat`ed — the three folders real
  folders, every file a plain file ≤ 1 MiB (a link anywhere is refused and named), ≤ 64 roots.
  Every call takes the places' stamp (`lstat` only: link target, inode, size, time); the files are
  read and verified again only when it changed, else the answer is reused until the earliest
  expiry or 5 minutes. The shelf skips `trust`.
- `services/plugin-trust.ts`: `documentsFor(member)` — `GET /api/companies/:companyId/plugin-trust`
  (`routes/plugins.ts`, `companyMember`: any member; a non-member 404, signed out 401 — permission
  matrix row; there is no object id, so no `CROSS` row: the company is the member's, its file name
  is built only by `companyTrustFiles`). `companyTrustToServe`: the server starts from its lowest
  root file that carries its own threshold, hands the chain it can authenticate (the app re-checks
  from its own root), and hands this company's list and freshness only when they pass the same
  checks **by the server's clock** on a fresh record (the server keeps none: it is a filter, not
  the authority). A root conflict → nothing. Withheld documents and "runs out within 48 h" are
  logged for the operator (`[plugin-trust] company=<id>: …`, codes and hours only, at most hourly
  per note). `PUBLIC_URL` must be `http(s)://host[:port]`, else nothing is handed out.
- `digestFor(companyId)` → the agent policy's `pluginTrust` (part of its version / ETag), so a new
  document reaches the apps at their next policy refresh; no `trust/` → no marker.
- Clocks: the server's clock only decides what it hands out (keep it NTP-synced: a server clock
  more than 10 minutes behind withholds fresh documents); the app judges everything again with
  its own.

**The tools** (`server/src/cli/plugin-trust.ts`, `adapters/plugin-trust-tools.ts`; they hold no
key and sign with `ssh-keygen -Y sign` — a key file, or a public key file whose key the agent
holds): `check-key` (the owner's first real-device check: sign through the agent, verify with the
core, key type per role; `--role` must be one of the three), `sign-root` (one root key's
signature at a time, verified; for a **rotation** `--predecessor <root/N-1.json>` (a signed root
carrying its own threshold, version N − 1): a key that root lists for `root` may sign too — a key
being removed — and its signature is checked against **the predecessor's** key; the answer says
whether each threshold is met and whether the root is complete (`stepRoot`: both)), `sign-targets`
(each package from the lock: the tag's commit must be reachable from `origin/main` — the reviewed
merge; cloned `--filter=blob:none` — and the folder's fingerprint v2 at the tag must equal the
lock's; next version; ≤ 90 days; verified against the roots before it is written),
`sign-freshness` (per company list: bound to its version and sha256, next version, ≤ 3 days,
verified; one company whose list does not verify is reported and the others are still signed;
exit 1), `install` (the operator's hourly timer; below). **An existing document whose version
cannot be read refuses to sign** (never "start again at v1").

`install` copies `root/` + `targets/` from the main checkout and `freshness/` from the freshness
checkout into a new `.trust-<time>-<id>` folder of `PLUGINS_DIR`, then renames a new `trust` link
over the old one and removes the previous folder. It refuses, changing nothing, when a source
folder cannot be read or is missing (never read as "no companies"), when `targets/` holds no
company (unless `--allow-empty yes`), when a root version installed now is missing from the new
`root/` (apps may carry it: never remove a root version), and when no company verifies. One
company whose list or freshness does not verify does not block the others: its installed
documents are kept when they still verify, else it is left out; it is reported and the command
exits 1 (the timer alerts). Commands: `deployment.md` "Plugin trust documents".

## Owner steps (段2; nothing is enforced before them)

1. **Root keys**: three ed25519 keys with passphrases on encrypted USB sticks (`ssh-keygen -t
   ed25519`), offline. **Signing keys**: a P-256 targets key in Secretive and a second P-256
   (emergency freshness) key; an ed25519 freshness key for the Actions secret.
2. **The real-device check** (v3.1 §6), on the owner's Mac with Secretive's agent
   (`SSH_AUTH_SOCK` = Secretive's socket):
   `cd server && node --import tsx src/cli/plugin-trust.ts check-key --key <secretive.pub> --role targets`
   → "good: …" and the key line for the root. Same for the emergency key (`--role freshness`).
   If Secretive's signature is refused, stop and report (no workaround in the code).
3. Write the root (`_type: acb-root`, version 1, expires in a year, the keys, roles: root 2-of-3,
   targets the Secretive key, freshness the Actions key + the emergency key) and sign it with two
   USB keys: `plugin-trust.ts sign-root --root root.json --key <usb key> --key-id <id> --out root/1.json`
   twice. Put the signed envelope in `client/electron/features/plugins/trust-roots/production.json`
   (a PR; `scripts/check-trust-root.ts` then reports it in place). A later root N+1 is signed with
   `--predecessor root/N.json` so the keys it removes can still sign (both thresholds).
4. The private "trust" repository (`main`: `root/`, `targets/`; `freshness` branch) and the daily
   workflow (v3.1 §3), then sign every current version for every company (`sign-targets`), run the
   workflow once, install on the server, and confirm "versions on the shelf not in a list: 0"
   before P3 / P4 enforce anything.

## Threat model limits (v3 §1, v3.1 §5) — what this does not protect

- Old apps (before P4) have no gate at all; a taken-over server can hand them anything.
- A frozen view inside a list's life: with the freshness key safe, a server hiding newer
  documents stops code within 3 days; with the freshness key **and** the server taken, a computer
  that never saw a newer list (new, or its record deleted) runs an old list up to its own expiry
  (≤ 90 days). A first start has nothing to compare (a fresh record accepts a huge version: the
  generation and the expiry bound it).
- Between a key's theft and root replacing it, stolen key + taken-over server can run code.
- The app binary itself (notarisation, Fuses: v3 §10), plans / approvals forged by a taken-over
  server, and the review that decides what is signed.
- Server URLs are compared exactly as signed: the app must pass the server's public URL in the
  same spelling the signing tool writes.
- The stored record and halt file are protected only as files of the member's OS account:
  deleting **both** (or the whole record) is an action of that same user (or malware running as
  them), outside this threat model — it can also replace the app. It lifts a halt and forgets the
  records (the first-start case above). A damaged record alone never lifts a halt.

## Fixtures

`client/tests/fixtures/plugin-trust/` (`keys.json` public keys, `documents.json` signed
envelopes), written by `cd client && npx tsx scripts/plugin-trust-fixtures.ts` with real
`ssh-keygen -Y sign`: **test keys only**, made fresh in a temporary folder and deleted — no
private key is committed; re-running replaces every key and signature. Tests never need
ssh-keygen and pass their own `now` (2026-11-21T12:00Z), so the fixtures never go stale.

## Tests

P2: `client/tests/plugin-trust-store.test.ts` (S the record on disk: written, rollback refused
across a restart, deleted, damaged / unreadable = unknown and kept aside, the halt through a
restart and a damaged or deleted record, damaged / empty / unreadable halt file, an interrupted
write leaves the old record and nothing moves in memory, halt written first; B6 / B7 / B9 / C14 /
C1 through the store; S3b "unknown" kept through a refresh and a restart; T1 the app's clock; W
the answer's shape, the marker, once per marker, W4 / W5 a transient refusal retried with the same
marker and a permanent one not; K the release root check, K5 what a build carries and the switch,
K6 the root kind reported and one record folder per kind), `server/tests/unit/plugin-trust-serve.test.ts`
(V what one company is handed: its own only, other server / list, conflict, junk root, no
self-signed root, the server's clock and the 48 h note, file names; F the folder: only its own two
files, a link inside refused — a file or a folder —, read again only when the stamp changed),
`server/tests/integration/plugin-trust.test.ts` (c1 / c2 apart, the marker follows the files, no
`trust/`), `server/tests/unit/plugin-trust-tools.test.ts` (real `ssh-keygen`, keys made in the
test: root signing and a rotation replacing two of three root keys, list and freshness verified
before writing, an unreadable version refuses, one bad company does not block freshness, the key
check and its role, the install swap; refused for an unreadable source, no company, a removed root
version, no company verifying; one bad company kept or left out; reviewed tags only), the
permission matrix row, `plugin-shelf.test.ts` (`trust` is not a package). 60 mutations (32 + 28
after the review), each caught (removed or inverted → a named test fails; leaving out the carried
root's kind fails the type check: `rootKind` is required).

P1: `client/tests/plugin-trust.test.ts` (A signatures and root shape, B root history / conflict /
restart, C the list, D a stolen signing key, H freshness, R the review's cases: a malformed stored
chain, keys named `""`, a halt surviving a damaged record, expiry from the record, junk root
candidates, SSHSIG strictness — version, reserved, hash, types, trailing bytes —, lone surrogates,
calendar times, the start `problem` kept), with the real adapter. Every guard was
mutation-checked (removed or inverted → its named test fails; 79 mutations). Four mutants are
equivalent by construction and kept as defence in depth: the decoded-key comparison alone (strict
base64 makes spellings unique; removed together with the base64 check → A6c fails),
`verifySshSig`'s "signature's key = expected key" (verification uses the expected key anyway),
`currentListMark`'s server/company check (the record key and the text's hash already bind them),
and parsing the halt file / the record's halt as JSON (the raw-text scan finds the same halt;
removing the scan → R3 fails).
