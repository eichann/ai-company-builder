/**
 * Plugin contract 3 (`.claude/rules/plugins.md` "Contract 3"): the declaration
 * of a connector's `calls`, how it is called and what the outside tells, and a
 * business plugin's use of them. Declaration only: nothing runs them yet.
 *
 * Guards:
 * - packages below contract 3 read exactly as before (no new key in the parsed
 *   manifest, the same fingerprint), and every new key is refused on them with
 *   the reason; a contract-3 package keeps contract 2's flow keys and fingerprint v2;
 * - unknown keys at every level, conditions, computation and transformations
 *   make the package unusable; every value is a closed choice or a plain name;
 * - a call's `who` names `role:`, `admin`, `ai`, with at least one person: `[ai]`
 *   alone would pass for any member's AI and `viewer` for anyone (`mayAct`);
 * - ACB does not bend for a service: `{id}` is a path's only placeholder, once; an
 *   error answer's `code` has no declared place; `returns` names fixed fields;
 * - personal data never goes in a URL: what travels in one is `class: normal`;
 * - every call says who acted (a member header) and which account and environment;
 * - what arrives by itself (polls, events) carries only normal fields or pointers;
 * - a header can never take over the key's, or one the way out owns;
 * - a combined use has only the calls and events the business plugin declared,
 *   and a call never reaches `operations`, which a released app turns into tools.
 */
import { createHash } from 'crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { diskPluginShelf } from '../../src/adapters/plugin-shelf'
import { createPluginShelf } from '../../src/services/plugin-shelf'
import {
  PLUGIN_CONTRACT_V3, combineUse, pluginFingerprintV2, validatePluginPackage, type PluginManifest, type PluginPackage,
} from '../../../shared/core/plugins'

const FIXTURES = join(__dirname, '../fixtures/plugins')
const sha256Hex = (d: Uint8Array | string) => createHash('sha256').update(d).digest('hex')

type Files = { manifest: string; types: Record<string, string>; mapping?: string | null; steps?: Record<string, string>; ui?: string[] }
function readPackage(name: string): Files {
  const dir = join(FIXTURES, name)
  const types: Record<string, string> = {}
  if (existsSync(join(dir, 'types'))) for (const f of readdirSync(join(dir, 'types'))) types[f.replace(/\.md$/, '')] = readFileSync(join(dir, 'types', f), 'utf8')
  const mapping = existsSync(join(dir, 'mapping.yaml')) ? readFileSync(join(dir, 'mapping.yaml'), 'utf8') : null
  return { manifest: readFileSync(join(dir, 'plugin.yaml'), 'utf8'), types, mapping }
}
const PORTAL = readPackage('sample-portal')
const CARE = readPackage('sample-portal-care')
const HUB = readPackage('sample-hub')
const SALES = readPackage('sample-sales')

function valid(files: Files): PluginPackage {
  const r = validatePluginPackage(files)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value
}
const errorsOf = (files: Files): string => {
  const r = validatePluginPackage(files)
  return r.ok ? '' : r.errors.join('\n')
}
function edited(files: Files, from: string, to: string): Files {
  if (!files.manifest.includes(from)) throw new Error(`not in the fixture: ${from}`)
  return { ...files, manifest: files.manifest.replace(from, to) }
}
const portalErrors = (from: string, to: string) => errorsOf(edited(PORTAL, from, to))
const careErrors = (from: string, to: string) => errorsOf(edited(CARE, from, to))
/** sample-portal-care's use of a call or event against sample-portal. */
function combineErrors(care: Files, portal: Files = PORTAL): string {
  const r = combineUse(valid(care), valid(portal).manifest)
  return r.ok ? '' : r.errors.join('\n')
}
const combined = (): PluginManifest => {
  const r = combineUse(valid(CARE), valid(PORTAL).manifest)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value.manifest
}

const DIAGNOSE_WHO = 'diagnose: { who: ["role:support", ai] }'
const RESEND_WHO = 'resend: { who: ["role:support", ai], decision: true }'

