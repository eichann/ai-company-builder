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
 *   written there is ignored (and reported), never read as the state.
 */
import { describe, expect, it } from 'vitest'
import { parseYamlLite } from '../../../shared/core/yaml-lite'
import { compareTypeDefinitions, parseTypeFile, type TypeDefinition } from '../../../shared/core/record-types'
import { newRecordId, parseRecordFile } from '../../../shared/core/records'

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
