/**
 * The shared rules of 「ブラウザ操作」 plans (shared/core/browser-plans.ts and the declaration's
 * `lock` / `delivers` / `facts`, plugin-browser-declaration.ts; agent-browser.md "Plans, executions,
 * permits and locks"). Guards:
 * - a write / delete type declares its lock kind, whether it delivers at once, and that it reads the
 *   account; the parser stays strict (unknown keys refused) with a Japanese reason;
 * - the first version runs only one non-irreversible, non-delete write that delivers nothing at once;
 * - facts: every required fact known, of its shape, read whole where `complete`; unknown, empty and
 *   0 are different answers; nothing the type does not declare; the step's parent is the plan's
 *   reminder; the bodies of the templates involved are all there;
 * - the target lock key is a canonical structure (no text can run into the next part), independent
 *   of the type's version.
 */
import { describe, expect, it } from 'vitest'
import {
  BROWSER_FACTS_VERSION, browserFactsAccount, browserFactsDeclarationProblem, browserFactsProblem, browserFactsState, browserLockKey,
} from '../../../shared/core/browser-plans'
import { browserFirstVersionProblem, parsePluginManifest, type BrowserOperation } from '../../../shared/core/plugins'
import { browserAiStopped } from '../../../shared/core/browser-operation'

const DECL = `id: lstep
version: 0.9.0
label: Lステップ
contract: 1
browser:
  host: manager.linestep.net
  account: { label: LINE アカウント }
  operations:
    add:
      label: 足す
      effect: write
      checker: lstep.reminder_step
      lock: { kind: lstep.reminder_step }
      delivers: none
      target: { reminder: id, step: id }
      change: { template: id }
      writes:
        - method: POST
          path: /line/episode/step/pack/template
          body: { content_id: "{step}", template_id: "{template}" }
      expect:
        - { list: templates, add: "{template}" }
      facts:
        account: { required: true }
        step_parent: { required: true }
        state: { required: true, complete: true }
        names: { required: true }
        template_bodies: { required: true, complete: true }
        shared_with: { required: true, complete: true }
`

const errorsOf = (text: string): string => {
  const r = parsePluginManifest(text)
  return r.ok ? '' : r.errors.join('\n')
}
function edit(from: string, to: string): string {
  expect(DECL).toContain(from)
  return DECL.replace(from, to)
}
function op(text = DECL): BrowserOperation {
  const r = parsePluginManifest(text)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value.browser!.operations.add
}

describe('the declaration\'s lock, delivers and facts', () => {
  it('parses them', () => {
    const o = op()
    expect(o.lock).toEqual({ kind: 'lstep.reminder_step' })
    expect(o.delivers).toBe('none')
    expect(o.facts.state).toEqual({ required: true, complete: true })
    expect(o.facts.account).toEqual({ required: true, complete: false })
  })

  it('a write needs its lock kind, a delivers answer and the account fact; a read takes no lock', () => {
    expect(errorsOf(edit('      lock: { kind: lstep.reminder_step }\n', ''))).toContain('lock（作業中の印の種類）')
    expect(errorsOf(edit('      lock: { kind: lstep.reminder_step }\n', '      lock: { kind: "../x" }\n'))).toContain('lock の kind')
    expect(errorsOf(edit('      lock: { kind: lstep.reminder_step }\n', '      lock: { kind: lstep.reminder_step, all: true }\n'))).toContain('all')
    expect(errorsOf(edit('      delivers: none\n', ''))).toContain('delivers（すぐ人に届くか）')
    expect(errorsOf(edit('      delivers: none\n', '      delivers: later\n'))).toContain('delivers（すぐ人に届くか）')
    expect(errorsOf(edit('        account: { required: true }\n', ''))).toContain('facts に account（required: true）')
    expect(errorsOf(edit('        account: { required: true }\n', '        account: { required: false }\n'))).toContain('facts に account（required: true）')
    const read = `id: s\nversion: 0.1.0\nlabel: S\ncontract: 1\nbrowser:\n  host: a.example.com\n  operations:\n    r:\n      label: 読む\n      effect: read\n      checker: s.r\n      delivers: none\n      target: { a: id }\n`
    expect(errorsOf(read)).toBe('')
    expect(errorsOf(read.replace('      delivers: none\n', '      delivers: none\n      lock: { kind: s.r }\n'))).toContain('読むだけの操作に lock は書けません')
  })

  it('facts are strict: names, booleans, nothing else', () => {
    expect(errorsOf(edit('        names: { required: true }\n', '        names: { required: yes }\n'))).toContain('required は true か false')
    expect(errorsOf(edit('        names: { required: true }\n', '        names: { required: true, complete: 1 }\n'))).toContain('complete は true か false')
    expect(errorsOf(edit('        names: { required: true }\n', '        names: { required: true, when: x }\n'))).toContain('when')
    expect(errorsOf(edit('        names: { required: true }\n', '        Names: { required: true }\n'))).toContain('名前「Names」')
    expect(errorsOf(edit('        names: { required: true }\n', '        names: true\n'))).toContain('{ required: true か false }')
  })
})

