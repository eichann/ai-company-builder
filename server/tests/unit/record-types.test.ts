/**
 * The light ontology's definitions and record files (shared/core yaml-lite,
 * record-types, records): the one parser the server's index, the push
 * checker and the app share.
 *
 * Guards:
 * - a definition means one thing to every reader: YAML corners that could
 *   make readers disagree, or reach an object's prototype, are refused;
 * - a definition can only say what the engine may do (no expression,
 *   cascade or timer keys), and `who` / `notify` / `attach` / `args` name real
 *   fields and links; an interface's fields must be there;
 * - removing or renaming anything is a breaking change; a changed definition
 *   needs a higher version;
 * - a record file's frontmatter holds id / type / links only: a `state:`
 *   written there is ignored (and reported), never read as the state;
 * - tags (kind `tags`) live on the server only and a tag value is
 *   normalized (NFC, spaces) and bounded (count, length, no control
 *   characters); a link to an interface names one that exists, and the
 *   `bundle` interface needs `owner` / `purpose` on the server; adding either
 *   is not a breaking change, switching a link between a type and an
 *   interface is;
 * - `money: true` only on a server number field, never set by an action
 *   (money is written only through an approval request), and removing it is
 *   a breaking change;
 * - `place_follows` names a record link of the type with cardinality one (not
 *   a file, many or origin link) on a server type; it is absent from the
 *   definition when not written; removing it or naming another link is
 *   breaking, also for a company's extension of a plugin type;
 * - `state_labels` names only states of the type, once each, with a short
 *   one-line name no two states share; it is display only, so adding, changing
 *   or dropping one is not breaking (a higher version, like any change) and it
 *   is absent from the definition when not written;
 * - `ai_on_request` names only person fields already in `who`; the core's task 15 / reply_request 6 add it
 *   without a breaking change, and `who` stays without `ai`;
 * - an action's `title: text` names the record's own title (task 16): only on a type stored on the server, only
 *   kind text (a type's `title` field can only be `source: file`); the core's 件名を直す / 目的を直す are additive;
 *   only a correction of words (`isCorrection`) goes without the member's setting.
 */
import { describe, expect, it } from 'vitest'
import { parseYamlLite } from '../../../shared/core/yaml-lite'
import { aiAskedNeedsSetting, canonicalTypeJson, compareTypeDefinitions, normalizeRecordTitle, normalizeTagsValue, setsRecordTitle, parseTagsValue, parseTypeFile, TAG_MAX_LENGTH, TAGS_MAX_COUNT, type TypeDefinition } from '../../../shared/core/record-types'
import { newRecordId, parseRecordFile } from '../../../shared/core/records'
import { companyExtensionConflicts } from '../../../shared/core/plugin-type-upgrade'
import { CORE_TYPE_FILES, INTERACTION_VERSION, REPLY_REQUEST_VERSION, TASK_VERSION } from '../../../shared/core/core-types'

const TASK = `---
label: タスク
version: 1
implements: [request]
fields:
  title:        { label: 件名, kind: text, source: file }
  requested_by: { label: 依頼した人, kind: person, source: server }
  assignee:     { label: 担当, kind: person, source: server }
  next_actor:   { label: 次に動く人, kind: person, source: server }
  waiting_on:   { label: 待っているもの, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
  reviewer:     { label: レビューする人, kind: person, source: server }
links:
  customer: { label: 顧客, target: customer, cardinality: one, inverse: tasks }
  files:    { label: 関係するファイル, target: file, cardinality: many }
states: [todo, in_progress, review, done]
actions:
  request_review: { label: レビューを依頼する, from: [in_progress], to: review, who: [assignee, ai], notify: reviewer, attach: [files], args: { reviewer: person } }
  complete:       { label: 完了にする, from: [in_progress, review], to: done, who: [requested_by, reviewer], attach: [files], history_line: true, decision: true }
  send_back:      { label: 差し戻す, from: [review], to: in_progress, who: [reviewer], note: required }
---
# タスク

人が読む説明。
`

function task(): TypeDefinition {
  const r = parseTypeFile('task', TASK)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.definition
}

function withYaml(edit: (yaml: string) => string): string {
  const [, yaml, body] = TASK.split(/^---$/m)
  return `---${edit(yaml)}---${body}`
}

