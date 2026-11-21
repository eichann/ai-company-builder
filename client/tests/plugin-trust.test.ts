/**
 * Plugin trust P1 (`.claude/rules/plugin-trust.md`): the signature format, the root chain, the
 * company's list and the freshness document, verified with the app's `node:crypto` adapter over
 * fixtures signed by real `ssh-keygen -Y sign` (`scripts/plugin-trust-fixtures.ts`; test keys
 * only). Every guard here is mutation-checked: removing or inverting it fails the test named for it.
 * The names follow the design's checks (A signatures and root shape, B root history, C the list,
 * D a stolen signing key, H freshness).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodePluginTrustCrypto as C } from '../electron/features/plugins/trust-crypto'
import {
  acceptFreshness, acceptTargets, bakedRoot, codeMayRunUntil, serializeTrustState, startTrust, stepRoot, updateTrustRoot,
  type AcceptedList, type TrustContext, type TrustState,
} from '../../shared/core/plugin-trust'
import {
  openEnvelope, parseEnvelope, parseFreshness, parseRoot, parseTargets, parseTrustTime, roleGeneration, TRUST_NAMESPACES,
  type SignedEnvelope, type TrustResult,
} from '../../shared/core/plugin-trust-documents'
import { decodeBase64Strict, parseRootKey, parseSshSig, utf8, verifySshSig, type SshPublicKey } from '../../shared/core/plugin-trust-sshsig'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/plugin-trust')
const DOCS = JSON.parse(readFileSync(join(DIR, 'documents.json'), 'utf8')) as Record<string, SignedEnvelope>
const KEYS = JSON.parse(readFileSync(join(DIR, 'keys.json'), 'utf8')) as Record<string, string>

const doc = (name: string): SignedEnvelope => {
  assert.ok(DOCS[name], `fixture ${name}`)
  return structuredClone(DOCS[name])
}
const payload = (name: string) => JSON.parse(DOCS[name].signed)
const at = (iso: string) => Date.parse(iso)
const NOW = at('2026-11-21T12:00:00Z')
const SERVER = 'https://acb.example'
const CTX: TrustContext = { server: SERVER, companyId: 'c1', now: NOW }

const start = (): TrustState => startTrust(doc('root-v1'), null, C)
function ok<T>(r: TrustResult<T>): { ok: true } & T {
  assert.ok(r.ok, r.ok ? '' : `refused: ${r.code}${r.detail ? ` (${r.detail})` : ''}`)
  return r as { ok: true } & T
}
const refusedWith = (r: TrustResult<unknown>, code: string) => assert.equal(r.ok ? 'accepted' : r.code, code)
const rootProblem = (value: unknown): string | null => { const r = parseRoot(value); return r.ok ? null : r.problem }

/** The same key bytes in another base64 spelling: the unused low bits of the last character set. */
function otherSpelling(b64: string): string {
  assert.ok(b64.endsWith('=') && !b64.endsWith('=='), 'needs exactly one pad character')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const i = b64.length - 2
  return b64.slice(0, i) + alphabet[alphabet.indexOf(b64[i]) ^ 1] + b64.slice(i + 1)
}

/** v5 for c1, accepted on a fresh state, with its freshness. */
function v5WithFreshness() {
  const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
  const f = ok(acceptFreshness(t.state, doc('f-c1-v5'), t.list, CTX, C))
  return { state: f.state, list: t.list, freshness: f.freshness }
}

