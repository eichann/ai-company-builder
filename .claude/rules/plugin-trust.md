---
paths:
  - "shared/core/plugin-trust*.ts"
  - "client/electron/features/plugins/trust-crypto.ts"
  - "client/tests/plugin-trust.test.ts"
  - "client/tests/fixtures/plugin-trust/**"
  - "client/scripts/plugin-trust-fixtures.ts"
---

# Plugin trust: signed lists of the code a package may carry (P1: format and verification only)

Design: 署名の検証の設計 v3 + v3.1 (owner decisions 2026-11-21; internal). Goal: on a new app, code
a package carries (`ui/`, `checkers/`, `steps/`, the declaration — every file) runs only when div
signed **that company's list** with that fingerprint in it — even if the server is taken over.

## What P1 provides — and what it does not yet

- **Provides**: the signed documents' shapes, OpenSSH signature (SSHSIG) verification, the root
  chain, the acceptance rules for a company's list and its freshness document, and the trust
  record's state machine — pure functions in `shared/core/` over an injected clock (`now`) and
  injected crypto, plus the app's `node:crypto` adapter and the tests.
- **Does not do yet**: **nothing calls it.** No storage of the record (P2: `<userData>/trust/`,
  atomic writes, re-checked at start), no distribution (P2: the server reads `PLUGINS_DIR/trust/`
  and hands each company its own list, verifying with the same code; `sign-targets`), no
  enforcement (P3 shelf, P4 the app's one gate / frozen copy / `acb-plugin://<ref>`, P5 the
  isolated checker runtime). Packages keep running exactly as before; `signature.yaml`
  (`plugins.md` "Signature slot") stays shape-only and is not part of this.
- The server gets its own adapter (`server/src/adapters/`, behind a port) in P2, when it first
  verifies; the fixtures are shared with it.

## Modules (`shared/core`, pure: no Node built-ins — `core-purity.test.ts`)

| Module | What |
|---|---|
| `plugin-trust-sshsig.ts` | `PluginTrustCrypto` (the port: `sha256`, `sha512`, `verify(type, key, data, sig)` never throws), strict base64 (`decodeBase64Strict`: the one canonical spelling), OpenSSH public keys (`decodeSshPublicKey`, `parseRootKey`; ed25519 32 bytes, P-256 uncompressed point **on the curve**, `isP256Point` with BigInt), `parseSshSig` (armored, magic, version 1, empty reserved, sha256/sha512, signature type = key type, ECDSA mpints → r ‖ s), `sshSigSignedData`, `verifySshSig` (namespace and key must match) |
| `plugin-trust-documents.ts` | `PLUGIN_TRUST_POLICY` (10 min skew, list ≤ 90 days, freshness ≤ 3 days, version step ≤ 1000, root threshold ≥ 2, envelope limits), namespaces `acb-root-v1` / `acb-targets-v1` / `acb-freshness-v1`, `ROLE_KEY_TYPES`, refusal codes, `openEnvelope` (threshold counted **by distinct decoded key**), `parseRoot`, `parseTargets`, `parseFreshness` (all closed shapes), `roleGeneration` |
| `plugin-trust.ts` | `bakedRoot`, `stepRoot`, `startTrust`, `serializeTrustState`, `updateTrustRoot`, `acceptTargets`, `acceptFreshness`, `codeMayRunUntil`, `markKey` |

App adapter: `client/electron/features/plugins/trust-crypto.ts` (`nodePluginTrustCrypto`; JWK
import, Ed25519 `verify(null)`, P-256 `verify('sha256', …, { dsaEncoding: 'ieee-p1363' })`).

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

`client/tests/plugin-trust.test.ts` (A signatures and root shape, B root history / conflict /
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