describe('yaml-lite: one meaning for every reader', () => {
  it('refuses anchors, aliases, tags, block scalars, merge keys and duplicate keys', () => {
    for (const text of ['a: &x 1\nb: *x', 'a: !!str 1', 'a: |\n  x', 'a: >\n  x', '<<: { a: 1 }', 'a: 1\na: 2', 'a: { b: 1, b: 2 }']) {
      expect(parseYamlLite(text).ok, text).toBe(false)
    }
  })

  it('refuses keys that reach an object prototype', () => {
    for (const text of ['__proto__: { polluted: true }', 'a: { constructor: 1 }', 'prototype: 1']) {
      expect(parseYamlLite(text).ok, text).toBe(false)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps dates and ids as strings and reads the flow forms the definitions use', () => {
    const r = parseYamlLite('due: 2026-10-31\nid: task-3f2a9c\nlist: [a, "b, c", \'d\']\nmap: { x: 1, y: true, z: null }  # note')
    expect(r).toEqual({ ok: true, value: { due: '2026-10-31', id: 'task-3f2a9c', list: ['a', 'b, c', 'd'], map: { x: 1, y: true, z: null } } })
  })
})

describe('type definitions', () => {
  it('reads a full definition', () => {
    const def = task()
    expect(def.states).toEqual(['todo', 'in_progress', 'review', 'done'])
    expect(def.initial).toBe('todo')
    expect(def.actions.complete).toMatchObject({ to: 'done', historyLine: true, decision: true, attach: ['files'] })
    expect(def.actions.send_back.note).toBe('required')
  })

  it('has nowhere to write an expression, a cascade or a timer', () => {
    for (const key of ['condition: "due < today"', 'then: notify_all', 'schedule: "0 9 * * *"', 'compute: x']) {
      const r = parseTypeFile('task', withYaml(y => y.replace('note: required }', `note: required, ${key.replace(':', ': ')} }`)))
      expect(r.ok, key).toBe(false)
    }
    const top = parseTypeFile('task', withYaml(y => `${y}computed:\n  total: sum\n`))
    expect(top.ok).toBe(false)
  })

  it('refuses who / notify / attach / args that name nothing real', () => {
    const cases = [
      (y: string) => y.replace('who: [reviewer], note', 'who: [nobody], note'),
      (y: string) => y.replace('notify: reviewer', 'notify: someone'),
      (y: string) => y.replace('attach: [files], args', 'attach: [customer], args'),
      (y: string) => y.replace('args: { reviewer: person }', 'args: { reviewer: date }'),
      (y: string) => y.replace('to: done', 'to: finished'),
    ]
    for (const edit of cases) expect(parseTypeFile('task', withYaml(edit)).ok).toBe(false)
  })

  it('a choice may say how its options are shown, only for options it has', () => {
    const reviewer = '  reviewer:     { label: レビューする人, kind: person, source: server }\n'
    const choice = (labels: string) => parseTypeFile('task', withYaml(y => y.replace(reviewer, `${reviewer}  confidence:   { label: 確度, kind: choice, options: [a, b, c], source: server${labels} }\n`)))
    const ok = choice(', option_labels: { a: A（高）, b: B（中） }')
    expect(ok.ok && ok.definition.fields.confidence).toMatchObject({ options: ['a', 'b', 'c'], optionLabels: { a: 'A（高）', b: 'B（中）' } })
    expect(choice(', option_labels: { d: D }').ok).toBe(false)
    expect(choice(', option_labels: { a: "" }').ok).toBe(false)
    expect(parseTypeFile('task', withYaml(y => y.replace('kind: date, source: server', 'kind: date, source: server, option_labels: { a: A }'))).ok).toBe(false)
  })

  it('an interface needs its fields on the server', () => {
    expect(parseTypeFile('task', withYaml(y => y.replace(/ {2}due: .*\n/, ''))).ok).toBe(false)
    expect(parseTypeFile('task', withYaml(y => y.replace('kind: date, source: server', 'kind: date, source: file'))).ok).toBe(false)
  })
})

describe('type versions', () => {
  it('removing or renaming a state, field, link or action is breaking', () => {
    const prev = task()
    const next = (edit: (y: string) => string) => {
      const r = parseTypeFile('task', withYaml(y => edit(y).replace('version: 1', 'version: 2')))
      if (!r.ok) throw new Error(r.errors.join('\n'))
      return r.definition
    }
    expect(compareTypeDefinitions(prev, next(y => y.replace('states: [todo, in_progress, review, done]', 'states: [todo, in_progress, review, done, waiting]'))).breaking).toEqual([])
    expect(compareTypeDefinitions(prev, next(y => y.replace(/ {2}waiting_on: .*\n/, '').replace('implements: [request]', 'implements: []'))).breaking.length).toBeGreaterThan(0)
    expect(compareTypeDefinitions(prev, next(y => y.replace(/ {2}customer: .*\n/, ''))).breaking.length).toBeGreaterThan(0)
    expect(compareTypeDefinitions(prev, next(y => y.replace(/ {2}send_back: .*\n/, ''))).breaking.length).toBeGreaterThan(0)
    expect(compareTypeDefinitions(prev, next(y => y.replace('kind: text, source: file', 'kind: long_text, source: file'))).breaking.length).toBeGreaterThan(0)
  })

  it('a changed definition needs a higher version; a lower one is refused', () => {
    const prev = task()
    const sameVersion = parseTypeFile('task', withYaml(y => y.replace('label: タスク', 'label: やること')))
    if (!sameVersion.ok) throw new Error('parse')
    expect(compareTypeDefinitions(prev, sameVersion.definition).versionProblem).not.toBeNull()
    expect(compareTypeDefinitions(prev, prev).versionProblem).toBeNull()
    expect(compareTypeDefinitions({ ...prev, version: 3 }, prev).versionProblem).not.toBeNull()
  })
})

describe('record files', () => {
  it('reads id, type and links; the title and summary from the text', () => {
    const r = parseRecordFile('営業部/商談/A社.md', '---\nid: deal-3f2a9c\ntype: deal\nlinks:\n  customer: customer-aa11bb\n  files: [営業部/提案書.md]\n---\n# A社 提案\n\n初回の打ち合わせ。\n値引きの相談あり。\n\n## 経緯\n- x\n')
    expect(r).toEqual({ kind: 'record', record: {
      id: 'deal-3f2a9c', type: 'deal', links: { customer: ['customer-aa11bb'], files: ['営業部/提案書.md'] },
      title: 'A社 提案', summary: '初回の打ち合わせ。 値引きの相談あり。', problems: [],
    } })
  })

  it('a state written in the file is ignored and reported, never read', () => {
    const r = parseRecordFile('x.md', '---\nid: task-3f2a9c\ntype: task\nstate: done\nassignee: u-1\n---\n')
    expect(r.kind).toBe('record')
    if (r.kind !== 'record') return
    expect(r.record).not.toHaveProperty('state')
    expect(r.record.problems.join()).toContain('state')
    expect(r.record.problems.join()).toContain('assignee')
  })

  it('a file without a type is not a record; a bad id is reported', () => {
    expect(parseRecordFile('a.md', '---\ntitle: x\n---\n').kind).toBe('none')
    expect(parseRecordFile('a.md', '# no frontmatter\n').kind).toBe('none')
    expect(parseRecordFile('a.md', '---\nid: ../../etc\ntype: task\n---\n').kind).toBe('invalid')
    expect(parseRecordFile('a.md', '---\ntype: task\n---\n').kind).toBe('invalid')
  })

  it('new ids have the record id shape', () => {
    expect(newRecordId('task', '3F2A9C0B')).toBe('task-3f2a9c0b')
    expect(() => newRecordId('task', 'ab')).toThrow()
  })
})

describe('tags and links to an interface (stage 2 S1)', () => {
  const reviewer = '  reviewer:     { label: レビューする人, kind: person, source: server }\n'
  const withField = (line: string) => parseTypeFile('task', withYaml(y => y.replace(reviewer, `${reviewer}  ${line}\n`)))
  const withLink = (line: string) => parseTypeFile('task', withYaml(y => y.replace(/( {2}files: .*\n)/, `$1  ${line}\n`)))

  it('a tags field lives on the server only and takes no options or target', () => {
    const r = withField('tags: { label: タグ, kind: tags, source: server }')
    expect(r.ok && r.definition.fields.tags).toEqual({ label: 'タグ', kind: 'tags', source: 'server' })
    expect(withField('tags: { label: タグ, kind: tags }').ok).toBe(true)
    expect(withField('tags: { label: タグ, kind: tags, source: file }').ok).toBe(false)
    expect(withField('tags: { label: タグ, kind: tags, source: server, options: [a] }').ok).toBe(false)
    expect(withField('tags: { label: タグ, kind: tags, source: server, target: task }').ok).toBe(false)
  })

  it('a tag value is normalized and bounded', () => {
    const nfd = 'か\u3099'  // が written as NFD (a Mac)
    expect(normalizeTagsValue([` ${nfd}  急ぎ `, 'が 急ぎ', '見積'])).toBe(JSON.stringify(['が 急ぎ', '見積']))
    expect(normalizeTagsValue([])).toBeNull()
    expect(normalizeTagsValue(null)).toBeNull()
    for (const bad of [
      '急ぎ', ['急ぎ', 3], [''], ['   '], ['a\u0000b'], ['a\u202Fb\u2028'], ['x'.repeat(TAG_MAX_LENGTH + 1)],
      Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, i) => `t${i}`), { 0: 'a' },
    ]) expect(normalizeTagsValue(bad), JSON.stringify(bad)).toMatchObject({ error: expect.any(String) })
    expect(normalizeTagsValue(['x'.repeat(TAG_MAX_LENGTH)])).toBe(JSON.stringify(['x'.repeat(TAG_MAX_LENGTH)]))
    expect(parseTagsValue(normalizeTagsValue(['a', 'b']))).toEqual(['a', 'b'])
    expect(parseTagsValue('not json')).toEqual([])
  })

  it('a link may target an interface that exists, by its own key', () => {
    const r = withLink('bundle: { label: まとまり, interface: bundle, cardinality: one }')
    expect(r.ok && r.definition.links.bundle).toEqual({ label: 'まとまり', target: 'bundle', cardinality: 'one', targetIsInterface: true })
    expect(withLink('bundle: { label: まとまり, interface: project, cardinality: one }').ok).toBe(false)
    expect(withLink('bundle: { label: まとまり, interface: toString, cardinality: one }').ok).toBe(false)
    expect(withLink('bundle: { label: まとまり, interface: bundle, target: deal }').ok).toBe(false)
    // A type target stays a label (a plugin's type may not exist): unchanged.
    expect(withLink('deal: { label: 案件, target: deal }').ok).toBe(true)
  })

  it('the bundle interface needs an owner, a purpose on the server and final states', () => {
    const bundle = (fields: string, final = 'final: [done]\n') => parseTypeFile('effort', `---\nlabel: 取り組み\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n${fields}states: [active, done]\n${final}---\n`)
    const owner = '  owner: { label: 持ち主, kind: person, source: server }\n'
    const purpose = '  purpose: { label: 目的, kind: text, source: server }\n'
    expect(bundle(owner + purpose).ok).toBe(true)
    expect(bundle(owner).ok).toBe(false)
    expect(bundle(purpose).ok).toBe(false)
    expect(bundle(owner + '  purpose: { label: 目的, kind: long_text, source: server }\n').ok).toBe(false)
    // 「終わったかどうか」 must be answerable: a bundle without final states is refused.
    const noFinal = bundle(owner + purpose, '')
    expect(noFinal.ok).toBe(false)
    if (!noFinal.ok) expect(noFinal.errors.join()).toContain('final')
  })

  it('the counterpart interface needs its kind (company / person) and the matching keys on the server', () => {
    const counterpart = (fields: string) => parseTypeFile('guest', `---\nlabel: ゲスト\nversion: 1\nstorage: server\nimplements: [counterpart]\nfields:\n${fields}states: [active]\n---\n`)
    const kind = '  counterpart_kind: { label: 会社か人か, kind: choice, options: [company, person, group], source: server }\n'
    const domain = '  domain: { label: ドメイン, kind: text, source: server }\n'
    const email = '  email: { label: メール, kind: text, source: server }\n'
    expect(counterpart(kind + domain + email).ok).toBe(true)
    expect(counterpart(domain + email).ok).toBe(false)
    expect(counterpart(kind + email).ok).toBe(false)
    expect(counterpart(kind + domain).ok).toBe(false)
    // The choice must offer both company and person (more are allowed).
    const onlyCompany = counterpart('  counterpart_kind: { label: 会社か人か, kind: choice, options: [company], source: server }\n' + domain + email)
    expect(onlyCompany.ok).toBe(false)
    if (!onlyCompany.ok) expect(onlyCompany.errors.join()).toContain('person')
    // A file-sourced key is not a server field.
    expect(counterpart(kind + '  domain: { label: ドメイン, kind: text, source: file }\n' + email).ok).toBe(false)
  })

  it('only the core defines interfaces: a type claiming or linking to an unknown one is refused', () => {
    const claims = parseTypeFile('x', '---\nlabel: X\nversion: 1\nstorage: server\nimplements: [project]\nstates: [a]\n---\n')
    expect(claims.ok).toBe(false)
    const links = parseTypeFile('x', '---\nlabel: X\nversion: 1\nstorage: server\nlinks:\n  p: { label: P, interface: project }\nstates: [a]\n---\n')
    expect(links.ok).toBe(false)
    // There is no key for a type to declare an interface of its own.
    expect(parseTypeFile('x', '---\nlabel: X\nversion: 1\nstorage: server\ninterfaces: { project: {} }\nstates: [a]\n---\n').ok).toBe(false)
  })

  it('adding tags or an interface link is not breaking; switching a link to or from an interface is', () => {
    const prev = task()
    const next = (edit: (y: string) => string) => {
      const r = parseTypeFile('task', withYaml(y => edit(y).replace('version: 1', 'version: 2')))
      if (!r.ok) throw new Error(r.errors.join('\n'))
      return r.definition
    }
    const added = next(y => y
      .replace(reviewer, `${reviewer}  tags: { label: タグ, kind: tags, source: server }\n`)
      .replace(/( {2}files: .*\n)/, '$1  bundle: { label: まとまり, interface: bundle, cardinality: one }\n'))
    expect(compareTypeDefinitions(prev, added)).toMatchObject({ changed: true, breaking: [], versionProblem: null })
    // Same name, other meaning: a type called "bundle" vs every type implementing the interface.
    const typeNamedBundle = next(y => y.replace('customer: { label: 顧客, target: customer', 'customer: { label: 顧客, target: bundle'))
    const toInterface = next(y => y.replace('customer: { label: 顧客, target: customer', 'customer: { label: 顧客, interface: bundle'))
    expect(compareTypeDefinitions(typeNamedBundle, { ...toInterface, version: 3 }).breaking.length).toBeGreaterThan(0)
    expect(compareTypeDefinitions(toInterface, { ...typeNamedBundle, version: 3 }).breaking.length).toBeGreaterThan(0)
    const tagsToText = next(y => y.replace(reviewer, `${reviewer}  tags: { label: タグ, kind: tags, source: server }\n`))
    expect(compareTypeDefinitions(tagsToText, next(y => y.replace(reviewer, `${reviewer}  tags: { label: タグ, kind: text, source: server }\n`).replace('version: 1', 'version: 3'))).breaking.length).toBeGreaterThan(0)
  })
})