describe('A. signatures, key types and the root shape', () => {
  it('A1 the app\'s root v1 carries its own 2-of-3; an app root without its own threshold does not start', () => {
    assert.equal(bakedRoot(doc('root-v1'), C).document.version, 1)
    assert.throws(() => bakedRoot(doc('root-v2-one-key'), C), /own root keys/)
  })

  it('A2 real OpenSSH signatures verify: ed25519 (root) and ECDSA P-256 (the signing key), each only for its own text', () => {
    const r1 = parseRoot(payload('root-v1'))
    assert.ok(r1.ok)
    const env = doc('root-v1')
    assert.equal(verifySshSig(env.signatures[0].sig, utf8(env.signed), TRUST_NAMESPACES.root, r1.root.keys.get('test-root-1')!, C), true)
    const list = doc('t-c1-v5')
    const p256 = r1.root.keys.get('test-targets-a')!
    assert.equal(p256.type, 'ecdsa-sha2-nistp256')
    assert.equal(verifySshSig(list.signatures[0].sig, utf8(list.signed), TRUST_NAMESPACES.targets, p256, C), true)
    assert.equal(verifySshSig(list.signatures[0].sig, utf8(list.signed + ' '), TRUST_NAMESPACES.targets, p256, C), false)
    ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
  })

  it('A3 a list signed by another key under the signing key\'s id is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v5-wrong-key'), CTX, C), 'threshold')
  })

  it('A4 a broken or truncated signature is refused, never thrown', () => {
    const env = doc('t-c1-v5')
    const lines = env.signatures[0].sig.split('\n')
    const i = lines.length - 3
    lines[i] = lines[i].slice(0, 10) + (lines[i][10] === 'A' ? 'B' : 'A') + lines[i].slice(11)
    refusedWith(acceptTargets(start(), { ...env, signatures: [{ ...env.signatures[0], sig: lines.join('\n') }] }, CTX, C), 'threshold')
    const sig = env.signatures[0].sig
    for (const cut of [sig.slice(0, sig.length - 40), sig.replace(/\n[^\n]+\n-----END/, '\n-----END'), '']) {
      refusedWith(acceptTargets(start(), { ...env, signatures: [{ ...env.signatures[0], sig: cut }] }, CTX, C), 'threshold')
    }
  })

  it('A5 an edited signed text is refused', () => {
    const env = doc('t-c1-v5')
    const p = JSON.parse(env.signed)
    p.packages.push({ ...p.packages[0], id: 'evil', tag: 'evil@0.3.0' })
    refusedWith(acceptTargets(start(), { ...env, signed: JSON.stringify(p, null, 1) }, CTX, C), 'threshold')
  })

  it('A6a one public key under two ids is not a valid root', () => {
    const r = payload('root-v1')
    r.keys['test-root-1-again'] = r.keys['test-root-1']
    r.roles.root.keys.push('test-root-1-again')
    assert.match(rootProblem(r) ?? '', /two ids/)
  })

  it('A6b a key written in non-canonical base64 is not a valid root key (one value, one spelling)', () => {
    const spelled = otherSpelling(KEYS['test-targets-a'])
    assert.deepEqual(decodeBase64Strict(KEYS['test-targets-a'])?.length, 104)
    assert.equal(decodeBase64Strict(spelled), null)
    assert.equal(parseRootKey(KEYS['test-root-1'] + '\n').ok, false)
    const r = payload('root-v1')
    r.keys['test-targets-a'] = spelled
    assert.match(rootProblem(r) ?? '', /canonical/)
  })

  it('A6c one key in two spellings under two ids is refused (compared by decoded value)', () => {
    const r = payload('root-v1')
    r.keys['test-targets-a2'] = otherSpelling(KEYS['test-targets-a'])
    r.roles.targets.keys.push('test-targets-a2')
    assert.ok(rootProblem(r))
  })

  it('A6d a P-256 key that is not an uncompressed point on the curve is refused', () => {
    const blob = Buffer.from(KEYS['test-targets-a'], 'base64')
    const offCurve = Buffer.from(blob)
    offCurve[offCurve.length - 1] ^= 1
    assert.match(String((parseRootKey(offCurve.toString('base64')) as { error?: string }).error), /on the curve/)
    const compressed = Buffer.from(blob)
    compressed[compressed.length - 65] = 2
    assert.equal(parseRootKey(compressed.toString('base64')).ok, false)
  })

  it('A7 one key signing under two ids counts once toward a threshold', () => {
    const r = parseRoot(payload('root-v1'))
    assert.ok(r.ok)
    const keys = new Map([['test-root-1', r.root.keys.get('test-root-1')!], ['test-root-1-again', r.root.keys.get('test-root-1')!]])
    refusedWith(openEnvelope(doc('one-key-two-ids'), TRUST_NAMESPACES.root, keys, { keys: ['test-root-1', 'test-root-1-again'], threshold: 2 }, C), 'threshold')
    ok(openEnvelope(doc('one-key-two-ids'), TRUST_NAMESPACES.root, keys, { keys: ['test-root-1', 'test-root-1-again'], threshold: 1 }, C))
  })

  it('A8 a root threshold below two is not a valid root', () => {
    const r = payload('root-v1')
    r.roles.root.threshold = 1
    assert.match(rootProblem(r) ?? '', /root: threshold/)
  })

  it('A9 a threshold larger than the role\'s keys is not a valid root', () => {
    const r = payload('root-v1')
    r.roles.targets.threshold = 2
    assert.match(rootProblem(r) ?? '', /targets: threshold/)
  })

  it('A10 one key in two roles is not a valid root', () => {
    const r = payload('root-v1')
    r.roles.freshness.keys.push('test-targets-a')
    assert.match(rootProblem(r) ?? '', /two roles/)
  })

  it('A11 the signing (targets) key cannot rewrite root, under its own id or a root key\'s', () => {
    const r1 = parseRoot(payload('root-v1'))
    assert.ok(r1.ok)
    refusedWith(stepRoot(r1.root, doc('root-v2-by-targets-key'), C), 'root-old-keys')
    const st = updateTrustRoot(start(), [doc('root-v2-by-targets-key')], C)
    assert.equal(st.root.document.version, 1)
    assert.ok(st.problem)
  })

  it('A12 one root key alone cannot make the next root', () => {
    const r1 = parseRoot(payload('root-v1'))
    assert.ok(r1.ok)
    refusedWith(stepRoot(r1.root, doc('root-v2-one-key'), C), 'root-old-keys')
  })

  it('A13 the right signing key\'s signature made for another namespace is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v5-root-ns'), CTX, C), 'threshold')
  })

  it('A14 each role holds only its key type: targets P-256, root ed25519; freshness either', () => {
    const edTargets = payload('root-v1')
    edTargets.keys['test-ed-signing'] = KEYS['test-root-4']
    edTargets.roles.targets.keys = ['test-ed-signing']
    delete edTargets.keys['test-targets-a']
    assert.match(rootProblem(edTargets) ?? '', /targets: key type/)
    const p256Root = payload('root-v1')
    p256Root.roles.freshness.keys = ['test-fresh-a']
    p256Root.roles.root.keys.push('test-fresh-emergency')
    assert.match(rootProblem(p256Root) ?? '', /root: key type/)
    assert.equal(rootProblem(payload('root-v1')), null)
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    ok(acceptFreshness(t.state, doc('f-c1-v5-emergency'), t.list, CTX, C)) // the P-256 emergency freshness key
  })
})