describe('the first version\'s rule', () => {
  it('runs only one write that is not irreversible, not a deletion and delivers nothing at once', () => {
    expect(browserFirstVersionProblem(op())).toBeNull()
    expect(browserFirstVersionProblem({ ...op(), delivers: 'immediate' })).toContain('すぐ人に届く')
    expect(browserFirstVersionProblem({ ...op(), delivers: 'unknown' })).toContain('すぐ人に届く')
    expect(browserFirstVersionProblem({ ...op(), irreversible: true })).toContain('取り消せない')
    expect(browserFirstVersionProblem({ ...op(), effect: 'delete' })).toContain('消す操作')
    expect(browserFirstVersionProblem({ ...op(), writes: [...op().writes, ...op().writes] })).toContain('1つではない')
    expect(browserFirstVersionProblem({ ...op(), writes: [] })).toContain('1つではない')
    expect(browserFirstVersionProblem({ ...op(), lock: null })).toContain('lock')
  })
})

const AT = '2026-11-21T00:00:00.000Z'
const fact = (value: unknown, complete = true) => ({ status: 'known', value, complete, readAt: AT, source: '/line/episode/show/11' })
const goodFacts = () => ({
  account: fact({ id: 'acc1' }),
  step_parent: fact({ reminder: '11' }),
  state: fact({ templates: ['5'] }),
  names: fact({ reminder: 'リマインダ', step: '1日目' }),
  template_bodies: fact({ 5: '本文A', 7: '本文B\n2行目' }),
  shared_with: fact({ count: 2, items: ['第1回', '第2回'] }),
})
const values = { target: { reminder: '11', step: '22' }, change: { template: '7' } }
const problem = (facts: unknown, v = values) => browserFactsProblem(op(), BROWSER_FACTS_VERSION, facts, v)

describe('facts (facts version 1, lstep.reminder_step)', () => {
  it('a full set read whole passes, and gives the account and the state', () => {
    expect(problem(goodFacts())).toBeNull()
    expect(browserFactsAccount(goodFacts())).toBe('acc1')
    expect(browserFactsState(goodFacts())).toEqual({ templates: ['5'] })
  })

  it('a required fact missing, unknown or without its value refuses; one read in part refuses where complete is asked', () => {
    for (const name of ['account', 'step_parent', 'state', 'names', 'template_bodies', 'shared_with'] as const) {
      const missing: Record<string, unknown> = goodFacts(); delete missing[name]
      expect(problem(missing), name).toContain(name)
      expect(problem({ ...goodFacts(), [name]: { status: 'unknown', readAt: AT, source: '/a' } }), name).toContain('読み取れていません')
      expect(problem({ ...goodFacts(), [name]: { status: 'known', readAt: AT, source: '/a' } }), name).toContain('値の形')
    }
    for (const name of ['state', 'template_bodies', 'shared_with'] as const) {
      expect(problem({ ...goodFacts(), [name]: { ...goodFacts()[name], complete: false } }), name).toContain('全部は読み取れていません')
      expect(problem({ ...goodFacts(), [name]: { ...goodFacts()[name], complete: undefined } }), name).not.toBeNull()
    }
    // A fact without `complete` asked: read in part is fine.
    expect(problem({ ...goodFacts(), names: fact({ reminder: 'R', step: 'S' }, false) })).toBeNull()
  })

  it('unknown, an empty list and 0 are three answers: known-empty and 0 make a plan, unknown does not', () => {
    const empty = { ...goodFacts(), state: fact({ templates: [] }), template_bodies: fact({ 7: '本文' }), shared_with: fact({ count: 0, items: [] }) }
    expect(problem(empty)).toBeNull()
    expect(problem({ ...empty, shared_with: { status: 'unknown', readAt: AT, source: '/a' } })).toContain('読み取れていません')
  })

  it('every value has its shape', () => {
    const bad: Array<[string, unknown]> = [
      ['account', { id: '0 1' }], ['account', { id: 'a', name: 'x' }], ['account', 'acc1'],
      ['step_parent', { reminder: '' }], ['state', { templates: ['5', '../x'] }], ['state', { templates: '5' }], ['state', { templates: ['5'], extra: [] }],
      ['names', { reminder: 'R', step: 'x'.repeat(201) }], ['names', { reminder: 'R\nX', step: 'S' }], ['names', { reminder: 'R\u202eX', step: 'S' }],
      ['template_bodies', { 'a b': 'x' }], ['template_bodies', { 5: 'x'.repeat(5001), 7: 'b' }],
      ['shared_with', { count: -1, items: [] }], ['shared_with', { count: 1.5, items: [] }], ['shared_with', { count: 1, items: ['a', 'b'] }],
      ['shared_with', { count: 60, items: Array.from({ length: 51 }, (_, i) => `第${i}回`) }],
    ]
    for (const [name, value] of bad) expect(problem({ ...goodFacts(), [name]: fact(value) }), `${name} ${JSON.stringify(value)}`).toContain('値の形')
  })

  it('a fact\'s own shape is strict: status, readAt, source, nothing else', () => {
    expect(problem({ ...goodFacts(), names: { ...fact({ reminder: 'R', step: 'S' }), by: 'ai' } })).toContain('知らない項目')
    expect(problem({ ...goodFacts(), names: { ...fact({ reminder: 'R', step: 'S' }), status: 'verified' } })).toContain('status')
    expect(problem({ ...goodFacts(), names: { ...fact({ reminder: 'R', step: 'S' }), readAt: 'yesterday' } })).toContain('時刻')
    expect(problem({ ...goodFacts(), names: { ...fact({ reminder: 'R', step: 'S' }), source: 'https://evil.example/' } })).toContain('読み先')
    expect(problem({ ...goodFacts(), names: { status: 'unknown', value: { reminder: 'R', step: 'S' }, readAt: AT, source: '/a' } })).toContain('値があります')
    expect(problem({ ...goodFacts(), verified: fact(true) })).toContain('この操作で読む情報ではありません')
    expect(problem(null)).not.toBeNull()
  })

  it('the step must belong to the plan\'s reminder, and the bodies of the templates involved must all be there', () => {
    expect(problem({ ...goodFacts(), step_parent: fact({ reminder: '12' }) })).toContain('所属')
    expect(problem({ ...goodFacts(), template_bodies: fact({ 5: '本文A' }) })).toContain('本文')
    expect(problem({ ...goodFacts(), template_bodies: fact({ 7: '本文B' }) })).toContain('本文')
  })

  it('a declared fact the facts version does not know makes the type unusable', () => {
    const withExtra = op(edit('        names: { required: true }\n', '        names: { required: true }\n        mood: { required: false }\n'))
    expect(browserFactsDeclarationProblem(withExtra, BROWSER_FACTS_VERSION)).toContain('mood')
    expect(browserFactsDeclarationProblem({ ...op(), checker: 'other.thing' }, BROWSER_FACTS_VERSION)).toContain('other.thing')
    expect(browserFactsDeclarationProblem(op(), 99)).toContain('版 99')
    expect(browserFactsProblem(withExtra, BROWSER_FACTS_VERSION, goodFacts(), values)).toContain('mood')
  })
})