describe('a field that holds money (money: true)', () => {
  const deal = (amount: string, extra = '', version = 1) =>
    `---\nlabel: 案件\nversion: ${version}\nstorage: server\nfields:\n  owner: { label: 責任者, kind: person, source: server }\n  amount: ${amount}\nstates: [open]\n${extra}---\n`
  const MONEY = '{ label: 金額, kind: number, source: server, money: true }'
  const parsed = (text: string) => {
    const r = parseTypeFile('deal', text)
    if (!r.ok) throw new Error(r.errors.join('\n'))
    return r.definition
  }
  const errorsOf = (text: string) => { const r = parseTypeFile('deal', text); return r.ok ? '' : r.errors.join('\n') }

  it('only on a number field kept on the server; left out when not money', () => {
    expect(parsed(deal(MONEY)).fields.amount).toEqual({ label: '金額', kind: 'number', source: 'server', money: true })
    expect(parsed(deal('{ label: 金額, kind: number, source: server, money: false }')).fields.amount).not.toHaveProperty('money')
    expect(errorsOf(deal('{ label: 金額, kind: text, source: server, money: true }'))).toMatch(/money: true は kind: number, source: server の欄だけ/)
    expect(errorsOf(deal('{ label: 金額, kind: number, source: file, money: true }'))).toMatch(/money: true は kind: number, source: server の欄だけ/)
    expect(errorsOf(deal('{ label: 金額, kind: number, source: server, money: yes }'))).toMatch(/money は true か false です/)
  })

  it('an action cannot set it (so no ok_from reaches it): money is written only through an approval request', () => {
    const action = (amount: string) => deal(amount, 'actions:\n  set_amount: { label: 金額を決める, who: [owner], args: { amount: number } }\n')
    expect(errorsOf(action(MONEY))).toMatch(/引数「amount」はお金の欄（money: true）です/)
    expect(errorsOf(action('{ label: 金額, kind: number, source: server }'))).toBe('')
  })

  it('removing the marker is a breaking change; adding it is not', () => {
    const plain = parsed(deal('{ label: 金額, kind: number, source: server }'))
    const money = parsed(deal(MONEY, '', 2))
    expect(compareTypeDefinitions(plain, money)).toMatchObject({ changed: true, breaking: [] })
    expect(compareTypeDefinitions(money, { ...plain, version: 3 }).breaking).toEqual(['欄「amount」のお金の印（money: true）を外す'])
  })
})