describe('B. the root history, its freshness, and a conflict', () => {
  it('B1–B3 rotating the root key set needs the old set\'s and the new set\'s thresholds', () => {
    const r2 = parseRoot(payload('root-v2'))
    assert.ok(r2.ok)
    ok(stepRoot(r2.root, doc('root-v3'), C))
    refusedWith(stepRoot(r2.root, doc('root-v3-old-keys-only'), C), 'root-new-keys')
    refusedWith(stepRoot(r2.root, doc('root-v3-new-keys-only'), C), 'root-old-keys')
  })

  it('B4 v1 → v2 (already expired) → v3 authenticates: an intermediate root\'s expiry is not looked at', () => {
    const st = updateTrustRoot(start(), [doc('root-v3'), doc('root-v2')], C)
    assert.equal(st.root.document.version, 3)
    assert.equal(st.problem, null)
    ok(acceptTargets(st, doc('t-c1-v6-tb'), CTX, C))
  })

  it('B4b a root cannot skip a version, even signed by both key sets', () => {
    const st = updateTrustRoot(start(), [doc('root-v3')], C)
    assert.equal(st.root.document.version, 1)
    assert.match(st.problem ?? '', /root-version-step/)
  })

  it('B5 the newest root expired and nothing newer → no list is accepted', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v5'), { ...CTX, now: at('2027-12-01T00:00:00Z') }, C), 'root-expired')
  })

  it('B6 a long-dormant computer catches up from its stored chain', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    const st = updateTrustRoot(startTrust(doc('root-v1'), serializeTrustState(t.state), C), [doc('root-v2'), doc('root-v3')], C)
    assert.equal(st.root.document.version, 3)
    assert.equal(st.problem, null)
  })

  it('B7 a new app carrying v3 keeps the records of the same generation (a rollback stays refused)', () => {
    const onV3 = updateTrustRoot(start(), [doc('root-v2'), doc('root-v3')], C)
    const t6 = ok(acceptTargets(onV3, doc('t-c1-v6-tb'), CTX, C))
    const newApp = startTrust(doc('root-v3'), serializeTrustState(t6.state), C)
    assert.equal(newApp.root.document.version, 3)
    refusedWith(acceptTargets(newApp, doc('t-c1-v5-tb'), CTX, C), 'rollback')
    ok(acceptTargets(startTrust(doc('root-v3'), null, C), doc('t-c1-v5-tb'), CTX, C))
  })

  it('B8 an app carrying v2 re-authenticates the stored chain up to v3', () => {
    const onV3 = updateTrustRoot(start(), [doc('root-v2'), doc('root-v3')], C)
    const midApp = startTrust(doc('root-v2'), serializeTrustState(onV3), C)
    assert.equal(midApp.root.document.version, 3)
    assert.equal(midApp.problem, null)
  })

  it('B9 a stored chain that does not authenticate is dropped with its records: the app\'s root, problem noted', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    const forged = JSON.parse(serializeTrustState(t.state).record)
    forged.chain = [doc('root-v1'), doc('root-v2'), doc('root-v3-old-keys-only')]
    const st = startTrust(doc('root-v1'), { record: JSON.stringify(forged) }, C)
    assert.equal(st.root.document.version, 1)
    assert.deepEqual(st.marks, {})
    assert.ok(st.problem)
  })

  it('B10 an unreadable stored record → the app\'s root, no records, problem noted (unknown, not empty)', () => {
    for (const stored of ['{broken', '{"format":1,"chain":[],"marks":{"x":{"version":9}},"freshMarks":{},"halted":null}']) {
      const st = startTrust(doc('root-v1'), { record: stored }, C)
      assert.equal(st.root.document.version, 1)
      assert.deepEqual(st.marks, {})
      assert.ok(st.problem)
    }
  })

  it('B11 a second, properly signed root v2 with another text halts: nothing accepted, no code runs', () => {
    const { state, list, freshness } = v5WithFreshness()
    const onV2 = updateTrustRoot(state, [doc('root-v2')], C)
    const halted = updateTrustRoot(onV2, [doc('root-v2-conflict')], C)
    assert.ok(halted.halted)
    refusedWith(acceptTargets(halted, doc('t-c1-v6-tb'), CTX, C), 'halted')
    refusedWith(acceptFreshness(halted, doc('f-c1-v5'), list, CTX, C), 'halted')
    refusedWith(codeMayRunUntil(halted, list, freshness, CTX), 'halted')
    assert.ok(updateTrustRoot(start(), [doc('root-v2'), doc('root-v2-conflict')], C).halted, 'both in one answer')
  })

  it('B11b a conflicting text that does not authenticate is noise: no halt', () => {
    const onV2 = updateTrustRoot(start(), [doc('root-v2')], C)
    const st = updateTrustRoot(onV2, [doc('root-v2-noise')], C)
    assert.equal(st.halted, null)
    assert.equal(st.root.document.version, 2)
  })

  it('B12 the halt survives a restart; only an app carrying a newer root recovers', () => {
    const halted = updateTrustRoot(updateTrustRoot(start(), [doc('root-v2')], C), [doc('root-v2-conflict')], C)
    const stored = serializeTrustState(halted)
    const reborn = startTrust(doc('root-v1'), stored, C)
    assert.ok(reborn.halted)
    refusedWith(acceptTargets(reborn, doc('t-c1-v5'), CTX, C), 'halted')
    assert.ok(updateTrustRoot(reborn, [doc('root-v2'), doc('root-v3')], C).halted, 'newer roots from the server do not lift it')
    assert.ok(startTrust(doc('root-v2'), stored, C).halted, 'an app carrying the conflicted version itself does not lift it')
    const newer = startTrust(doc('root-v3'), stored, C)
    assert.equal(newer.halted, null)
    ok(acceptTargets(newer, doc('t-c1-v6-tb'), CTX, C))
  })
})

