/**
 * Browser connectors (`.claude/rules/plugins.md` "Browser connectors (contract
 * only)", `shared/core/plugin-browser-declaration.ts`): the declaration of a site
 * the chat AI operates in the app's browser window, through per-site operation
 * types only. Contract only: nothing runs them yet.
 *
 * Guards:
 * - a browser connector is data only and nothing of an API connector or a
 *   business plugin; unknown keys at every level make it unusable;
 * - exact hosts (no `*.`, the operated host never an asset host);
 * - a read type writes nothing; a write / delete type names the only requests it
 *   may send, each tied to the plan's target, every plan field in some request;
 *   DELETE only for a delete type; fixed paths; a body value is a literal or one
 *   whole plan field, never a template;
 * - `matchDeclaredWrite`: exact method and path, every declared key with the
 *   plan's value, no other key but `ignore_body`, no repeated key, the plan's
 *   values of their kinds — what stops an approved save from becoming a broadcast;
 * - the company's setting decides which types may run (`browserOperationsAllowed`);
 * - no business plugin can use one yet (`combineUse`); the shelf refuses one
 *   (`plugin-shelf.test.ts`).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  browserOperationsAllowed, combineUse, expectedAfter, matchDeclaredWrite, parsePluginManifest, validatePluginPackage,
  type BrowserOperation, type BrowserPlanValues, type BrowserWriteRequest, type PluginManifest,
} from '../../../shared/core/plugins'
import { levelAllows, type BrowserOperationEffect, type BrowserOperationSettings } from '../../../shared/core/browser-operation'

const FIXTURES = join(__dirname, '../fixtures/plugins')
const fixture = (pkg: string, file: string) => readFileSync(join(FIXTURES, pkg, file), 'utf8')

const LSTEP = `id: lstep
version: 0.1.0
label: Lステップ
contract: 1
browser:
  host: manager.linestep.net
  asset_hosts: [d1nhtjid4lgi9y.cloudfront.net, profile.line-scdn.net]
  account:
    label: LINE アカウント
  operations:
    reminder_step_template:
      label: リマインダの段のテンプレートを付け替える
      effect: write
      checker: lstep.reminder_step_template
      lock: { kind: lstep.reminder_step }
      delivers: none
      shared: 全部の回で共有のリマインダです。前の回の人にも届きます。
      irreversible: false
      target:
        reminder: id
        step: id
      change:
        template: id
      writes:
        - method: POST
          path: /line/episode/step/pack/template
          body: { content_id: "{step}", template_id: "{template}", pack_id: "{reminder}", mode: replace }
          ignore_body: [_token, _lm_user_id]
      expect:
        - { list: templates, add: "{template}" }
      facts:
        account: { required: true }
        state: { required: true, complete: true }
    read_reminder:
      label: リマインダを読む
      effect: read
      delivers: none
      checker: lstep.read_reminder
      target:
        reminder: id
    remove_step:
      label: リマインダの段を消す
      effect: delete
      checker: lstep.remove_step
      irreversible: true
      lock: { kind: lstep.step }
      delivers: unknown
      facts:
        account: { required: true }
      target:
        step: id
      writes:
        - method: DELETE
          path: /line/episode/step
          encoding: json
          body: { id: "{step}" }
      expect:
        - { list: steps, remove: "{step}" }
`

function parse(text: string): PluginManifest {
  const r = parsePluginManifest(text)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value
}
const errorsOf = (text: string): string => {
  const r = parsePluginManifest(text)
  return r.ok ? '' : r.errors.join('\n')
}
/** LSTEP with one exact piece of text replaced (the replacement must apply). */
function edit(from: string, to: string): string {
  expect(LSTEP).toContain(from)
  return LSTEP.replace(from, to)
}