describe('plugin contract 3: what a connector declares', () => {
  it('reads every part of the sample connector', () => {
    const m = valid(PORTAL).manifest
    expect(m.contract).toBe(PLUGIN_CONTRACT_V3)
    expect(m.accountInfo).toEqual({ method: 'GET', path: '/account', idField: 'account_id', environmentField: 'environment' })
    expect(m.calling).toEqual({
      auth: { type: 'company_key', header: 'authorization', format: 'bearer', slots: ['read', 'act'] },
      actor: { memberHeader: 'X-Sample-Actor', emailHeader: 'X-Sample-Email' },
      limits: { perMinute: 60 },
      errors: { map: { STATE_CHANGED: 'check_wait', BAD_INPUT: 'refused' } },
      result: { path: '/operations/{id}', statusField: 'status', map: { done: 'applied', in_progress: 'pending', unknown_key: 'not_found' } },
      signature: { scheme: 'hmac_sha256_ts_body', header: 'X-Sample-Signature', timestampHeader: 'X-Sample-Timestamp', maxAge: '5m' },
    })
    expect(m.calls?.diagnose).toMatchObject({
      kind: 'read', path: '/people/{id}/diagnosis',
      returns: { name: { dataClass: 'personal', keep: 'summary', outside: true }, history: { each: { note: { dataClass: 'sensitive', keep: 'none', outside: false } } } },
    })
    expect(m.calls?.find_person).toMatchObject({ kind: 'search', items: 'people', inputs: { email: { dataClass: 'personal' } } })
    expect(m.calls?.resend).toMatchObject({ kind: 'act', nature: 'people', idempotency: { style: 'header' }, undo: 'none' })
    expect(m.calls?.pages).toMatchObject({ kind: 'document', page: { path: '/pages/{id}' }, list: { items: 'pages', cursor: { param: 'after', next: 'next_cursor' } }, search: { items: 'results' } })
    expect(m.polls?.events).toMatchObject({ path: '/events', items: 'events', typeField: 'type', every: '5m' })
    expect(m.operations).toEqual({})
  })

  it('a package below contract 3 reads as before: no new key in what is parsed, and the same fingerprint', async () => {
    for (const name of ['sample-hub', 'sample-crm', 'sample-desk', 'sample-sales', 'sample-crm-sales', 'sample-support']) {
      const m = valid(readPackage(name)).manifest
      for (const key of ['calling', 'calls', 'events', 'polls']) expect(m, `${name}: ${key}`).not.toHaveProperty(key)
      if (m.uses) expect(Object.keys(m.uses).sort(), name).toEqual(['connector', 'objects', 'operations'])
      if (m.accountInfo) expect(Object.keys(m.accountInfo).sort(), name).toEqual(['method', 'path'])
    }
    const use = combineUse(valid(SALES), valid(HUB).manifest)
    if (!use.ok) throw new Error(use.errors.join('\n'))
    for (const key of ['calling', 'calls', 'events', 'polls']) expect(use.value.manifest).not.toHaveProperty(key)

    const root = mkdtempSync(join(tmpdir(), 'acb-v3-'))
    try {
      cpSync(join(FIXTURES, 'sample-hub'), join(root, 'sample-hub@0.1.0'), { recursive: true })
      cpSync(join(FIXTURES, 'sample-portal'), join(root, 'sample-portal@1.0.0'), { recursive: true })
      const shelf = createPluginShelf(diskPluginShelf(root))
      await shelf.load()
      // Contract 1: v1, over path \0 text \0.
      const v1 = createHash('sha256').update('plugin.yaml\0').update(readFileSync(join(root, 'sample-hub@0.1.0/plugin.yaml'))).update('\0').digest('hex')
      expect(shelf.find('c', 'sample-hub', '0.1.0')?.fingerprint).toBe(v1)
      // Contract 3: v2.
      const dir = join(root, 'sample-portal@1.0.0')
      const walk = (d: string): string[] => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)])
      const files = walk(dir).map(p => ({ path: relative(dir, p), bytes: readFileSync(p) }))
      expect(shelf.find('c', 'sample-portal', '1.0.0')?.fingerprint).toBe(pluginFingerprintV2(files, sha256Hex))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses each new key below contract 3 with the reason', () => {
    const below = (contract: number) => PORTAL.manifest.replace('contract: 3', `contract: ${contract}`)
    for (const contract of [1, 2]) {
      const text = errorsOf({ manifest: below(contract), types: {} })
      for (const key of ['auth', 'actor', 'limits', 'errors', 'result', 'calls', 'events', 'signature', 'polls']) expect(text, `${key} at ${contract}`).toContain(`「${key}」は contract: 3 の包みだけに書けます`)
      for (const key of ['id_field', 'environment_field']) expect(text).toContain(`${key} は contract: 3 の包みだけに書けます`)
      const care = errorsOf({ ...CARE, manifest: CARE.manifest.replace('contract: 3', `contract: ${contract}`) })
      for (const key of ['calls', 'events']) expect(care, `${key} at ${contract}`).toContain(`「${key}」は contract: 3 の包みだけに書けます`)
    }
    // Each role's keys stay its own.
    for (const key of ['auth: {}', 'polls: {}', 'signature: {}', 'limits: {}', 'errors: {}', 'result: {}', 'actor: {}']) {
      expect(errorsOf({ ...CARE, manifest: `${CARE.manifest}${key}\n` }), key).toMatch(/つなぎ先のプラグイン（service のあるもの）だけに書けます/)
    }
    // A business plugin without a connector has nothing to call.
    expect(errorsOf({ ...CARE, manifest: CARE.manifest.replace('connector: sample-portal >= 1.0.0\n', '') })).toMatch(/「calls」は、つなぎ先を使う業務のプラグイン/)
  })

  it('a contract-3 package keeps what contract 2 gave it', () => {
    const m = valid(CARE).manifest
    expect(m.roles).toEqual({ support: { label: '窓口の担当', description: null } })
    // A connector never has a flow, whatever its contract.
    expect(errorsOf({ manifest: `${PORTAL.manifest}roles: {}\n`, types: {} })).toMatch(/業務のプラグインだけ/)
    // HubSpot's shape at contract 3: objects, operations and fixed calls are untouched.
    const hub = valid({ manifest: HUB.manifest.replace('contract: 1', 'contract: 3'), types: {} }).manifest
    expect({ ...hub, contract: 1 }).toEqual(valid(HUB).manifest)
  })

  it('refuses unknown keys at every level', () => {
    const cases: Array<[string, string]> = [
      ['contract: 3\n', 'contract: 3\nretries: 3\n'],
      ['auth: { type: company_key,', 'auth: { realm: x, type: company_key,'],
      ['account_info: { method: GET,', 'account_info: { retry: 1, method: GET,'],
      ['actor: { member_header', 'actor: { name_header: X-A, member_header'],
      ['limits: { per_minute: 60 }', 'limits: { per_minute: 60, burst: 2 }'],
      ['errors: { map:', 'errors: { fallback: refused, map:'],
      ['result: { path:', 'result: { every: 5m, path:'],
      ['    kind: read\n    path: "/people', '    kind: read\n    method: DELETE\n    path: "/people'],
      ['    kind: search\n', '    kind: search\n    method: GET\n'],
      ['id: { kind: id, class: normal }\n    returns', 'id: { kind: id, class: normal, default: x }\n    returns'],
      ['        each:\n', '        sort: x\n        each:\n'],
      ['name: { class: personal, keep: summary, outside: true }', 'name: { class: personal, keep: summary, outside: true, rename: x }'],
      ['    kind: document\n', '    kind: document\n    index: x\n'],
      ['      path: "/pages/{id}"\n', '      path: "/pages/{id}"\n      items: x\n'],
      ['      path: /pages\n', '      path: /pages\n      order: x\n'],
      ['cursor: { param: after, next: next_cursor }', 'cursor: { param: after, next: next_cursor, limit: 5 }'],
      ['idempotency: { style: header }', 'idempotency: { style: header, ttl: 5m }'],
      ['  recovered:\n    fields:', '  recovered:\n    severity: x\n    fields:'],
      ['signature: { scheme', 'signature: { secret_name: x, scheme'],
      ['    every: 5m\n', '    every: 5m\n    jitter: 1m\n'],
    ]
    for (const [from, to] of cases) expect(portalErrors(from, to), to).toMatch(/知らない項目|鍵の値は書けません/)
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: [admin], approve_by: x }')).toMatch(/知らない項目「approve_by」/)
    expect(careErrors('action: close_by_event }', 'action: close_by_event, then: x }')).toMatch(/知らない項目「then」/)
  })

  it('refuses conditions, computation and transformations: every value is a closed choice or a plain name', () => {
    // Keys someone might reach for.
    expect(portalErrors('    kind: act\n', '    kind: act\n    when: amount\n')).toMatch(/「when」: 条件は書けません/)
    expect(portalErrors('    kind: read\n    path: "/people', '    kind: read\n    if: x\n    path: "/people')).toMatch(/「if」: 条件は書けません/)
    expect(portalErrors('status: { class: normal, keep: summary }', 'status: { class: normal, keep: summary, expression: x }')).toMatch(/式は書けません/)
    expect(portalErrors('status: { class: normal, keep: summary }', 'status: { class: normal, keep: summary, transform: upper }')).toMatch(/知らない項目「transform」/)
    expect(portalErrors('    every: 5m\n', '    every: 5m\n    cron: x\n')).toMatch(/「cron」/)
    expect(portalErrors('    kind: act\n', '    kind: act\n    url: https://other.example\n')).toMatch(/送り先は base_url だけです/)
    // Values that try to be expressions.
    expect(portalErrors('status_field: status', 'status_field: "status.toUpperCase()"')).toMatch(/status_field は項目名/)
    expect(portalErrors('STATE_CHANGED: check_wait', '"code > 400": check_wait')).toMatch(/外の言葉/)
    expect(portalErrors('items: events', 'items: "events[0]"')).toMatch(/items は項目名/)
    // Closed choices.
    expect(portalErrors('nature: people', 'nature: dangerous')).toMatch(/nature は internal \/ people \/ money \/ irreversible/)
    expect(portalErrors('kind: act', 'kind: write')).toMatch(/kind は read \/ search \/ act \/ document/)
    expect(portalErrors('name: { class: personal,', 'name: { class: secret,')).toMatch(/class は normal \/ personal \/ sensitive/)
    expect(portalErrors('keep: summary, outside', 'keep: forever, outside')).toMatch(/keep は none \/ pointer \/ summary/)
    expect(portalErrors('outside: true', 'outside: maybe')).toMatch(/outside は true か false/)
    expect(portalErrors('STATE_CHANGED: check_wait', 'STATE_CHANGED: ignore')).toMatch(/refused \/ retry_later \/ check_wait \/ needs_person/)
    expect(portalErrors('done: applied', 'done: finished')).toMatch(/applied \/ pending \/ failed \/ not_found/)
    expect(portalErrors('type: company_key', 'type: member_key')).toMatch(/auth の type は company_key/)
    expect(portalErrors('format: bearer', 'format: template')).toMatch(/format は bearer \/ plain/)
    expect(portalErrors('slots: [read, act]', 'slots: [read, read]')).toMatch(/slots は/)
    expect(portalErrors('slots: [read, act]', 'slots: [write]')).toMatch(/slots は/)
    expect(portalErrors('scheme: hmac_sha256_ts_body', 'scheme: none')).toMatch(/scheme は hmac_sha256_ts_body/)
    expect(portalErrors('style: header', 'style: guess')).toMatch(/style は header/)
    expect(portalErrors('undo: none', 'undo: archive')).toMatch(/undo は none だけ/)
    expect(portalErrors('reason: { kind: text,', 'reason: { kind: json,')).toMatch(/kind は id \/ text/)
    expect(portalErrors('per_minute: 60', 'per_minute: 100000')).toMatch(/per_minute は 1〜600/)
    expect(portalErrors('max_age: 5m', 'max_age: 7d')).toMatch(/max_age は/)
    expect(portalErrors('    every: 5m', '    every: soon')).toMatch(/every は/)
  })

  it('a path has {id} as its only placeholder, once, as the fixed calls do', () => {
    const path = '"/people/{id}/diagnosis"'
    for (const to of ['"/people/{person_ref}/diagnosis"', '"/people/{id}/{kind}"', '"/{tenant}/people/{id}"']) expect(portalErrors(path, to), to).toMatch(/差し込みは \{id\} だけ/)
    expect(portalErrors(path, '"/people/{id}/{id}"')).toMatch(/\{id\} をちょうど1つ/)
    expect(portalErrors(path, '"/people/{id}/../admin"')).toMatch(/道の書き方が正しくありません/)
    expect(portalErrors(path, '"/people/{id}?all=1"')).toMatch(/\? や # は使えません/)
    expect(portalErrors(path, '"https://other.example/{id}"')).toMatch(/\? や # は使えません/)
    expect(portalErrors('"/operations/{id}"', '"/operations/{operation_id}"')).toMatch(/差し込みは \{id\} だけ/)
    expect(portalErrors('"/operations/{id}"', '/operations')).toMatch(/\{id\} をちょうど1つ/)
    expect(portalErrors('path: /events', 'path: "/events/{id}"')).toMatch(/\{id\} は書けません/)
    // {id} is filled by the required input `id`, a plain id; without a {id} there is no such input.
    const input = 'id: { kind: id, class: normal }\n    returns'
    expect(portalErrors(input, 'other: { kind: id, class: normal }\n    returns')).toMatch(/入力 id は、道の \{id\} を埋める/)
    expect(portalErrors(input, 'id: { kind: text, class: normal }\n    returns')).toMatch(/入力 id は、道の \{id\} を埋める/)
    expect(portalErrors(input, 'id: { kind: id, class: normal, required: false }\n    returns')).toMatch(/入力 id は、道の \{id\} を埋める/)
    expect(portalErrors('    kind: read\n    path: /status\n', '    kind: read\n    path: /status\n    inputs: { id: { kind: id, class: normal } }\n')).toMatch(/入力 id は、道の \{id\} を埋める/)
  })

  it('personal data never goes in a URL: a GET\'s inputs and {id} are class: normal, a POST\'s body may carry it', () => {
    const url = /URL に載る入力は class: normal だけです/
    const read = '    kind: read\n    path: /status\n'
    for (const c of ['personal', 'sensitive']) {
      expect(portalErrors(read, `${read}    inputs: { email: { kind: text, class: ${c} } }\n`), c).toMatch(url)
      expect(portalErrors('id: { kind: id, class: normal }\n    returns', `id: { kind: id, class: ${c} }\n    returns`), c).toMatch(url)
      expect(portalErrors('      path: /pages\n', `      path: /pages\n      inputs: { email: { kind: text, class: ${c} } }\n`), c).toMatch(url)
      expect(portalErrors('        id: { kind: id, class: normal }\n', `        id: { kind: id, class: normal }\n        email: { kind: text, class: ${c} }\n`), c).toMatch(url)
    }
    expect(portalErrors(read, `${read}    inputs: { day: { kind: date, class: normal } }\n`)).toBe('')
    // An {id} in a POST's URL too.
    expect(portalErrors('    path: /resend\n    inputs:\n', '    path: "/resend/{id}"\n    inputs:\n      id: { kind: id, class: personal }\n')).toMatch(url)
    // The fixture's search and act take personal inputs in the body: valid(PORTAL) above; a document's search too.
    expect(portalErrors('words: { kind: text, class: normal }', 'words: { kind: text, class: personal }')).toBe('')
  })

  it('an answer is read by fixed names: no path, wildcard or free-form object', () => {
    const name = 'name: { class: personal, keep: summary, outside: true }'
    for (const key of ['"history/note"', '"history[*].note"', '"a.b"', '"*"', '"{entry}"']) expect(portalErrors(name, `${key}: { class: normal, keep: none }`), key).toMatch(/項目名です/)
    // A list is `each` with fixed fields, one level deep.
    const note = '          note: { class: sensitive, keep: none }\n'
    expect(portalErrors(note, '          "*": { class: sensitive, keep: none }\n')).toMatch(/each の「\*」は項目名です/)
    expect(portalErrors(note, '          note:\n            each:\n              deep: { class: normal, keep: none }\n')).toMatch(/知らない項目「each」/)
    expect(portalErrors('        each:\n' + note, '        each: {}\n')).toMatch(/each は「項目/)
    expect(portalErrors('      history:\n        each:\n' + note, '      history: { class: normal, keep: none, each: { note: { class: normal, keep: none } } }\n')).toMatch(/知らない項目「class」/)
    expect(portalErrors('      history:\n        each:\n' + note, '      history: {}\n')).toMatch(/class は normal/)
    // The other answer fields are one name too.
    expect(portalErrors('status_field: status', 'status_field: data.status')).toMatch(/status_field は項目名/)
    expect(portalErrors('items: events', 'items: data.events')).toMatch(/items は項目名/)
    expect(portalErrors('type_field: type', 'type_field: data.type')).toMatch(/type_field は項目名/)
    expect(portalErrors('next: next_cursor }', 'next: paging.next }')).toMatch(/param \/ next は項目名/)
    expect(portalErrors('id_field: account_id', 'id_field: data.id')).toMatch(/id_field は項目名/)
    expect(portalErrors('environment_field: environment', 'environment_field: data.env')).toMatch(/environment_field は項目名/)
    expect(portalErrors('      person_ref: { class: personal, keep: pointer }\n      kind:', '      data.ref: { class: personal, keep: pointer }\n      kind:')).toMatch(/fields の「data.ref」は項目名/)
  })

  it('an error answer has one shape: no field to point at', () => {
    expect(portalErrors('errors: { map:', 'errors: { field: code, map:')).toMatch(/本文の一番上の code/)
    expect(portalErrors('errors: { map:', 'errors: { field: error.code, map:')).toMatch(/本文の一番上の code/)
  })

  it('every call says who acted: a member header, an address only if wanted; there is no key for a run with no member', () => {
    expect(portalErrors('member_header: X-Sample-Actor, ', '')).toMatch(/member_header: ヘッダーの名前/)
    expect(valid(edited(PORTAL, ', email_header: X-Sample-Email', '')).manifest.calling?.actor).toEqual({ memberHeader: 'X-Sample-Actor', emailHeader: null })
    expect(portalErrors('actor: { member_header', 'actor: { system: robot, member_header')).toMatch(/知らない項目「system」/)
    expect(portalErrors('actor: { member_header: X-Sample-Actor, email_header: X-Sample-Email }\n', '')).toMatch(/actor（誰の操作か/)
  })

  it('a header cannot take over the key or what the way out owns', () => {
    expect(portalErrors('member_header: X-Sample-Actor', 'member_header: Authorization')).toMatch(/ほかの役目/)
    expect(portalErrors('header: authorization, format: bearer', 'header: X-Key, format: bearer')).toBe('')
    expect(errorsOf(edited(edited(PORTAL, 'header: authorization, format: bearer', 'header: X-Key, format: bearer'), 'email_header: X-Sample-Email', 'email_header: x-key'))).toMatch(/ほかの役目/)
    expect(portalErrors('email_header: X-Sample-Email', 'email_header: x-sample-actor')).toMatch(/ほかの役目/)
    expect(portalErrors('timestamp_header: X-Sample-Timestamp', 'timestamp_header: X-Sample-Signature')).toMatch(/ほかの役目/)
    expect(portalErrors('header: X-Sample-Signature', 'header: X-Sample-Actor')).toMatch(/ほかの役目/)
    expect(portalErrors('member_header: X-Sample-Actor', 'member_header: Idempotency-Key')).toMatch(/ほかの役目/)
    expect(portalErrors('header: authorization, format: bearer', 'header: Idempotency-Key, format: bearer')).toMatch(/ほかの役目/)
    for (const h of ['Host', 'Cookie', 'X-HTTP-Method-Override', 'Transfer-Encoding']) expect(portalErrors('member_header: X-Sample-Actor', `member_header: ${h}`), h).toMatch(/本体が決めるヘッダー/)
    expect(portalErrors('header: authorization, format: bearer', 'header: Host, format: bearer')).toMatch(/本体が決めるヘッダー/)
    expect(portalErrors('member_header: X-Sample-Actor', 'member_header: "X Bad"')).toMatch(/ヘッダーの名前/)
  })

  it('an act can be told apart and never doubled: idempotency, the account, the key', () => {
    expect(portalErrors('    idempotency: { style: header }\n', '')).toMatch(/idempotency/)
    expect(portalErrors('account_info: { method: GET, path: /account, id_field: account_id, environment_field: environment }\n', '')).toMatch(/account_info/)
    expect(portalErrors(', id_field: account_id', '')).toMatch(/id_field と environment_field/)
    expect(portalErrors(', environment_field: environment', '')).toMatch(/id_field と environment_field/)
    expect(portalErrors('auth: { type: company_key, header: authorization, format: bearer, slots: [read, act] }\n', '')).toMatch(/auth（鍵の渡し方）/)
    expect(portalErrors('    nature: people\n', '')).toMatch(/nature は/)
    expect(portalErrors('    label: もう一度送る\n', '')).toMatch(/label を書いてください/)
    // A read that takes nothing has nothing to keep; returns is an allow-list.
    expect(portalErrors('    returns:\n      state: { class: normal, keep: none }\n', '')).toMatch(/returns（受け取る項目）/)
    // An act has no read-only twin: a read cannot carry what only an act may.
    expect(portalErrors('    kind: read\n    path: /status\n', '    kind: read\n    nature: people\n    path: /status\n')).toMatch(/知らない項目「nature」/)
    expect(portalErrors('    kind: search\n', '    kind: search\n    nature: people\n')).toMatch(/知らない項目「nature」/)
  })

  it('what arrives by itself carries only normal fields or pointers', () => {
    expect(portalErrors('      kind: { class: normal, keep: summary }\n', '      kind: { class: personal, keep: summary }\n')).toMatch(/class: normal か keep: pointer/)
    expect(portalErrors('      kind: { class: normal, keep: summary }\n', '      kind: { class: sensitive, keep: none }\n')).toMatch(/class: normal か keep: pointer/)
    expect(portalErrors('    every: 5m\n    fields:\n      person_ref: { class: personal, keep: pointer }', '    every: 5m\n    fields:\n      name: { class: personal, keep: summary }')).toMatch(/class: normal か keep: pointer/)
    // A call's answer is not limited: it was asked for, by someone allowed to.
    expect(portalErrors('status: { class: normal, keep: summary }', 'status: { class: sensitive, keep: summary }')).toBe('')
  })
})