describe('where an action may be called from (via, plan 4b §5-13)', () => {
  const typed = (action: string) =>
    `---\nlabel: 案件\nversion: 1\nstorage: server\nfields:\n  owner: { label: 責任者, kind: person, source: server }\nstates: [open, done]\nactions:\n  ${action}\n---\n`
  const result = (action: string) => parseTypeFile('deal', typed(action))

  it('a list of screen / plugin / run; left out when not written (the default is screen and run)', () => {
    const r = result('finish: { label: 終える, to: done, who: [owner], via: [screen, plugin] }')
    expect(r.ok && r.definition.actions.finish.via).toEqual(['screen', 'plugin'])
    const plain = result('finish: { label: 終える, to: done, who: [owner] }')
    expect(plain.ok && plain.definition.actions.finish).not.toHaveProperty('via')
    for (const bad of ['via: []', 'via: [screen, screen]', 'via: [anywhere]']) {
      expect(result(`finish: { label: 終える, to: done, who: [owner], ${bad} }`).ok, bad).toBe(false)
    }
  })

  it('an action that needs prior approval cannot be called from a plugin screen (approving is the core card)', () => {
    const r = result('finish: { label: 終える, to: done, who: [owner], approval: prior, via: [screen, plugin] }')
    expect(r.ok ? '' : r.errors.join('\n')).toMatch(/via に plugin は書けません/)
    expect(result('finish: { label: 終える, to: done, who: [owner], approval: prior, via: [screen, run] }').ok).toBe(true)
  })
})