describe('a browser connector declaration', () => {
  it('parses the example: a connector with the site and its operation types, nothing of an API connector', () => {
    const m = parse(LSTEP)
    expect(m.role).toBe('connector')
    expect(m.service).toBe('')
    expect(m.operations).toEqual({})
    expect(m.objects).toEqual({})
    const b = m.browser!
    expect(b.host).toBe('manager.linestep.net')
    expect(b.assetHosts).toEqual(['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'])
    expect(b.account).toEqual({ label: 'LINE アカウント' })
    const op = b.operations.reminder_step_template
    expect(op).toMatchObject({ effect: 'write', checker: 'lstep.reminder_step_template', irreversible: false, shared: '全部の回で共有のリマインダです。前の回の人にも届きます。' })
    expect(op.target).toEqual({ reminder: 'id', step: 'id' })
    expect(op.writes).toEqual([{
      method: 'POST', path: '/line/episode/step/pack/template', encoding: 'form',
      body: { content_id: { field: 'step' }, template_id: { field: 'template' }, pack_id: { field: 'reminder' }, mode: { literal: 'replace' } },
      ignoreBody: ['_token', '_lm_user_id'],
    }])
    expect(b.operations.read_reminder).toMatchObject({ effect: 'read', writes: [], change: {}, shared: null })
    expect(b.operations.remove_step).toMatchObject({ effect: 'delete', irreversible: true })
    expect(b.operations.remove_step.writes[0].encoding).toBe('json')
    // A package of it is valid as a whole (no types, no mapping).
    expect(validatePluginPackage({ manifest: LSTEP, types: {} }).ok).toBe(true)
  })

  it('an API connector without browser has no browser part (packages read as before)', () => {
    for (const pkg of ['sample-hub', 'sample-sales']) {
      const m = parse(fixture(pkg, 'plugin.yaml'))
      expect('browser' in m, pkg).toBe(false)
    }
  })

  it('refuses mixing with an API connector, a business plugin or the flow keys', () => {
    expect(errorsOf(`${LSTEP}service: hubspot\n`)).toContain('service（API のつなぎ先）と browser（ブラウザのつなぎ先）は一緒に書けません')
    for (const extra of ['base_url: https://api.example.com', 'scopes: [a]', 'account_info: { method: GET, path: /a }', 'objects: {}', 'operations: {}',
      'types: [deal]', 'connector: hub >= 0.1.0', 'field_policy_defaults: {}', 'notification_senders: [a@example.com]', 'calls: {}', 'auth: {}', 'steps: {}', 'ui: {}']) {
      const key = extra.split(':')[0]
      expect(errorsOf(`${LSTEP}${extra}\n`), extra).toContain(`「${key}」はブラウザのつなぎ先`)
    }
  })

  it('unknown keys at every level make it unusable, a program or another destination with its reason', () => {
    expect(errorsOf(`${LSTEP}script: run.sh\n`)).toContain('プログラムは書けません')
    expect(errorsOf(edit('  host: manager.linestep.net\n', '  host: manager.linestep.net\n  url: https://evil.example\n'))).toContain('「url」')
    expect(errorsOf(edit('    label: LINE アカウント\n', '    label: LINE アカウント\n    id: 1\n'))).toContain('知らない項目「id」')
    expect(errorsOf(edit('      irreversible: false\n', '      irreversible: false\n      code: "click()"\n'))).toContain('プログラムは書けません')
    expect(errorsOf(edit('          ignore_body: [_token, _lm_user_id]\n', '          ignore_body: [_token, _lm_user_id]\n          query: { a: b }\n'))).toContain('知らない項目「query」')
  })

  it('exact hosts only: no wildcard, IP, other spelling, and the operated host is no asset host', () => {
    expect(errorsOf(edit('  host: manager.linestep.net\n', '  host: "*.linestep.net"\n'))).toContain('browser の host')
    expect(errorsOf(edit('  host: manager.linestep.net\n', '  host: Manager.Linestep.net\n'))).toContain('browser の host')
    expect(errorsOf(edit('  host: manager.linestep.net\n', '  host: 10.0.0.1\n'))).toContain('browser の host')
    expect(errorsOf(edit('profile.line-scdn.net]', '"*.line-scdn.net"]'))).toContain('asset_hosts')
    expect(errorsOf(edit('profile.line-scdn.net]', 'manager.linestep.net]'))).toContain('操作するサイトのホストは書けません')
    expect(errorsOf(edit('profile.line-scdn.net]', 'd1nhtjid4lgi9y.cloudfront.net]'))).toContain('2回あります')
  })

  it('names, labels, notes and the checker are plain and bounded', () => {
    expect(errorsOf(edit('    reminder_step_template:\n', '    ReminderStep:\n'))).toContain('操作の名前「ReminderStep」')
    expect(errorsOf(edit('      label: リマインダを読む\n', `      label: "${'あ'.repeat(61)}"\n`))).toContain('label は 60 文字まで')
    expect(errorsOf(edit('      label: リマインダを読む\n', '      label: "読む\\u0007"\n'))).toContain('label は 60 文字まで')
    // Bidirectional and zero-width characters make text read differently from what it is.
    for (const ch of ['\\u200b', '\\u200f', '\\u202e', '\\u2066', '\\u061c', '\\ufeff']) {
      expect(errorsOf(edit('      label: リマインダを読む\n', `      label: "読${ch}む"\n`)), ch).toContain('label は 60 文字まで')
      expect(errorsOf(edit('      shared: 全部の回で共有のリマインダです。前の回の人にも届きます。\n', `      shared: "前の回${ch}"\n`)), ch).toContain('shared は 200 文字まで')
      expect(errorsOf(edit('    label: LINE アカウント\n', `    label: "LINE${ch}"\n`)), ch).toContain('account の label')
    }
    expect(errorsOf(edit('      shared: 全部の回で共有のリマインダです。前の回の人にも届きます。\n', `      shared: "${'あ'.repeat(201)}"\n`))).toContain('shared は 200 文字まで')
    expect(errorsOf(edit('      checker: lstep.read_reminder\n', '      checker: lstep\n'))).toContain('checker は「サイト.確かめるもの」')
    expect(errorsOf(edit('      checker: lstep.read_reminder\n', '      checker: "../evil.js"\n'))).toContain('checker は「サイト.確かめるもの」')
    // The key of 2026-11-20 says what replaced it.
    expect(errorsOf(edit('      checker: lstep.read_reminder\n', '      adapter: lstep.read_reminder\n'))).toContain('adapter は checker に変わりました')
    expect(errorsOf(edit('        step: id\n      change:', '        step: number\n      change:'))).toContain('id か text')
    expect(errorsOf(edit('        step: id\n      change:', '        Step: id\n      change:'))).toContain('名前「Step」')
  })

  it('a read writes nothing; a write or delete names its writes; irreversible only where something changes', () => {
    const readWithWrites = edit('      checker: lstep.read_reminder\n      target:\n        reminder: id\n',
      '      checker: lstep.read_reminder\n      target:\n        reminder: id\n      writes:\n        - method: POST\n          path: /a\n          body: { a: "{reminder}" }\n')
    expect(errorsOf(readWithWrites)).toContain('読むだけの操作に writes は書けません')
    expect(errorsOf(edit('      checker: lstep.read_reminder\n', '      checker: lstep.read_reminder\n      change: { x: id }\n'))).toContain('読むだけの操作に change は書けません')
    expect(errorsOf(edit('      checker: lstep.read_reminder\n', '      checker: lstep.read_reminder\n      irreversible: true\n'))).toContain('irreversible は書けません')
    const noWrites = edit(`      writes:
        - method: DELETE
          path: /line/episode/step
          encoding: json
          body: { id: "{step}" }
`, '')
    expect(errorsOf(noWrites)).toContain('操作「remove_step」の writes')
    expect(errorsOf(edit('      effect: delete\n', '      effect: remove\n'))).toContain('effect は read / write / delete')
    // A deletion always gets the confirmation right before it.
    expect(errorsOf(edit('      checker: lstep.remove_step\n      irreversible: true\n', '      checker: lstep.remove_step\n'))).toContain('irreversible: true を書いてください')
    expect(errorsOf(edit('      checker: lstep.remove_step\n      irreversible: true\n', '      checker: lstep.remove_step\n      irreversible: false\n'))).toContain('irreversible: true を書いてください')
    expect(errorsOf(edit('      target:\n        reminder: id\n    remove_step', '    remove_step'))).toContain('target（何を変えるか）')
    expect(errorsOf(edit('      change:\n        template: id\n', '      change:\n        template: id\n        step: text\n'))).toContain('target と change の両方')
  })

  it('a write type cannot send DELETE; GET is never a declared write', () => {
    expect(errorsOf(edit('        - method: POST\n', '        - method: DELETE\n'))).toContain('DELETE は effect: delete')
    expect(errorsOf(edit('        - method: POST\n', '        - method: GET\n'))).toContain('GET は書きません')
  })

  it('a path is fixed and absolute: no scheme, host, query, fragment, placeholder, // or ..', () => {
    for (const bad of ['https://manager.linestep.net/a', '//evil.example/a', '/a?x=1', '/a#b', '/a/{step}', '/a//b', '/a/../b', 'line/a', '/a%2fb']) {
      expect(errorsOf(edit('path: /line/episode/step/pack/template', `path: "${bad}"`)), bad).toContain('path は / で始まる決まった道')
    }
  })

  it('a body value is a literal or one whole declared field; every plan field reaches a write, and each write names the target', () => {
    expect(errorsOf(edit('template_id: "{template}"', 'template_id: "{tmpl}"'))).toContain('{tmpl} は target にも change にもありません')
    expect(errorsOf(edit('template_id: "{template}"', 'template_id: "t-{template}"'))).toContain('決まった文字か {名前} ひとつだけ')
    expect(errorsOf(edit('mode: replace', 'mode: 1'))).toContain('文字で書いてください')
    expect(errorsOf(edit(', template_id: "{template}"', ''))).toContain('「template」は writes のどの body にも入っていません')
    // A target field may stay out of the request (Lステップ's request names the step, not its
    // reminder): the app's checker confirms the whole target before the write.
    const reminderOnlyRead = parse(edit(', pack_id: "{reminder}"', '')).browser!.operations.reminder_step_template
    expect(reminderOnlyRead.target).toEqual({ reminder: 'id', step: 'id' })
    expect(reminderOnlyRead.writes[0].body.pack_id).toBeUndefined()
    // Only change fields and literals: the request would fit any target.
    const noTarget = edit('body: { content_id: "{step}", template_id: "{template}", pack_id: "{reminder}", mode: replace }', 'body: { template_id: "{template}" }')
    expect(errorsOf(noTarget)).toContain('target の項目を1つ以上')
    expect(errorsOf(edit('ignore_body: [_token, _lm_user_id]', 'ignore_body: [_token, mode]'))).toContain('body にもあります')
    expect(errorsOf(edit('ignore_body: [_token, _lm_user_id]', 'ignore_body: [_token, _token]'))).toContain('2回あります')
    // A method override is never declared, in the body or as an ignored field.
    expect(errorsOf(edit('mode: replace', '_method: PUT'))).toContain('「_method」は書けません')
    expect(errorsOf(edit('mode: replace', '_METHOD: PUT'))).toContain('「_METHOD」は書けません')
    expect(errorsOf(edit('ignore_body: [_token, _lm_user_id]', 'ignore_body: [_token, _Method]'))).toContain('「_Method」は書けません')
    expect(errorsOf(edit('          encoding: json\n', '          encoding: xml\n'))).toContain('encoding は form か json')
  })

  it('what a type must leave behind is closed choices: added to or removed from a list, by one plan field', () => {
    const op = parse(LSTEP).browser!
    expect(op.operations.reminder_step_template.expect).toEqual([{ list: 'templates', change: 'add', field: 'template' }])
    expect(op.operations.remove_step.expect).toEqual([{ list: 'steps', change: 'remove', field: 'step' }])
    expect(op.operations.read_reminder.expect).toEqual([])
    const addLine = '      expect:\n        - { list: templates, add: "{template}" }\n'
    // A type that changes something says what the page must show afterwards: the runner judges by it.
    expect(errorsOf(edit(addLine, ''))).toContain('操作「reminder_step_template」の expect')
    expect(errorsOf(edit(addLine, '      expect: []\n'))).toContain('1〜5 個')
    expect(errorsOf(edit('      checker: lstep.read_reminder\n', '      checker: lstep.read_reminder\n      expect:\n        - { list: a, add: "{reminder}" }\n'))).toContain('読むだけの操作に expect は書けません')
    // No computation, condition or text around a field: exactly one of add / remove, one whole plan field.
    for (const [bad, why] of [
      ['{ list: templates, add: "{template}", remove: "{template}" }', 'add か remove のどちらか1つ'],
      ['{ list: templates }', 'add か remove のどちらか1つ'],
      ['{ list: templates, add: "{tmpl}" }', 'target か change の {名前} ひとつ'],
      ['{ list: templates, add: "t-{template}" }', 'target か change の {名前} ひとつ'],
      ['{ list: templates, add: "301" }', 'target か change の {名前} ひとつ'],
      ['{ list: Templates, add: "{template}" }', 'list は英小文字'],
      ['{ list: templates, add: "{template}", when: "{step}" }', 'when'],
    ] as const) {
      expect(errorsOf(edit(addLine, `      expect:\n        - ${bad}\n`)), bad).toContain(why)
    }
    const six = Array.from({ length: 6 }, () => '        - { list: templates, add: "{template}" }\n').join('')
    expect(errorsOf(edit(addLine, `      expect:\n${six}`))).toContain('1〜5 個')
  })

  it('expectedAfter applies the expectations to the state the person saw; a removal of what is not there cannot come true', () => {
    const ops = parse(LSTEP).browser!.operations
    const values = { target: { reminder: '101', step: '201' }, change: { template: '301' } }
    expect(expectedAfter({ templates: ['300'] }, ops.reminder_step_template, values)).toEqual({ templates: ['300', '301'] })
    // A list the page did not have yet starts empty; other lists stay as they were.
    expect(expectedAfter({ other: ['1'] }, ops.reminder_step_template, values)).toEqual({ other: ['1'], templates: ['301'] })
    // A removal takes one copy; the state the person saw is not changed.
    const before = { steps: ['201', '201', '202'] }
    expect(expectedAfter(before, ops.remove_step, { target: { step: '201' }, change: {} })).toEqual({ steps: ['201', '202'] })
    expect(before).toEqual({ steps: ['201', '201', '202'] })
    expect(expectedAfter({ steps: ['202'] }, ops.remove_step, { target: { step: '201' }, change: {} })).toBeNull()
    expect(expectedAfter({}, ops.remove_step, { target: { step: '201' }, change: {} })).toBeNull()
    // A replacement is one of each, in order.
    const swap = { ...ops.reminder_step_template, expect: [{ list: 'templates', change: 'add' as const, field: 'template' }, { list: 'templates', change: 'remove' as const, field: 'step' }] }
    expect(expectedAfter({ templates: ['201'] }, swap, values)).toEqual({ templates: ['301'] })
  })

  it('a type that writes needs the account the plan is bound to', () => {
    expect(errorsOf(edit('  account:\n    label: LINE アカウント\n', ''))).toContain('browser の account')
  })

  it('counts are capped', () => {
    const many = Array.from({ length: 31 }, (_, i) => `    r${i}:\n      label: 読む\n      effect: read\n      checker: lstep.r${i}\n      delivers: none\n      target: { a: id }\n`).join('')
    expect(errorsOf(`id: lstep\nversion: 0.1.0\nlabel: L\ncontract: 1\nbrowser:\n  host: manager.linestep.net\n  operations:\n${many}`)).toContain('operations は 30 個まで')
    const fields = Array.from({ length: 11 }, (_, i) => `f${i}: id`).join(', ')
    expect(errorsOf(edit('      target:\n        reminder: id\n    remove_step', `      target: { ${fields} }\n    remove_step`))).toContain('10 個まで')
  })
})