describe('plugin contract 3: what a business plugin declares', () => {
  it('a call\'s who: role:, admin, ai only, with at least one person', () => {
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: [ai] }')).toMatch(/人（role:<名前> か admin）も書いて/)
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: [] }')).toMatch(/who は role:/)
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: {}')).toMatch(/who は role:/)
    for (const w of ['viewer', 'anyone', 'dept_manager', 'assignee', 'self']) {
      expect(careErrors(DIAGNOSE_WHO, `diagnose: { who: [${w}, ai] }`), w).toContain(`who「${w}」は書けません`)
    }
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: ["role:Not-A-Name"] }')).toMatch(/書けません/)
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: ["role:nobody", ai] }')).toMatch(/roles にない役割/)
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: [admin, ai] }')).toBe('')
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: ["role:support"] }')).toBe('')
    expect(careErrors(DIAGNOSE_WHO, 'diagnose: { who: [admin], decision: maybe }')).toMatch(/decision は true か false/)
  })

  it('an event names a real type, a field of it and an action of it', () => {
    expect(careErrors('type: inquiry, match', 'type: ghost, match')).toMatch(/型「ghost」/)
    expect(careErrors('match: person_ref', 'match: ghost')).toMatch(/match「ghost」は型「inquiry」の欄ではありません/)
    expect(careErrors('action: close_by_event', 'action: ghost')).toMatch(/action「ghost」は型「inquiry」の操作ではありません/)
    expect(careErrors('match: person_ref', 'match: "person_ref == 1"')).toMatch(/名前で書いてください/)
  })

  it('a combined use has only the calls and events the business plugin declared, with its who', () => {
    const m = combined()
    expect(Object.keys(m.calls ?? {}).sort()).toEqual(['diagnose', 'resend'])
    expect(m.calls?.resend).toMatchObject({ kind: 'act', who: ['role:support', 'ai'], decision: true })
    expect(m.calls?.diagnose).toMatchObject({ who: ['role:support', 'ai'], decision: false })
    expect(Object.keys(m.events ?? {})).toEqual(['recovered'])
    expect(m.events?.recovered.use).toEqual({ type: 'inquiry', match: 'person_ref', action: 'close_by_event' })
    expect(m.calling?.auth?.header).toBe('authorization')
    expect(Object.keys(m.polls ?? {})).toEqual(['events'])
    // The connector's own copy gets nobody: a use never writes into the part two business plugins share.
    const shared = valid(PORTAL).manifest
    combineUse(valid(CARE), shared)
    expect(shared.calls?.resend).toMatchObject({ who: [], decision: false })
    // Without an event it reacts to, the use has no polls.
    const noEvents = combineUse(valid({ ...CARE, manifest: CARE.manifest.replace(/events:\n.*\n/, '') }), valid(PORTAL).manifest)
    if (!noEvents.ok) throw new Error(noEvents.errors.join('\n'))
    expect(noEvents.value.manifest).not.toHaveProperty('events')
    expect(noEvents.value.manifest).not.toHaveProperty('polls')
  })

  it('refuses a use of what the connector lacks, and a decision on a read', () => {
    expect(combineErrors(edited(CARE, DIAGNOSE_WHO, 'ghost: { who: [admin] }'))).toMatch(/呼び出し「ghost」は「見本のポータル」1.0.0 にありません/)
    expect(combineErrors(edited(CARE, '  recovered: {', '  ghost: {'))).toMatch(/知らせ「ghost」は「見本のポータル」1.0.0 にありません/)
    expect(combineErrors(edited(CARE, DIAGNOSE_WHO, 'diagnose: { who: [admin], decision: true }'))).toMatch(/読む呼び出しは decision にできません/)
    // The type's field exists, the event does not carry it.
    const care = { ...CARE, types: { inquiry: CARE.types.inquiry.replace('  person_ref:', '  other_ref:  { label: 別の番号, kind: text, source: server }\n  person_ref:') } }
    expect(combineErrors(edited(care, 'match: person_ref', 'match: other_ref'))).toMatch(/match「other_ref」は「見本のポータル」の知らせの項目にありません/)
  })

  it('a call never reaches operations, which a released app turns into tools', () => {
    // pluginToolSpecs sends any kind it does not know to its update tool.
    expect(Object.keys(combined().operations)).toEqual([])
    for (const kind of ['act', 'document']) {
      expect(errorsOf({ manifest: `${HUB.manifest.replace('kind: read', `kind: ${kind}`)}`, types: {} }), kind).toMatch(/kind は read \/ update \/ create \/ search/)
    }
    // Used through the wrong map, it is refused with where it belongs; a call is not an operation either.
    const operations = CARE.manifest.replace('calls:\n', 'operations:\n').replace(/\n {2}diagnose.*$/m, '').replace(`${RESEND_WHO}`, 'resend: { who: [admin] }')
    expect(combineErrors({ ...CARE, manifest: operations })).toMatch(/呼び出しです。operations ではなく calls に書きます/)
    const hub = valid({ manifest: HUB.manifest.replace('contract: 1', 'contract: 3'), types: {} }).manifest
    const use = combineUse(valid({ ...SALES, manifest: `${SALES.manifest.replace('contract: 1', 'contract: 3')}calls:\n  update_deal: { who: [admin] }\n` }), hub)
    expect(use.ok ? '' : use.errors.join('\n')).toMatch(/呼び出し「update_deal」は.*にありません/)
    // A call and an operation of one name would be one tool.
    const clash = PORTAL.manifest.replace('calls:\n', 'objects:\n  person:\n    get: { method: GET, path: "/p/{id}" }\noperations:\n  resend: { label: 読む, kind: read, object: person }\ncalls:\n')
    expect(errorsOf({ manifest: clash, types: {} })).toMatch(/呼び出し「resend」: 同じ名前の操作があります/)
  })
})