describe('a record that follows its parent’s 見える範囲 (place_follows, step 2a: declaration only)', () => {
  // A 収録 under a 番組: its link to the 番組 decides who may see it (the engine reads it from step 2b on).
  const recording = (placeFollows: string | null, { version = 1, storage = 'server', links = '' } = {}) => `---
label: 収録
version: ${version}
storage: ${storage}
fields:
  owner: { label: 担当, kind: person, source: server }
links:
  program:  { label: 番組, target: program, cardinality: one }
  bundle:   { label: まとまり, interface: bundle, cardinality: one }
  guests:   { label: ゲスト, target: guest, cardinality: many }
  files:    { label: 資料, target: file, cardinality: one }
  meeting:  { label: もとの会議, target: meeting, cardinality: one, origin: true }
${links}states: [open, done]
${placeFollows === null ? '' : `place_follows: ${placeFollows}\n`}---
`
  const parsed = (text: string) => {
    const r = parseTypeFile('recording', text)
    if (!r.ok) throw new Error(r.errors.join('\n'))
    return r.definition
  }
  const errorsOf = (text: string) => { const r = parseTypeFile('recording', text); return r.ok ? '' : r.errors.join('\n') }

  it('names a record link of this type with cardinality one: to a type or to an interface', () => {
    expect(parsed(recording('program')).placeFollows).toBe('program')
    expect(parsed(recording('bundle')).placeFollows).toBe('bundle')
  })

  it('a many link, a file link, an origin link or a name that is no link is refused, with a sentence for the type’s author', () => {
    expect(errorsOf(recording('guests'))).toMatch(/place_follows の「guests」は cardinality: one のつながりにしてください/)
    expect(errorsOf(recording('files'))).toMatch(/place_follows の「files」はファイルへのつながりです/)
    expect(errorsOf(recording('meeting'))).toMatch(/place_follows の「meeting」は出どころ（origin: true）のつながりです/)
    expect(errorsOf(recording('sponsor'))).toMatch(/place_follows の「sponsor」という つながり がありません/)
    expect(errorsOf(recording('[program]'))).toMatch(/place_follows には、見える範囲をそろえる相手のつながりの名前を書いてください/)
  })

  it('only on a type kept on the server (a file record’s place is its file’s)', () => {
    expect(errorsOf(recording('program', { storage: 'file' }))).toMatch(/place_follows は storage: server か either の型だけ/)
    expect(parsed(recording('program', { storage: 'either' })).placeFollows).toBe('program')
  })

  it('left out of the definition when not written, so the stored JSON of every other type stays the same', () => {
    const plain = parsed(recording(null))
    expect(plain).not.toHaveProperty('placeFollows')
    expect(canonicalTypeJson(plain)).not.toContain('placeFollows')
    expect(parsed(recording('null'))).not.toHaveProperty('placeFollows')
  })

  it('adding it needs a higher version and is not breaking; removing it or naming another link is breaking', () => {
    const plain = parsed(recording(null))
    const follows = parsed(recording('program', { version: 2 }))
    expect(compareTypeDefinitions(plain, follows)).toMatchObject({ changed: true, breaking: [], versionProblem: null })
    expect(compareTypeDefinitions(plain, { ...follows, version: 1 }).versionProblem).toMatch(/version を上げてください/)
    expect(compareTypeDefinitions(follows, { ...plain, version: 3 }).breaking).toEqual(['見える範囲をそろえる相手（place_follows: program）をやめる'])
    expect(compareTypeDefinitions(follows, parsed(recording('bundle', { version: 3 }))).breaking)
      .toEqual(['見える範囲をそろえる相手（place_follows）を「program」から「bundle」に変える'])
    expect(compareTypeDefinitions(follows, parsed(recording('program', { version: 3, links: '  sponsor: { label: スポンサー, target: sponsor, cardinality: many }\n' }))).breaking).toEqual([])
  })

  it('a company’s extension of a plugin type that drops it conflicts with the plugin’s new version', () => {
    const pluginNew = parsed(recording('program', { version: 2 }))
    const company = parsed(recording(null, { version: 5 }))
    expect(companyExtensionConflicts(company, pluginNew).join('\n')).toMatch(/place_follows: program）をやめる/)
    expect(companyExtensionConflicts(parsed(recording('program', { version: 5 })), pluginNew)).toEqual([])
  })
})