describe('C. the company\'s list', () => {
  it('C1 another company\'s list is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c2-v5'), CTX, C), 'other-company')
  })

  it('C2 another server\'s list is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v5-staging'), CTX, C), 'other-server')
  })

  it('C3 an older list after a newer one is refused, across a restart', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    const restarted = startTrust(doc('root-v1'), serializeTrustState(t.state), C)
    refusedWith(acceptTargets(restarted, doc('t-c1-v4'), CTX, C), 'rollback')
  })

  it('C4 the same version with other content is refused (the same text again is fine)', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptTargets(t.state, doc('t-c1-v5-other-content'), CTX, C), 'same-version-other-content')
    ok(acceptTargets(t.state, doc('t-c1-v5'), CTX, C))
  })

  it('C5 a list past its expiry is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v5'), { ...CTX, now: at('2027-01-20T00:00:00Z') }, C), 'expired')
  })

  it('C6 a clock set back below an issued already seen: the accepted list stops allowing code, and no list is accepted', () => {
    const t6 = ok(acceptTargets(start(), doc('t-c1-v6'), CTX, C))
    const f = ok(acceptFreshness(t6.state, doc('f-c1-v6'), t6.list, CTX, C))
    ok(codeMayRunUntil(f.state, t6.list, f.freshness, CTX))
    const back = { ...CTX, now: at('2026-11-21T05:00:00Z') }
    refusedWith(codeMayRunUntil(f.state, t6.list, f.freshness, back), 'clock-went-back')
    refusedWith(acceptTargets(t6.state, doc('t-c1-v5'), back, C), 'clock-went-back')
  })

  it('C7 a list issued in the future (beyond 10 minutes) is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v6-future'), CTX, C), 'issued-in-future')
  })

  it('C8 a list valid for more than 90 days is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v6-overlong'), CTX, C), 'lifetime-too-long')
  })

  it('C9 a version jump over 1000 is refused; exactly 1000 is accepted', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptTargets(t.state, doc('t-c1-v1006'), CTX, C), 'version-jump')
    ok(acceptTargets(t.state, doc('t-c1-v1005'), CTX, C))
  })

  it('C10 a higher version issued earlier than the last one is refused', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptTargets(t.state, doc('t-c1-v7-issued-back'), CTX, C), 'issued-went-back')
  })

  it('C11 one id@version listed twice is refused; a key the app does not know refuses the list', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-duplicate'), CTX, C), 'duplicate-package')
    refusedWith(acceptTargets(start(), doc('t-c1-extra-key'), CTX, C), 'targets-shape')
  })

  it('C12 a list signed by the freshness key (another role) is refused', () => {
    refusedWith(acceptTargets(start(), doc('t-c1-v5-by-fresh-key'), CTX, C), 'threshold')
  })

  it('C14 records are per server: staging\'s v4 after production\'s v5 is not a rollback', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    ok(acceptTargets(t.state, doc('t-c1-v4-staging'), { ...CTX, server: 'https://staging.example' }, C))
  })

  it('C15 an accepted list is usable only for its own server and company', () => {
    const { state, list, freshness } = v5WithFreshness()
    refusedWith(codeMayRunUntil(state, list, freshness, { ...CTX, companyId: 'c2' }), 'list-not-current')
    refusedWith(codeMayRunUntil(state, list, freshness, { ...CTX, server: 'https://staging.example' }), 'list-not-current')
  })
})

