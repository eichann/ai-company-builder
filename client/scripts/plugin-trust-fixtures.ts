/**
 * Writes the plugin-trust test fixtures (`client/tests/fixtures/plugin-trust/`) with real
 * `ssh-keygen -Y sign` (`.claude/rules/plugin-trust.md` "Fixtures"):
 *
 *   cd client && npx tsx scripts/plugin-trust-fixtures.ts
 *
 * - **TEST KEYS ONLY**: made fresh in a temporary folder on every run (ed25519 for root and
 *   freshness, ECDSA P-256 for targets and the emergency freshness key, as v3.1 §1 assigns them),
 *   no passphrase, deleted at the end. Only their public halves are written (`keys.json`), so no
 *   private key — not even a test one — is in the repository; running the script again replaces
 *   every key and signature.
 * - `documents.json`: every signed envelope the tests use, by name. The tests need no ssh-keygen.
 * - The dates are fixed around the tests' clock (2026-11-21T12:00:00Z); the tests pass their own
 *   `now`, so the fixtures never go stale.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/plugin-trust')
const work = mkdtempSync(join(tmpdir(), 'acb-trust-test-keys-'))

const ED = ['test-root-1', 'test-root-2', 'test-root-3', 'test-root-4', 'test-root-5', 'test-fresh-a', 'test-fresh-b']
const P256 = ['test-targets-a', 'test-targets-b', 'test-fresh-emergency']

type Envelope = { signed: string; signatures: Array<{ key_id: string; sig: string }> }

try {
  for (const name of ED) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${name} (ACB TEST KEY, never use)`, '-f', join(work, name)])
  for (const name of P256) execFileSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-b', '256', '-N', '', '-C', `${name} (ACB TEST KEY, never use)`, '-f', join(work, name)])
  const pub = (name: string): string => readFileSync(join(work, `${name}.pub`), 'utf8').trim().split(/\s+/)[1]
  const keys = Object.fromEntries([...ED, ...P256].map(n => [n, pub(n)]))

  const RNS = 'acb-root-v1'
  const TNS = 'acb-targets-v1'
  const FNS = 'acb-freshness-v1'
  const sign = (text: string, key: string, ns: string): string =>
    execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', join(work, key), '-n', ns], { input: text }).toString()
  /** signers: [key_id, signing key (default: the key named by key_id)] */
  const envelope = (payload: unknown, signers: Array<[string, string?]>, ns: string): Envelope => {
    const text = JSON.stringify(payload, null, 1)
    return { signed: text, signatures: signers.map(([id, key]) => ({ key_id: id, sig: sign(text, key ?? id, ns) })) }
  }
  const docs: Record<string, Envelope> = {}

  // ---- roots
  const keysOf = (ids: string[]) => Object.fromEntries(ids.map(k => [k, keys[k]]))
  const root = (version: number, expires: string, rootKeys: string[], targets: string[], fresh: string[]) => ({
    _type: 'acb-root', version, expires,
    keys: keysOf([...rootKeys, ...targets, ...fresh]),
    roles: { root: { keys: rootKeys, threshold: 2 }, targets: { keys: targets, threshold: 1 }, freshness: { keys: fresh, threshold: 1 } },
  })
  const R1 = root(1, '2027-11-21T00:00:00Z', ['test-root-1', 'test-root-2', 'test-root-3'], ['test-targets-a'], ['test-fresh-a', 'test-fresh-emergency'])
  // v2: an intermediate root already expired at the tests' clock; replaces the targets AND freshness keys
  const R2 = root(2, '2026-11-01T00:00:00Z', ['test-root-1', 'test-root-2', 'test-root-3'], ['test-targets-b'], ['test-fresh-b'])
  // v3: the root key set itself rotated (1,2,3 → 1,4,5)
  const R3 = root(3, '2027-11-21T00:00:00Z', ['test-root-1', 'test-root-4', 'test-root-5'], ['test-targets-b'], ['test-fresh-b'])
  docs['root-v1'] = envelope(R1, [['test-root-1'], ['test-root-2']], RNS)
  docs['root-v2'] = envelope(R2, [['test-root-1'], ['test-root-3']], RNS)
  docs['root-v2-conflict'] = envelope({ ...R2, expires: '2026-10-30T00:00:00Z' }, [['test-root-2'], ['test-root-3']], RNS)
  docs['root-v2-noise'] = envelope({ ...R2, expires: '2026-10-29T00:00:00Z' }, [['test-root-1']], RNS)
  docs['root-v2-one-key'] = envelope(R2, [['test-root-1']], RNS)
  // the signing (targets) key tries to rewrite root: under its own id and claiming a root key's id
  docs['root-v2-by-targets-key'] = envelope(R2, [['test-targets-a'], ['test-root-2', 'test-targets-a']], RNS)
  docs['root-v3'] = envelope(R3, [['test-root-1'], ['test-root-2'], ['test-root-4']], RNS)
  docs['root-v3-old-keys-only'] = envelope(R3, [['test-root-2'], ['test-root-3']], RNS)
  docs['root-v3-new-keys-only'] = envelope(R3, [['test-root-4'], ['test-root-5']], RNS)
  // one text signed twice by test-root-1, under two ids (the threshold must count the key once)
  const anyText = '{"any":"json"}'
  docs['one-key-two-ids'] = { signed: anyText, signatures: [{ key_id: 'test-root-1', sig: sign(anyText, 'test-root-1', RNS) }, { key_id: 'test-root-1-again', sig: sign(anyText, 'test-root-1', RNS) }] }

  // ---- company lists
  const commit = 'c0ffee'.padEnd(40, '0')
  const lstep = { id: 'lstep', version: '0.3.0', fingerprint: 'a'.repeat(64), commit, tag: 'lstep@0.3.0', min_app_version: '1.40.0', checker_api: 1, facts_version: 1, ui_bridge: null }
  const own = { id: 'kuro-ops', version: '1.0.0', fingerprint: 'f'.repeat(64), commit, tag: 'kuro-ops@1.0.0', ui_bridge: 1 }
  const T = (o: Record<string, unknown> = {}) => ({
    _type: 'acb-targets', scope: 'company:c1', server: 'https://acb.example', version: 5,
    issued: '2026-11-21T00:00:00Z', expires: '2027-01-20T00:00:00Z', packages: [lstep, own], floors: { lstep: '0.3.0' }, ...o,
  })
  const ta: Array<[string, string?]> = [['test-targets-a']]
  const tb: Array<[string, string?]> = [['test-targets-b']]
  const lists: Record<string, [unknown, Array<[string, string?]>, string?]> = {
    't-c1-v5': [T(), ta],
    't-c1-v5-wrong-key': [T(), [['test-targets-a', 'test-targets-b']]],
    't-c1-v5-root-ns': [T(), ta, RNS],
    't-c1-v5-by-fresh-key': [T(), [['test-fresh-a']]],
    't-c2-v5': [T({ scope: 'company:c2', packages: [lstep] }), ta],
    't-c1-v5-staging': [T({ server: 'https://staging.example' }), ta],
    't-c1-v4-staging': [T({ server: 'https://staging.example', version: 4, issued: '2026-11-20T00:00:00Z' }), ta],
    't-c1-v4': [T({ version: 4, issued: '2026-11-20T00:00:00Z' }), ta],
    't-c1-v5-other-content': [T({ packages: [lstep] }), ta],
    't-c1-v6': [T({ version: 6, issued: '2026-11-21T06:00:00Z' }), ta],
    't-c1-v6-future': [T({ version: 6, issued: '2026-11-21T12:11:00Z' }), ta],
    't-c1-v6-overlong': [T({ version: 6, expires: '2027-03-21T00:00:00Z' }), ta],
    't-c1-v1006': [T({ version: 1006, issued: '2026-11-21T06:00:00Z' }), ta],
    't-c1-v1005': [T({ version: 1005, issued: '2026-11-21T06:00:00Z' }), ta],
    't-c1-huge': [T({ version: 2 ** 31 - 1, issued: '2026-11-21T06:00:00Z' }), ta],
    't-c1-v7-issued-back': [T({ version: 7, issued: '2026-11-19T00:00:00Z' }), ta],
    't-c1-duplicate': [T({ version: 6, issued: '2026-11-21T06:00:00Z', packages: [lstep, lstep] }), ta],
    't-c1-extra-key': [T({ version: 6, issued: '2026-11-21T06:00:00Z', note: 'x' }), ta],
    't-c1-v6-tb': [T({ version: 6, issued: '2026-11-21T06:00:00Z' }), tb],
    't-c1-v5-tb': [T({ version: 5, issued: '2026-11-21T03:00:00Z' }), tb],
  }
  for (const [name, [payload, signers, ns]] of Object.entries(lists)) docs[name] = envelope(payload, signers, ns ?? TNS)

  // ---- freshness documents (what the daily GitHub Actions job signs)
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const F = (list: string, o: Record<string, unknown> = {}) => ({
    _type: 'acb-freshness', scope: 'company:c1', server: 'https://acb.example', version: 1,
    issued: '2026-11-21T00:00:00Z', expires: '2026-11-24T00:00:00Z',
    targets: { version: JSON.parse(docs[list].signed).version, sha256: sha(docs[list].signed) }, ...o,
  })
  const fa: Array<[string, string?]> = [['test-fresh-a']]
  docs['f-c1-v5'] = envelope(F('t-c1-v5'), fa, FNS)
  docs['f-c1-v5-n2'] = envelope(F('t-c1-v5', { version: 2, issued: '2026-11-21T06:00:00Z' }), fa, FNS)
  docs['f-c1-v5-emergency'] = envelope(F('t-c1-v5'), [['test-fresh-emergency']], FNS)
  docs['f-c1-for-v4'] = envelope(F('t-c1-v4'), fa, FNS)
  docs['f-c1-long'] = envelope(F('t-c1-v5', { expires: '2026-11-24T00:01:00Z' }), fa, FNS)
  docs['f-c1-by-targets-key'] = envelope(F('t-c1-v5'), [['test-targets-a']], FNS)
  docs['f-c2'] = envelope(F('t-c1-v5', { scope: 'company:c2' }), fa, FNS)
  docs['f-c1-staging'] = envelope(F('t-c1-v5', { server: 'https://staging.example' }), fa, FNS)
  docs['f-c1-adds-package'] = envelope({ ...F('t-c1-v5'), packages: [{ id: 'evil', version: '9.9.9', fingerprint: '0'.repeat(64) }] }, fa, FNS)
  docs['f-c1-v6'] = envelope(F('t-c1-v6', { version: 2, issued: '2026-11-21T06:00:00Z' }), fa, FNS)
  docs['f-c1-v6-tb-fresh-b'] = envelope(F('t-c1-v6-tb'), [['test-fresh-b']], FNS)
  docs['f-c1-v6-tb-fresh-a'] = envelope(F('t-c1-v6-tb', { version: 3, issued: '2026-11-21T07:00:00Z' }), fa, FNS)   // the replaced freshness key

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'keys.json'), JSON.stringify(keys, null, 1) + '\n')
  writeFileSync(join(OUT, 'documents.json'), JSON.stringify(docs, null, 1) + '\n')
  console.log(`wrote ${Object.keys(keys).length} test public keys and ${Object.keys(docs).length} signed documents to ${OUT}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