describe('how a state is shown (state_labels, owner decision 2026-11-24)', () => {
  const withLabels = (labels: string, version = 1) => parseTypeFile('task', withYaml(y => y.replace('states: [todo, in_progress, review, done]', `states: [todo, in_progress, review, done]\nstate_labels: ${labels}`).replace('version: 1', `version: ${version}`)))
  const ok = (labels: string, version = 1): TypeDefinition => {
    const r = withLabels(labels, version)
    if (!r.ok) throw new Error(r.errors.join('\n'))
    return r.definition
  }

  it('gives states their names; the states themselves stay as written', () => {
    const def = ok('{ todo: 準備中, in_progress: " 受付中 " }')
    expect(def.stateLabels).toEqual({ todo: '準備中', in_progress: '受付中' })
    expect(def.states).toEqual(['todo', 'in_progress', 'review', 'done'])
    expect(def.initial).toBe('todo')
    // Not written → not in the definition, so stored definitions of every other type compare equal.
    expect('stateLabels' in task()).toBe(false)
    expect('stateLabels' in ok('{}')).toBe(false)
  })

  it('refuses a state the type does not have, an empty, long or multi-line name, and two states with one name', () => {
    const refused = (labels: string) => {
      const r = withLabels(labels)
      expect(r.ok, labels).toBe(false)
      return r.ok ? [] : r.errors
    }
    expect(refused('{ planning: 準備中 }').join()).toContain('「planning」は states にありません')
    refused('{ todo: "" }')
    refused('{ todo: "  " }')
    refused(`{ todo: ${'あ'.repeat(41)} }`)
    expect(ok(`{ todo: ${'あ'.repeat(40)} }`).stateLabels?.todo).toHaveLength(40)
    refused('{ todo: "準備\\n中" }')
    refused('{ todo: 1 }')
    refused('[todo]')
    expect(refused('{ todo: 準備中, review: " 準備中" }').join()).toContain('同じ名前')
  })

  it('is display only: adding, changing or dropping a name is not breaking, and needs a higher version like any change', () => {
    const plain = task()
    const named = ok('{ todo: 準備中 }', 2)
    expect(compareTypeDefinitions(plain, named)).toMatchObject({ changed: true, breaking: [], versionProblem: null })
    expect(compareTypeDefinitions(named, ok('{ todo: 支度中 }', 3)).breaking).toEqual([])
    expect(compareTypeDefinitions(named, { ...plain, version: 3 }).breaking).toEqual([])
    expect(compareTypeDefinitions(named, ok('{ todo: 支度中 }', 2)).versionProblem).not.toBeNull()
    // A company's extension of a plugin type may name states the plugin's does not, and drop them again.
    expect(companyExtensionConflicts({ ...named, version: 5 }, plain)).toEqual([])
    expect(companyExtensionConflicts({ ...plain, version: 5 }, named)).toEqual([])
  })
})