describe('D. a stolen signing key, recovered by rotation', () => {
  it('D1–D5 a huge version parked by the stolen key blocks the owner\'s list until root replaces the key; then the old key is refused', () => {
    const stolen = ok(acceptTargets(start(), doc('t-c1-huge'), CTX, C))
    refusedWith(acceptTargets(stolen.state, doc('t-c1-v6'), CTX, C), 'rollback')
    const rotated = updateTrustRoot(stolen.state, [doc('root-v2'), doc('root-v3')], C)
    assert.notEqual(roleGeneration(rotated.root, 'targets'), roleGeneration(start().root, 'targets'))
    ok(acceptTargets(rotated, doc('t-c1-v6-tb'), CTX, C))
    refusedWith(acceptTargets(rotated, doc('t-c1-huge'), CTX, C), 'threshold')
  })

  it('D6 a root that replaces the signing key revokes the list accepted under the old one', () => {
    const { state, list, freshness } = v5WithFreshness()
    const rotated = updateTrustRoot(state, [doc('root-v2'), doc('root-v3')], C)
    refusedWith(codeMayRunUntil(rotated, list, freshness, CTX), 'list-not-current')
  })
})

describe('H. freshness (the daily document)', () => {
  it('H1 a list and its freshness → code may run until the earliest expiry (the freshness one)', () => {
    const { state, list, freshness } = v5WithFreshness()
    assert.equal(ok(codeMayRunUntil(state, list, freshness, CTX)).until, at('2026-11-24T00:00:00Z'))
  })

  it('H2 a list without freshness → code may not run', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(codeMayRunUntil(t.state, t.list, null, CTX), 'no-freshness')
  })

  it('H3 freshness made for another list is refused', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptFreshness(t.state, doc('f-c1-for-v4'), t.list, CTX, C), 'other-list')
    const forged: AcceptedList = { ...t.list, sha256: '0'.repeat(64) }
    refusedWith(acceptFreshness(t.state, doc('f-c1-v5'), forged, CTX, C), 'list-not-current')
  })

  it('H4 freshness valid for more than 3 days is refused', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptFreshness(t.state, doc('f-c1-long'), t.list, CTX, C), 'lifetime-too-long')
  })

  it('H5 freshness signed by the signing key (another role) is refused', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptFreshness(t.state, doc('f-c1-by-targets-key'), t.list, CTX, C), 'threshold')
  })

  it('H6 freshness for another company or server is refused', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptFreshness(t.state, doc('f-c2'), t.list, CTX, C), 'other-company')
    refusedWith(acceptFreshness(t.state, doc('f-c1-staging'), t.list, CTX, C), 'other-server')
  })

  it('H7 freshness that tries to add a package is refused (closed shape)', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptFreshness(t.state, doc('f-c1-adds-package'), t.list, CTX, C), 'freshness-shape')
  })

  it('H8 an older freshness after a newer one is refused', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    const n2 = ok(acceptFreshness(t.state, doc('f-c1-v5-n2'), t.list, CTX, C))
    refusedWith(acceptFreshness(n2.state, doc('f-c1-v5'), t.list, CTX, C), 'rollback')
  })

  it('H9 the freshness runs out (the daily job stopped) → code may not run, and it is not accepted again', () => {
    const { state, list, freshness } = v5WithFreshness()
    const later = { ...CTX, now: at('2026-11-24T00:00:01Z') }
    refusedWith(codeMayRunUntil(state, list, freshness, later), 'expired')
    refusedWith(acceptFreshness(state, doc('f-c1-v5'), list, later, C), 'expired')
  })

  it('H10 after root replaces the freshness key, its records restart and the old key is refused', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    const n2 = ok(acceptFreshness(t.state, doc('f-c1-v5-n2'), t.list, CTX, C)) // version 2 under the old key
    const rotated = updateTrustRoot(n2.state, [doc('root-v2'), doc('root-v3')], C)
    const t6 = ok(acceptTargets(rotated, doc('t-c1-v6-tb'), CTX, C))
    const f = ok(acceptFreshness(t6.state, doc('f-c1-v6-tb-fresh-b'), t6.list, CTX, C)) // version 1 under the new key
    ok(codeMayRunUntil(f.state, t6.list, f.freshness, CTX))
    refusedWith(acceptFreshness(t6.state, doc('f-c1-v6-tb-fresh-a'), t6.list, CTX, C), 'threshold')
  })

  it('H11 freshness of a list that is no longer the current one does not let code run', () => {
    const { state, list, freshness } = v5WithFreshness()
    const t6 = ok(acceptTargets(state, doc('t-c1-v6'), CTX, C))
    refusedWith(codeMayRunUntil(t6.state, list, freshness, CTX), 'list-not-current')
    refusedWith(codeMayRunUntil(t6.state, t6.list, freshness, CTX), 'freshness-not-current')
  })

  it('H12 a freshness handle older than the recorded one is not the current freshness', () => {
    const { state, list, freshness } = v5WithFreshness()
    const n2 = ok(acceptFreshness(state, doc('f-c1-v5-n2'), list, CTX, C))
    refusedWith(codeMayRunUntil(n2.state, list, freshness, CTX), 'freshness-not-current')
    ok(codeMayRunUntil(n2.state, list, n2.freshness, CTX))
  })
})