describe('the target lock key', () => {
  const base = { company: 'c1', host: 'manager.linestep.net', account: 'acc1', kind: 'lstep.reminder_step', fields: { reminder: 'id', step: 'id' } as const, target: { reminder: '11', step: '22' } }
  it('names the company, host, account, kind and every target field; field order does not matter', () => {
    const key = browserLockKey(base)
    expect(JSON.parse(key)).toEqual({ account: 'acc1', company: 'c1', fields: [['reminder', '11'], ['step', '22']], host: 'manager.linestep.net', kind: 'lstep.reminder_step' })
    expect(browserLockKey({ ...base, fields: { step: 'id', reminder: 'id' } })).toBe(key)
    for (const change of [{ company: 'c2' }, { account: 'acc2' }, { kind: 'lstep.other' }, { host: 'x.example.com' }, { target: { reminder: '11', step: '23' } }]) {
      expect(browserLockKey({ ...base, ...change }), JSON.stringify(change)).not.toBe(key)
    }
  })
  it('a text value cannot run into the next part, and its NFC form is one key', () => {
    const text = { ...base, fields: { a: 'text', b: 'text' } as const }
    expect(browserLockKey({ ...text, target: { a: 'x|b=y', b: 'z' } })).not.toBe(browserLockKey({ ...text, target: { a: 'x', b: 'y|b=z' } }))
    expect(browserLockKey({ ...text, target: { a: 'か\u3099', b: 'z' } })).toBe(browserLockKey({ ...text, target: { a: '\u304c', b: 'z' } }))
  })
})

describe('the AI stop', () => {
  it('a whole-AI, web or external-MCP stop stops browser operation; a command or write stop alone does not', () => {
    expect(browserAiStopped({ all: true, tools: [] })).toBe(true)
    expect(browserAiStopped({ all: false, tools: ['web'] })).toBe(true)
    expect(browserAiStopped({ all: false, tools: ['mcp-external'] })).toBe(true)
    expect(browserAiStopped({ all: false, tools: ['command', 'write'] })).toBe(false)
    expect(browserAiStopped(undefined)).toBe(false)
  })
})