/** The core task's text without version 16's two actions (件名を直す, 目的を直す). */
/** Task 17 / interaction 9 (「AI の毎日の操作」): the keys on アーカイブ・引き受ける・済んだ taken away again. */
const withoutV17 = (text: string) => text.replace(/^( {2}(cancel|accept|settle): .*), ai_on_request: \[[a-z_]+\] \}$/gm, '$1 }')
const withoutV16 = (text: string) => withoutV17(text).replace(/^ {2}(retitle|set_purpose): .*\n/gm, '')

describe('the record\'s own title as an action argument (task 16: 件名を直す)', () => {
  const type = (storage: string, titleField = '  title: { label: 件名, kind: text, source: file }\n') => parseTypeFile('memo', `---
label: メモ
version: 1
storage: ${storage}
fields:
${titleField}  note: { label: メモ, kind: text, source: server }
states: [open]
initial: open
actions:
  retitle: { label: 件名を直す, who: [anyone], args: { title: text } }
---
`)

  it('only on a type stored on the server, only kind text; the record\'s title, not a field', () => {
    const ok = type('server')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(setsRecordTitle(ok.definition, ok.definition.actions.retitle)).toBe(true)
    // No title field at all is fine too (every record has a title).
    expect(type('server', '').ok).toBe(true)
    for (const storage of ['file', 'either']) expect(type(storage).ok).toBe(false)
    expect(parseTypeFile('task', CORE_TYPE_FILES.task.replace('args: { title: text }', 'args: { title: long_text }')).ok).toBe(false)
    // A title field of another kind cannot be set as the title.
    expect(type('server', '  title: { label: 件名, kind: number, source: file }\n').ok).toBe(false)
  })

  it('the core\'s 件名を直す / 目的を直す: the requester and the assignee, their AI only when asked, from every open state; additive over 15', () => {
    const task = parseTypeFile('task', CORE_TYPE_FILES.task)
    if (!task.ok) throw new Error(task.errors.join('\n'))
    const d = task.definition
    for (const name of ['retitle', 'set_purpose']) {
      expect(d.actions[name]).toMatchObject({ who: ['requested_by', 'assignee'], aiOnRequest: ['requested_by', 'assignee'], to: null })
      expect(d.actions[name].who).not.toContain('ai')
      expect(d.actions[name].from).toEqual(d.states.filter(s => !d.final.includes(s)))
      expect(d.actions[name].via).toBeUndefined()
    }
    expect(setsRecordTitle(d, d.actions.retitle)).toBe(true)
    expect(d.actions.set_purpose.args).toEqual({ purpose: 'long_text' })
    const v15 = parseTypeFile('task', withoutV16(CORE_TYPE_FILES.task).replace(/^version: \d+$/m, 'version: 15'))
    if (!v15.ok) throw new Error(v15.errors.join('\n'))
    expect(compareTypeDefinitions(v15.definition, d)).toMatchObject({ changed: true, breaking: [], versionProblem: null })
    expect(TASK_VERSION).toBe(d.version)
  })

  it('one title rule (a create and 件名を直す): NFC, trimmed, 1–200 characters, one line', () => {
    expect(normalizeRecordTitle('  見積  ')).toEqual({ title: '見積' })
    expect(normalizeRecordTitle('ガ'.normalize('NFD'))).toEqual({ title: 'ガ' })
    expect(normalizeRecordTitle('あ'.repeat(200))).toEqual({ title: 'あ'.repeat(200) })
    for (const bad of ['', '   ', 'あ'.repeat(201), 'a\nb', 'a\tb', 'a b', 'a\u0085b', null, 3]) expect(normalizeRecordTitle(bad)).toHaveProperty('error')
  })
})