// ---------------------------------------------------------------- review fixes (Codex, independent review)

/** An SSHSIG's fields, to rebuild a real signature with one thing changed. */
interface SigFields {
  magic: Buffer; version: number; publicKey: Buffer; namespace: Buffer; reserved: Buffer; hash: Buffer
  sigType: Buffer; sigRaw: Buffer; sigTrailing: Buffer; trailing: Buffer
}
function splitSig(armored: string): SigFields {
  const b = Buffer.from(armored.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''), 'base64')
  let o = 6
  const u32 = () => { const v = b.readUInt32BE(o); o += 4; return v }
  const str = () => { const n = u32(); const v = Buffer.from(b.subarray(o, o + n)); o += n; return v }
  const magic = Buffer.from(b.subarray(0, 6))
  const version = u32(); const publicKey = str(); const namespace = str(); const reserved = str(); const hash = str()
  const sig = str()
  const trailing = Buffer.from(b.subarray(o))
  let so = 0
  const sstr = () => { const n = sig.readUInt32BE(so); so += 4; const v = Buffer.from(sig.subarray(so, so + n)); so += n; return v }
  const sigType = sstr(); const sigRaw = sstr()
  return { magic, version, publicKey, namespace, reserved, hash, sigType, sigRaw, sigTrailing: Buffer.from(sig.subarray(so)), trailing }
}
function joinSig(f: SigFields): string {
  const str = (v: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(v.length); return Buffer.concat([l, v]) }
  const ver = Buffer.alloc(4)
  ver.writeUInt32BE(f.version)
  const sig = Buffer.concat([str(f.sigType), str(f.sigRaw), f.sigTrailing])
  const b64 = Buffer.concat([f.magic, ver, str(f.publicKey), str(f.namespace), str(f.reserved), str(f.hash), str(sig), f.trailing]).toString('base64')
  return `-----BEGIN SSH SIGNATURE-----\n${(b64.match(/.{1,70}/g) ?? []).join('\n')}\n-----END SSH SIGNATURE-----\n`
}