describe('matchDeclaredWrite: only the declared write with the approved values goes out', () => {
  const op = (): BrowserOperation => parse(LSTEP).browser!.operations.reminder_step_template
  const plan: BrowserPlanValues = { target: { reminder: '12', step: '345' }, change: { template: '678' } }
  const request = (over: Partial<BrowserWriteRequest> = {}): BrowserWriteRequest => ({
    method: 'POST', path: '/line/episode/step/pack/template', query: [], headers: { 'content-type': 'application/x-www-form-urlencoded' }, encoding: 'form',
    body: [['_token', 'csrf'], ['content_id', '345'], ['template_id', '678'], ['pack_id', '12'], ['mode', 'replace']],
    ...over,
  })

  it('the exact request passes (in any key order)', () => {
    expect(matchDeclaredWrite(op(), plan, request())).toEqual({ match: true, write: 0 })
    expect(matchDeclaredWrite(op(), plan, request({ body: [['mode', 'replace'], ['pack_id', '12'], ['template_id', '678'], ['content_id', '345']] }))).toEqual({ match: true, write: 0 })
  })

  it('a query string is refused (no declared write has one)', () => {
    expect(matchDeclaredWrite(op(), plan, request({ query: [['all', '1']] }))).toMatchObject({ match: false, reason: 'query' })
    expect(matchDeclaredWrite(op(), plan, request({ query: [['_token', 'x']] }))).toMatchObject({ match: false, reason: 'query' })
    expect(matchDeclaredWrite(op(), plan, request({ query: undefined as unknown as [] }))).toMatchObject({ match: false, reason: 'query' })
  })

  it('a method override, by header or by a _method key, is refused', () => {
    for (const h of ['X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override']) {
      expect(matchDeclaredWrite(op(), plan, request({ headers: { [h]: 'DELETE' } })), h).toMatchObject({ match: false, reason: 'method-override' })
    }
    const body = request().body as Array<[string, string]>
    expect(matchDeclaredWrite(op(), plan, request({ body: [...body, ['_method', 'DELETE']] }))).toMatchObject({ match: false, reason: 'method-override' })
    expect(matchDeclaredWrite(op(), plan, request({ body: [...body, ['_METHOD', 'DELETE']] }))).toMatchObject({ match: false, reason: 'method-override' })
  })

  it('another method, path or encoding is not a declared write', () => {
    expect(matchDeclaredWrite(op(), plan, request({ method: 'PUT' }))).toMatchObject({ match: false, reason: 'not-declared' })
    expect(matchDeclaredWrite(op(), plan, request({ method: 'post' }))).toMatchObject({ match: false, reason: 'not-declared' })
    expect(matchDeclaredWrite(op(), plan, request({ path: '/line/episode/step/pack/template/' }))).toMatchObject({ match: false, reason: 'not-declared' })
    // The raw path, not decoded: an encoded spelling of the declared path is another path.
    expect(matchDeclaredWrite(op(), plan, request({ path: '/line/episode/step/pack/%74emplate' }))).toMatchObject({ match: false, reason: 'not-declared' })
    expect(matchDeclaredWrite(op(), plan, request({ path: '/line/broadcast' }))).toMatchObject({ match: false, reason: 'not-declared' })
    expect(matchDeclaredWrite(op(), plan, request({ encoding: 'json' }))).toMatchObject({ match: false, reason: 'encoding' })
  })

  it('a changed target or value refuses, naming the key', () => {
    const swap = (k: string, v: string) => request({ body: (request().body as Array<[string, string]>).map(([a, b]) => [a, a === k ? v : b] as [string, string]) })
    expect(matchDeclaredWrite(op(), plan, swap('content_id', '999'))).toEqual({ match: false, reason: 'wrong-value', key: 'content_id' })
    expect(matchDeclaredWrite(op(), plan, swap('pack_id', '13'))).toEqual({ match: false, reason: 'wrong-value', key: 'pack_id' })
    expect(matchDeclaredWrite(op(), plan, swap('template_id', '1'))).toEqual({ match: false, reason: 'wrong-value', key: 'template_id' })
    expect(matchDeclaredWrite(op(), plan, swap('mode', 'all'))).toEqual({ match: false, reason: 'wrong-value', key: 'mode' })
    // The value of another plan field in this key is still the wrong value.
    expect(matchDeclaredWrite(op(), plan, swap('content_id', '12'))).toEqual({ match: false, reason: 'wrong-value', key: 'content_id' })
  })

  it('an extra undeclared key refuses; a missing key refuses; a repeated key refuses', () => {
    const body = request().body as Array<[string, string]>
    expect(matchDeclaredWrite(op(), plan, request({ body: [...body, ['send_all', '1']] }))).toEqual({ match: false, reason: 'extra-key', key: 'send_all' })
    expect(matchDeclaredWrite(op(), plan, request({ body: body.filter(([k]) => k !== 'mode') }))).toEqual({ match: false, reason: 'missing-key', key: 'mode' })
    expect(matchDeclaredWrite(op(), plan, request({ body: [...body, ['content_id', '999']] }))).toEqual({ match: false, reason: 'repeated-key', key: 'content_id' })
  })

  it('ignore_body keys may come with any value, or not at all', () => {
    const body = request().body as Array<[string, string]>
    expect(matchDeclaredWrite(op(), plan, request({ body: [...body, ['_lm_user_id', 'u1']] }))).toEqual({ match: true, write: 0 })
    expect(matchDeclaredWrite(op(), plan, request({ body: body.filter(([k]) => k !== '_token') }))).toEqual({ match: true, write: 0 })
  })

  it('a body that is not pairs of strings is refused, in an ignored field too', () => {
    const body = request().body as Array<[string, string]>
    const odd = (b: unknown) => request({ body: b as Array<[string, string]> })
    // A JSON body handed as an object (it may have lost a repeated key) is not accepted: pairs only.
    expect(matchDeclaredWrite(op(), plan, odd({ content_id: '345', template_id: '678', pack_id: '12', mode: 'replace' }))).toMatchObject({ match: false, reason: 'body-shape' })
    expect(matchDeclaredWrite(op(), plan, odd(body.map(([k, v]) => [k, k === 'content_id' ? 345 : v])))).toMatchObject({ match: false, reason: 'body-shape' })
    for (const bad of [1, ['a'], { a: 1 }, null, true]) {
      expect(matchDeclaredWrite(op(), plan, odd([...body, ['_lm_user_id', bad]])), JSON.stringify(bad)).toMatchObject({ match: false, reason: 'body-shape' })
    }
    expect(matchDeclaredWrite(op(), plan, odd([...body, ['_lm_user_id']]))).toMatchObject({ match: false, reason: 'body-shape' })
    expect(matchDeclaredWrite(op(), plan, odd([...body, ['_lm_user_id', 'a', 'b']]))).toMatchObject({ match: false, reason: 'body-shape' })
  })

  it('a JSON body repeating a key is refused like a form', () => {
    const json = parse(LSTEP).browser!.operations.remove_step
    const req = (body: Array<[string, string]>): BrowserWriteRequest => ({ method: 'DELETE', path: '/line/episode/step', query: [], headers: {}, encoding: 'json', body })
    expect(matchDeclaredWrite(json, { target: { step: '7' }, change: {} }, req([['id', '7']]))).toEqual({ match: true, write: 0 })
    expect(matchDeclaredWrite(json, { target: { step: '7' }, change: {} }, req([['id', '7'], ['id', '8']]))).toEqual({ match: false, reason: 'repeated-key', key: 'id' })
  })

  it("the plan must fit the type: exactly its fields, each of its kind", () => {
    expect(matchDeclaredWrite(op(), { target: { reminder: '12' }, change: { template: '678' } }, request())).toMatchObject({ match: false, reason: 'plan' })
    expect(matchDeclaredWrite(op(), { ...plan, change: { template: '678', extra: '1' } }, request())).toMatchObject({ match: false, reason: 'plan' })
    expect(matchDeclaredWrite(op(), { ...plan, target: { reminder: '12', step: '3 4' } }, request())).toMatchObject({ match: false, reason: 'plan' })
    expect(matchDeclaredWrite(op(), { ...plan, target: { reminder: '12', step: 'x'.repeat(65) } }, request())).toMatchObject({ match: false, reason: 'plan' })
    // A plan field missing on both sides cannot be matched as "undefined === undefined".
    const nothing = { target: {}, change: {} } as BrowserPlanValues
    expect(matchDeclaredWrite(op(), nothing, request({ body: [['mode', 'replace']] }))).toMatchObject({ match: false, reason: 'plan' })
  })

  it('a text field takes plain text within its cap', () => {
    const text = parse(edit('        template: id\n', '        template: text\n')).browser!.operations.reminder_step_template
    const req = (t: string) => request({ body: [['content_id', '345'], ['template_id', t], ['pack_id', '12'], ['mode', 'replace']] })
    expect(matchDeclaredWrite(text, { ...plan, change: { template: '件名\n本文' } }, req('件名\n本文'))).toEqual({ match: true, write: 0 })
    expect(matchDeclaredWrite(text, { ...plan, change: { template: 'a\u0000b' } }, req('a\u0000b'))).toMatchObject({ match: false, reason: 'plan' })
    expect(matchDeclaredWrite(text, { ...plan, change: { template: 'x'.repeat(2001) } }, req('x'.repeat(2001)))).toMatchObject({ match: false, reason: 'plan' })
    expect(matchDeclaredWrite(text, { ...plan, change: { template: '' } }, req(''))).toMatchObject({ match: false, reason: 'plan' })
    for (const ch of ['\u200b', '\u202e', '\u2067', '\u061c', '\ufeff']) {
      expect(matchDeclaredWrite(text, { ...plan, change: { template: `a${ch}b` } }, req(`a${ch}b`)), ch).toMatchObject({ match: false, reason: 'plan' })
    }
    // A change text may carry surrounding spaces; a target text may not (one thing, one spelling).
    expect(matchDeclaredWrite(text, { ...plan, change: { template: ' 件名 ' } }, req(' 件名 '))).toEqual({ match: true, write: 0 })
    const byName = parse(edit('        step: id\n      change:', '        step: text\n      change:')).browser!.operations.reminder_step_template
    const reqStep = (step: string) => request({ body: [['content_id', step], ['template_id', '678'], ['pack_id', '12'], ['mode', 'replace']] })
    expect(matchDeclaredWrite(byName, { ...plan, target: { reminder: '12', step: '段1' } }, reqStep('段1'))).toEqual({ match: true, write: 0 })
    expect(matchDeclaredWrite(byName, { ...plan, target: { reminder: '12', step: ' 段1' } }, reqStep(' 段1'))).toMatchObject({ match: false, reason: 'plan' })
    expect(matchDeclaredWrite(byName, { ...plan, target: { reminder: '12', step: '段1\n' } }, reqStep('段1\n'))).toMatchObject({ match: false, reason: 'plan' })
  })

  it('with two writes on one path, the one that fits passes', () => {
    const two = parse(edit('          ignore_body: [_token, _lm_user_id]\n', `          ignore_body: [_token, _lm_user_id]
        - method: POST
          path: /line/episode/step/pack/template
          body: { content_id: "{step}", template_id: "{template}", pack_id: "{reminder}", mode: append }
`)).browser!.operations.reminder_step_template
    const appendBody: Array<[string, string]> = [['content_id', '345'], ['template_id', '678'], ['pack_id', '12'], ['mode', 'append']]
    expect(matchDeclaredWrite(two, plan, request({ body: appendBody }))).toEqual({ match: true, write: 1 })
    // ignore_body belongs to its own write: the second one declares none.
    expect(matchDeclaredWrite(two, plan, request({ body: [...appendBody, ['_token', 'x']] }))).toMatchObject({ match: false })
  })
})