describe('ai_on_request (task 15, reply_request 6: the AI at the member\'s request)', () => {
  const core = (name: string) => {
    const text = CORE_TYPE_FILES[name]
    const parsed = parseTypeFile(name, text)
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
    return { text, def: parsed.definition }
  }
  /** The version before: the same text without the key, one version lower. */
  const before = (name: string, version: number) => {
    const { text } = core(name)
    const parsed = parseTypeFile(name, withoutV16(text).replaceAll(', ai_on_request: [assignee]', '').replaceAll(', ai_on_request: [requested_by]', '').replace(/^version: \d+$/m, `version: ${version}`))
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
    return parsed.definition
  }

  it('the core declares it on exactly the assignee\'s 完了 / 終わりにする / もう返した, and the versions stay compatible (additive, a higher version)', () => {
    const task = core('task').def
    const rr = core('reply_request').def
    expect(Object.entries(task.actions).filter(([, a]) => a.aiOnRequest).map(([n, a]) => [n, a.aiOnRequest])).toEqual([
      ['complete', ['assignee']], ['cancel', ['requested_by']], ['accept', ['assignee']], ['retitle', ['requested_by', 'assignee']], ['set_purpose', ['requested_by', 'assignee']],
    ])
    // Task 17 / interaction 9 (「AI の毎日の操作」): アーカイブ by the one who asked, 引き受ける and 済んだ by the assignee — never 受けられない,
    // 取り込まない, 差し戻す or anything that widens who sees it.
    const interaction = core('interaction').def
    expect(Object.entries(interaction.actions).filter(([, a]) => a.aiOnRequest).map(([n, a]) => [n, a.aiOnRequest])).toEqual([['settle', ['assignee']]])
    for (const n of ['decline', 'send_back', 'reopen', 'assign', 'set_reviewer', 'set_when_done', 'adopt', 'dismiss']) expect(task.actions[n].aiOnRequest, n).toBeUndefined()
    // Only the closing / accepting ones need the member's own setting (task 16: correcting ends nothing).
    expect(Object.entries(task.actions).filter(([, a]) => a.aiOnRequest && aiAskedNeedsSetting(a)).map(([n]) => n)).toEqual(['complete', 'cancel', 'accept'])
    expect(aiAskedNeedsSetting(interaction.actions.settle)).toBe(true)
    expect(Object.entries(rr.actions).filter(([, a]) => a.aiOnRequest && aiAskedNeedsSetting(a)).map(([n]) => n).sort()).toEqual(['close', 'replied_elsewhere'])
    // Only a correction of words goes without it — anything a company's or a plugin's type may declare else still needs it.
    const words = { to: null, args: { title: 'text' as const, purpose: 'long_text' as const }, notify: [], handTo: null, attach: [], approval: 'none' as const, decision: false }
    expect(aiAskedNeedsSetting(words)).toBe(false)
    for (const more of [{ to: 'declined' }, { args: {} }, { args: { assignee: 'person' as const } }, { args: { due: 'date' as const } },
      { args: { purpose: 'long_text' as const, due: 'date' as const } }, { links: ['bundle'] }, { notify: ['requested_by'] }, { handTo: 'assignee' },
      { attach: ['files'] }, { okFrom: ['assignee'] }, { approval: 'undoable' as const }, { approval: 'prior' as const }, { decision: true }]) {
      expect(aiAskedNeedsSetting({ ...words, ...more }), JSON.stringify(more)).toBe(true)
    }
    expect(Object.entries(rr.actions).filter(([, a]) => a.aiOnRequest).map(([n, a]) => [n, a.aiOnRequest]).sort()).toEqual([['close', ['assignee']], ['replied_elsewhere', ['assignee']]])
    // `who` is unchanged, so an app or server that does not know the key still refuses the AI.
    expect(task.actions.complete.who).not.toContain('ai')
    expect(rr.actions.close.who).toEqual(['assignee'])
    for (const [name, version] of [['task', 13], ['reply_request', 5], ['interaction', 8]] as const) {
      expect(compareTypeDefinitions(before(name, version), core(name).def)).toMatchObject({ changed: true, breaking: [], versionProblem: null })
      // Dropping it again only narrows: not breaking either (a higher version, like any change).
      const keyDropped = parseTypeFile(name, core(name).text.replace(/, ai_on_request: \[[a-z_, ]+\]/g, '').replace(/^version: \d+$/m, `version: ${core(name).def.version + 1}`))
      if (!keyDropped.ok) throw new Error(keyDropped.errors.join('\n'))
      expect(compareTypeDefinitions(core(name).def, keyDropped.definition).breaking).toEqual([])
    }
    expect(TASK_VERSION).toBe(task.version)
    expect(REPLY_REQUEST_VERSION).toBe(rr.version)
    expect(INTERACTION_VERSION).toBe(interaction.version)
    // Task 17 over 16 and interaction 9 over 8 only add the keys.
    const v16 = parseTypeFile('task', withoutV17(CORE_TYPE_FILES.task).replace(/^version: \d+$/m, 'version: 16'))
    const v8 = parseTypeFile('interaction', withoutV17(CORE_TYPE_FILES.interaction).replace(/^version: \d+$/m, 'version: 8'))
    if (!v16.ok || !v8.ok) throw new Error('parse')
    expect(Object.values(v16.definition.actions).filter(a => a.aiOnRequest).length).toBe(3)
    expect(compareTypeDefinitions(v16.definition, task)).toMatchObject({ changed: true, breaking: [], versionProblem: null })
    expect(compareTypeDefinitions(v8.definition, interaction)).toMatchObject({ changed: true, breaking: [], versionProblem: null })
  })

  it('absent when not written; only person fields already in `who`', () => {
    expect(Object.values(before('task', 13).actions).some(a => 'aiOnRequest' in a)).toBe(false)
    const withKey = (ask: string) => core('task').text.replace(/(complete: .*)ai_on_request: \[assignee\] \}/, `$1ai_on_request: [${ask}] }`)
    expect(parseTypeFile('task', withKey('assignee')).ok).toBe(true)
    for (const bad of ['next_actor', 'ai', 'admin', 'nobody']) expect(parseTypeFile('task', withKey(bad)).ok).toBe(false)
  })
})