describe('review fixes', () => {
  it('R1 a stored chain with a malformed entry is not used: the app\'s root, no records, problem noted', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    const onV2 = updateTrustRoot(t.state, [doc('root-v2')], C)
    for (const junk of [{ signed: 5 }, 'junk', null, { signed: '{"version":"x"}', signatures: [] }]) {
      const record = JSON.parse(serializeTrustState(onV2).record)
      record.chain.splice(1, 0, junk)
      const st = startTrust(doc('root-v1'), { record: JSON.stringify(record) }, C)
      assert.equal(st.root.document.version, 1)
      assert.deepEqual(st.marks, {})
      assert.ok(st.problem, JSON.stringify(junk))
    }
  })

  it('R2 a key named "" is an unknown key at every level of every document', () => {
    const t = ok(acceptTargets(start(), doc('t-c1-v5'), CTX, C))
    refusedWith(acceptFreshness(t.state, doc('f-c1-empty-name-key'), t.list, CTX, C), 'freshness-shape')
    refusedWith(acceptTargets(start(), doc('t-c1-empty-name-key'), CTX, C), 'targets-shape')
    const env = doc('t-c1-v5')
    assert.equal(parseEnvelope({ ...env, '': 1 }), null)
    assert.equal(parseEnvelope({ ...env, signatures: [{ ...env.signatures[0], '': 1 }] }), null)
    const root = payload('root-v1')
    assert.ok(rootProblem({ ...root, '': 1 }))
    assert.ok(rootProblem({ ...root, roles: { ...root.roles, '': { keys: ['test-root-1'], threshold: 1 } } }))
    assert.ok(rootProblem({ ...root, roles: { ...root.roles, targets: { ...root.roles.targets, '': 1 } } }))
    const list = payload('t-c1-v5')
    assert.equal(parseTargets({ ...list, packages: [{ ...list.packages[0], '': 1 }] }).ok, false)
    const fresh = payload('f-c1-v5')
    assert.equal(parseFreshness({ ...fresh, targets: { ...fresh.targets, '': 1 } }).ok, false)
  })

  it('R3 a damaged record never lifts a halt: the halt file, the record\'s copy, or a halt left in a damaged record', () => {
    const halted = updateTrustRoot(updateTrustRoot(start(), [doc('root-v2')], C), [doc('root-v2-conflict')], C)
    const { record, halt } = serializeTrustState(halted)
    assert.ok(halt)
    const stays = (stored: { record?: string | null; halt?: string | null }, why: string) => {
      const st = startTrust(doc('root-v1'), stored, C)
      assert.ok(st.halted, why)
      refusedWith(acceptTargets(st, doc('t-c1-v5'), CTX, C), 'halted')
    }
    stays({ record: '{broken', halt }, 'record corrupt, halt file intact')
    stays({ record: null, halt }, 'record deleted, halt file intact')
    stays({ record, halt: null }, 'halt file deleted, record intact')
    stays({ record: record.slice(0, -5), halt: null }, 'halt file deleted, record damaged after its halt')
    stays({ record: '{broken', halt: 'garbage' }, 'halt file unreadable')
    assert.equal(startTrust(doc('root-v1'), { record: null, halt: null }, C).halted, null, 'both deleted: outside the threat model')
  })

  it('R4 code may run only until the verified expiry, whatever the handles\' documents say', () => {
    const { state, list, freshness } = v5WithFreshness()
    const longer = '2026-12-31T00:00:00Z'
    const editedList = { ...list, document: { ...list.document, expires: longer } }
    const editedFresh = { ...freshness, document: { ...freshness.document, expires: longer } }
    assert.equal(ok(codeMayRunUntil(state, editedList, editedFresh, CTX)).until, at('2026-11-24T00:00:00Z'))
    refusedWith(codeMayRunUntil(state, editedList, editedFresh, { ...CTX, now: at('2026-11-24T00:00:01Z') }), 'expired')
  })

  it('R5 junk offered for a version does not block the real root; two authentic texts in one answer halt', () => {
    const junk = { signed: '{"version":2}', signatures: [] }
    const st = updateTrustRoot(start(), [doc('root-v2-noise'), doc('root-v2-one-key'), junk, doc('root-v2'), doc('root-v3')], C)
    assert.equal(st.root.document.version, 3)
    assert.equal(st.halted, null)
    assert.ok(updateTrustRoot(start(), [doc('root-v2-conflict'), doc('root-v2')], C).halted)
  })

  it('R6 the SSHSIG reader takes only what ssh-keygen writes: version 1, empty reserved, sha256/512, matching types, nothing trailing', () => {
    const env = doc('root-v1')
    const good = env.signatures[0].sig
    const r1 = parseRoot(payload('root-v1'))
    assert.ok(r1.ok)
    const key = r1.root.keys.get('test-root-1') as SshPublicKey
    assert.equal(verifySshSig(joinSig(splitSig(good)), utf8(env.signed), TRUST_NAMESPACES.root, key, C), true)
    const variants: Array<[string, (f: SigFields) => void]> = [
      ['version 2', f => { f.version = 2 }],
      ['reserved not empty', f => { f.reserved = Buffer.from('x') }],
      ['hash sha384', f => { f.hash = Buffer.from('sha384') }],
      ['signature type differs from the key', f => { f.sigType = Buffer.from('ecdsa-sha2-nistp256') }],
      ['bytes after the signature', f => { f.trailing = Buffer.from([0]) }],
      ['bytes inside the signature after its value', f => { f.sigTrailing = Buffer.from([0]) }],
    ]
    for (const [why, change] of variants) {
      const f = splitSig(good)
      change(f)
      assert.equal(parseSshSig(joinSig(f)), null, why)
      assert.equal(verifySshSig(joinSig(f), utf8(env.signed), TRUST_NAMESPACES.root, key, C), false, why)
    }
  })

  it('R7 a signed text that is not well-formed Unicode is refused (it has no one UTF-8 form)', () => {
    const env = doc('t-c1-v5')
    assert.equal(parseEnvelope({ ...env, signed: env.signed.replace('lstep', 'lstep\uD800') }), null)
    assert.ok(parseEnvelope({ ...env, signed: env.signed.replace('lstep', 'lstep😀') }))
  })

  it('R8 times must be real calendar times', () => {
    assert.equal(parseTrustTime('2026-02-30T00:00:00Z'), null)
    assert.equal(parseTrustTime('2026-11-21T24:00:00Z'), null)
    assert.equal(parseTrustTime('2026-11-21T12:00:00.5Z'), at('2026-11-21T12:00:00.5Z'))
  })

  it('R9 a root update keeps the note that the stored record was not used', () => {
    const st = startTrust(doc('root-v1'), { record: '{broken' }, C)
    assert.ok(st.problem)
    assert.ok(updateTrustRoot(st, [doc('root-v2')], C).problem)
  })
})