describe('browserOperationsAllowed: the company setting decides which types may run', () => {
  const browser = () => parse(LSTEP).browser!
  const settings = (over: Partial<BrowserOperationSettings['sites'][number]> = {}, mode: 'on' | 'off' = 'on'): BrowserOperationSettings => ({
    mode,
    sites: [{ host: 'manager.linestep.net', level: 'delete', assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net', 'other.example.com'], ...over }],
  })

  it('every type within the level of an allowed site with its asset hosts', () => {
    const r = browserOperationsAllowed(browser(), settings())
    expect(r.usable.sort()).toEqual(['read_reminder', 'reminder_step_template', 'remove_step'])
    expect(r.refused).toEqual([])
  })

  it('the level caps the effect', () => {
    const write = browserOperationsAllowed(browser(), settings({ level: 'write' }))
    expect(write.usable.sort()).toEqual(['read_reminder', 'reminder_step_template'])
    expect(write.refused).toEqual([{ operation: 'remove_step', reason: 'level' }])
    const read = browserOperationsAllowed(browser(), settings({ level: 'read' }))
    expect(read.usable).toEqual(['read_reminder'])
    expect(read.refused.map(x => x.reason)).toEqual(['level', 'level'])
  })

  it('nothing runs when off, on a site not allowed, or with an asset host the site does not list', () => {
    expect(browserOperationsAllowed(browser(), settings({}, 'off'))).toMatchObject({ usable: [], refused: expect.arrayContaining([{ operation: 'read_reminder', reason: 'off' }]) })
    expect(browserOperationsAllowed(browser(), settings({ host: 'manager2.linestep.net' }))).toMatchObject({ site: null, usable: [], refused: expect.arrayContaining([{ operation: 'read_reminder', reason: 'site-not-allowed' }]) })
    const missing = browserOperationsAllowed(browser(), settings({ assetHosts: ['d1nhtjid4lgi9y.cloudfront.net'] }))
    expect(missing.usable).toEqual([])
    expect(missing.missingAssetHosts).toEqual(['profile.line-scdn.net'])
    expect(missing.refused.every(x => x.reason === 'asset-host-not-allowed')).toBe(true)
  })
})

describe('levelAllows', () => {
  it('an effect or level it does not know is never allowed', () => {
    expect(levelAllows('delete', 'write')).toBe(true)
    expect(levelAllows('write', 'delete')).toBe(false)
    expect(levelAllows('delete', 'broadcast' as BrowserOperationEffect)).toBe(false)
    expect(levelAllows('everything' as 'delete', 'read')).toBe(false)
  })
})

describe('no business plugin uses a browser connector yet', () => {
  it('combineUse refuses it', () => {
    // sample-sales, pointed at the browser connector.
    const manifest = fixture('sample-sales', 'plugin.yaml').replace('connector: sample-hub >= 0.1.0', 'connector: lstep >= 0.1.0')
    const business = validatePluginPackage({ manifest, types: { deal: fixture('sample-sales', 'types/deal.md'), customer: fixture('sample-sales', 'types/customer.md') } })
    if (!business.ok) throw new Error(business.errors.join('\n'))
    const r = combineUse(business.value, parse(LSTEP))
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.errors.join()).toContain('ブラウザのつなぎ先')
  })
})
