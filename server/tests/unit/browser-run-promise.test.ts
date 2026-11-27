/**
 * The run's promise, the core's one rule (shared/core/browser-run-promise.ts; agent-browser.md "The run's promise"): what a
 * write of a run may carry, asked by the server at every permit and by the app before it asks. A fictional site.
 *
 * Guards (each mutation-checked): a bound field with another value or none is `broken` (never asked); a bound field with
 * no promised value, a field outside a declared `body` and an open path segment neither made nor promised are `ask`; a
 * target this run made or a promised value is `kept`; an addition fills an empty bind but never changes a promised value;
 * the app's first promise binds by label (the person's value before the preview's) and never binds a value it does not
 * promise; the strict readers refuse what the run's frames do not allow.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { parseBrowserSkillDeclaration, BROWSER_SKILL_LIMITS } from '../../../shared/core/browser-skill'
import {
  browserOpenSegments, browserPromiseLabelKey, browserPromiseState, browserPromiseVerdict, buildBrowserRunPromise, readBrowserPermitCheck,
  readBrowserRunPromise, readBrowserRunPromiseAddition, type BrowserPromiseFrame,
} from '../../../shared/core/browser-run-promise'

const D = (v: string) => `hmac:${createHash('sha256').update(`k\0${v}`).digest('hex')}`
const REGISTER: BrowserPromiseFrame = { path: '/api/items', fields: { kind: 'note' }, body: ['memo'], bind: { title: '名前', day: '日付' } }
const NOTE: BrowserPromiseFrame = { path: '/api/items/{n}/notes/{x}', fields: {} }
const FRAMES = [REGISTER, NOTE]
const first = { values: [{ digest: D('冬の回'), source: 'person' as const }, { digest: D('2026-12-03'), source: 'person' as const }], binds: [{ frame: 1, field: 'title', digest: D('冬の回') }, { frame: 1, field: 'day', digest: D('2026-12-03') }], decisions: [] }
const fieldsOf = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, D(v)]))
const verdict = (frameIdx: number, path: string, fields: Record<string, string>, segments: Array<string | null>, made: string[] = [], adds: Parameters<typeof browserPromiseState>[1] = []) =>
  browserPromiseVerdict({ frameIdx, frame: FRAMES[frameIdx - 1], path, check: { fields: fieldsOf(fields), segments }, promise: browserPromiseState(first, adds), made: new Set(made) })

describe('the run\'s promise: the verdict', () => {
  it('kept: every bound field holds its promised value, other fields are the frame\'s', () => {
    expect(verdict(1, '/api/items', { title: '冬の回', day: '2026-12-03', memo: 'x', kind: 'note' }, [null, null])).toEqual({ kind: 'kept' })
  })

  it('broken: a bound field with another value, or missing — never asked', () => {
    expect(verdict(1, '/api/items', { title: '夏の回', day: '2026-12-03' }, [null, null])).toEqual({ kind: 'broken', reason: 'value', field: 'title' })
    expect(verdict(1, '/api/items', { title: '冬の回' }, [null, null])).toEqual({ kind: 'broken', reason: 'missing', field: 'day' })
    // A value written another way is another value (no folding: the digest of exactly what is sent).
    expect(verdict(1, '/api/items', { title: '冬の回 ', day: '2026-12-03' }, [null, null]).kind).toBe('broken')
  })

  it('ask: a field outside the declared body; a frame without `body` asks nothing of its fields', () => {
    expect(verdict(1, '/api/items', { title: '冬の回', day: '2026-12-03', owner: 'x', admin: '1' }, [null, null])).toEqual({ kind: 'ask', fields: ['admin', 'owner'], targets: [], values: [] })
    expect(verdict(2, '/api/items/7/notes/a', { anything: 'x' }, [null, null, D('7'), null, D('a')], ['7', 'a'])).toEqual({ kind: 'kept' })
  })

  it('targets: an open segment is kept only when this run made it or the person promised it; else asked by its place', () => {
    expect(browserOpenSegments(NOTE.path)).toEqual([2, 4])
    expect(verdict(2, '/api/items/7/notes/a', {}, [null, null, D('7'), null, D('a')])).toEqual({ kind: 'ask', fields: [], targets: [2, 4], values: [] })
    expect(verdict(2, '/api/items/7/notes/a', {}, [null, null, D('7'), null, D('a')], ['7'])).toEqual({ kind: 'ask', fields: [], targets: [4], values: [] })
    // A promised value fits as a target (the person said it); an added target too.
    expect(verdict(2, '/api/items/7/notes/冬の回', {}, [null, null, D('7'), null, D('冬の回')], ['7']).kind).toBe('kept')
    expect(verdict(2, '/api/items/7/notes/a', {}, [null, null, D('7'), null, D('a')], ['7'], [{ frame: 2, fields: [], targets: [D('a')], binds: [] }]).kind).toBe('kept')
    // A segment the check left without a digest is never promised.
    expect(verdict(2, '/api/items/7/notes/冬の回', {}, [null, null, D('7'), null, null], ['7']).kind).toBe('ask')
  })

  it('a bound field with no promised value is asked; the person\'s value fills it, and an addition never changes one already there', () => {
    const empty = { values: [], binds: [], decisions: [] }
    const v = (adds: Parameters<typeof browserPromiseState>[1], title: string) => browserPromiseVerdict({
      frameIdx: 1, frame: REGISTER, path: '/api/items', check: { fields: fieldsOf({ title, day: 'd' }), segments: [null, null] }, promise: browserPromiseState(empty, adds), made: new Set(),
    })
    expect(v([], 'x')).toEqual({ kind: 'ask', fields: [], targets: [], values: ['day', 'title'] })
    const filled = [{ frame: 1, fields: [], targets: [], binds: [{ field: 'title', digest: D('x') }, { field: 'day', digest: D('d') }] }]
    expect(v(filled, 'x').kind).toBe('kept')
    const changed = [...filled, { frame: 1, fields: [], targets: [], binds: [{ field: 'title', digest: D('y') }] }]
    expect(v(changed, 'y')).toEqual({ kind: 'broken', reason: 'value', field: 'title' })
  })
})

describe('the run\'s promise: the app builds it, the server reads it strictly', () => {
  it('binds by label, the person\'s value before the preview\'s, labels compared folded; an unmatched bind is left to ask', () => {
    const { promise, plain } = buildBrowserRunPromise({
      frames: FRAMES, person: [{ label: ' 名前 ', value: '冬の回' }], preview: [{ label: '名前', value: '秋の回' }, { label: 'コピー元', value: '秋の回' }], decisions: ['proceed'], digest: D,
    })
    expect(promise.values).toEqual([{ digest: D('冬の回'), source: 'person' }, { digest: D('秋の回'), source: 'preview' }])
    expect(promise.binds).toEqual([{ frame: 1, field: 'title', digest: D('冬の回') }])
    expect(promise.decisions).toEqual(['proceed'])
    expect(plain.get(D('冬の回'))).toBe('冬の回')
    expect(browserPromiseLabelKey('Ｎａｍｅ  1')).toBe('name 1')
    // No preview (a pre-approved Skill): nothing read from the screen is promised.
    expect(buildBrowserRunPromise({ frames: FRAMES, person: [], preview: null, decisions: [], digest: D }).promise).toEqual({ values: [], binds: [], decisions: [] })
    expect(readBrowserRunPromise(promise, FRAMES)).toEqual(promise)
  })

  it('the first promise: only a field its frame binds, once, to a value of the promise; digests only', () => {
    expect(readBrowserRunPromise(first, FRAMES)).toEqual(first)
    for (const bad of [
      { ...first, binds: [{ frame: 1, field: 'memo', digest: D('冬の回') }] },
      { ...first, binds: [{ frame: 2, field: 'title', digest: D('冬の回') }] },
      { ...first, binds: [{ frame: 1, field: 'title', digest: D('x') }] },
      { ...first, binds: [first.binds[0], first.binds[0]] },
      { ...first, values: [{ digest: 'sha256:x', source: 'person' }] },
      { ...first, values: [{ digest: D('a'), source: 'asked' }] },
      { ...first, decisions: ['proceed', 'proceed'] },
      { ...first, decisions: ['stop'] },
      { values: first.values, binds: first.binds },
      { ...first, values: Array.from({ length: 33 }, (_, i) => ({ digest: D(String(i)), source: 'person' })) },
    ]) expect(readBrowserRunPromise(bad, FRAMES), JSON.stringify(bad)).toBeNull()
  })

  it('an addition: something in it, plain field names (never `_method` or a login field), digests for targets, binds only of its frame', () => {
    expect(readBrowserRunPromiseAddition({ frame: 1, fields: ['owner'], targets: [D('7')], binds: [{ field: 'title', digest: D('x') }] }, FRAMES)).not.toBeNull()
    for (const bad of [
      { frame: 1, fields: [], targets: [], binds: [] },
      { frame: 1, fields: ['_method'], targets: [], binds: [] },
      { frame: 1, fields: ['session_id'], targets: [], binds: [] },
      { frame: 1, fields: ['a', 'a'], targets: [], binds: [] },
      { frame: 1, fields: [], targets: ['7'], binds: [] },
      { frame: 2, fields: [], targets: [], binds: [{ field: 'title', digest: D('x') }] },
      { frame: 3, fields: ['a'], targets: [], binds: [] },
      { frame: 1, fields: ['a'], targets: [], binds: [], extra: true },
    ]) expect(readBrowserRunPromiseAddition(bad, FRAMES), JSON.stringify(bad)).toBeNull()
  })

  it('a permit\'s check: a digest per field, one entry per path segment', () => {
    expect(readBrowserPermitCheck({ fields: { a: D('1') }, segments: [null, D('7')] }, 2)).not.toBeNull()
    expect(readBrowserPermitCheck({ fields: { a: D('1') }, segments: [null] }, 2)).toBeNull()
    expect(readBrowserPermitCheck({ fields: { a: '1' }, segments: [] }, 0)).toBeNull()
    expect(readBrowserPermitCheck({ fields: { 'a\nb': D('1') }, segments: [] }, 0)).toBeNull()
    expect(readBrowserPermitCheck({ fields: {}, segments: [], more: 1 }, 0)).toBeNull()
  })
})

describe('a Skill\'s `body` and `bind` (browser.yaml)', () => {
  const y = (w: string) => `domain: shop.example.test\nwrites:\n  - ${w}\n`
  it('parsed and kept; a Skill without them unchanged', () => {
    const r = parseBrowserSkillDeclaration(y('{ method: POST, path: /api/items, max: 1, fields: { kind: note }, body: [title, memo], bind: { title: 名前 } }'))
    expect(r.ok && r.declaration.writes[0]).toMatchObject({ body: ['title', 'memo'], bind: { title: '名前' } })
    const plain = parseBrowserSkillDeclaration(y('{ method: POST, path: /api/items, max: 1 }'))
    expect(plain.ok && plain.declaration.writes[0]).toEqual({ method: 'POST', path: '/api/items', query: null, max: 1, fields: {} })
  })

  it('refused: a login or `_method` field, a fixed field, a bound field outside `body`, a bad label, too many', () => {
    for (const [w, problem] of [
      ['{ method: POST, path: /a, max: 1, body: [] }', 'bad-body'],
      ['{ method: POST, path: /a, max: 1, body: [csrf_token] }', 'bad-body'],
      ['{ method: POST, path: /a, max: 1, body: [_method] }', 'bad-body'],
      ['{ method: POST, path: /a, max: 1, body: [a, a] }', 'bad-body'],
      ['{ method: POST, path: /a, max: 1, fields: { kind: note }, body: [kind] }', 'bad-body'],
      [`{ method: POST, path: /a, max: 1, body: [${Array.from({ length: BROWSER_SKILL_LIMITS.body + 1 }, (_, i) => `f${i}`).join(', ')}] }`, 'bad-body'],
      ['{ method: POST, path: /a, max: 1, bind: {} }', 'bad-bind'],
      ['{ method: POST, path: /a, max: 1, bind: { password: 名前 } }', 'bad-bind'],
      ['{ method: POST, path: /a, max: 1, fields: { kind: note }, bind: { kind: 名前 } }', 'bad-bind'],
      ['{ method: POST, path: /a, max: 1, body: [memo], bind: { title: 名前 } }', 'bad-bind'],
      [`{ method: POST, path: /a, max: 1, bind: { title: "${'名'.repeat(41)}" } }`, 'bad-bind'],
      ['{ method: POST, path: /a, max: 1, bind: { title: " 名前" } }', 'bad-bind'],
      ['{ method: POST, path: /a, max: 1, bind: { title: [名前] } }', 'bad-bind'],
    ] as const) {
      const r = parseBrowserSkillDeclaration(y(w))
      expect(r.ok ? 'ok' : r.problem, w).toBe(problem)
    }
  })
})
