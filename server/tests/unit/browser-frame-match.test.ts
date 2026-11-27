/**
 * Does a held write fit a frame (shared/core/browser-frame-match.ts; agent-browser.md "Writes within frames")? The one
 * rule the server's permit and ⑤b's app both ask. Guards: the path pattern never matches more than it says (a placeholder
 * is one segment, `{n}` digits only, no dot segment or encoded separator, no query, the trailing slash as written); an
 * undeclared `_method` never passes, a declared one must be exactly it; the frame's fixed fields exactly, and no other
 * field may be named; an AI-written plan may not be "any path"; a `{made:<n>}` segment fits only an id the n-th frame made
 * in this run; a query fits only a frame that declares exactly that raw string. Fictional paths.
 */
import { describe, expect, it } from 'vitest'
import { browserAdhocWritesProblem, browserFrameMismatch, browserFramePathFits } from '../../../shared/core/browser-frame-match'
import type { BrowserSkillWrite } from '../../../shared/core/browser-skill'

const frame = (path: string, fields: Record<string, string> = {}, method: BrowserSkillWrite['method'] = 'POST', query: string | null = null): BrowserSkillWrite => ({ method, path, query, max: 1, fields })

describe('a path fits a frame\'s pattern', () => {
  it.each([
    ['/api/orders/register', '/api/orders/register', true],
    ['/api/orders/register', '/api/orders/register/', false],
    ['/api/orders/register', '/api/orders', false],
    ['/api/orders/register', '/API/orders/register', false],
    ['/api/orders/', '/api/orders/', true],
    ['/api/orders/', '/api/orders', false],
    ['/api/orders/{n}', '/api/orders/42', true],
    ['/api/orders/{n}', '/api/orders/4a', false],
    ['/api/orders/{n}', '/api/orders/', false],
    ['/api/orders/{n}', '/api/orders/42/x', false],
    ['/api/{x}/note', '/api/abc-1_2.x/note', true],
    ['/api/{x}/note', '/api/%E3%81%82/note', true],
    ['/api/{x}/note', '/api/../note', false],
    ['/api/{x}/note', '/api/%2e%2E/note', false],
    ['/api/{x}/note', '/api/.%2e/note', false],
    ['/api/{x}/note', '/api/a%2Fb/note', false],
    ['/api/{x}/note', '/api/a%5cb/note', false],
    ['/api/{x}/note', '/api//note', false],
    ['/api/{x}/note', '/api/a/b/note', false],
    ['/api/orders/register', '/api/orders/register?copy=1', false],
    ['/api/orders/register', '/api/orders/register#x', false],
    ['/api/orders/register', 'api/orders/register', false],
    ['/api/orders/register', '/api\\orders/register', false],
    ['/api/{created}', '/api/1', false],
    ['/api/{created}', '/api/{created}', false],
    ['/api/orders/', '/api/orders/x', false],
  ])('%s ~ %s → %s', (pattern, path, fits) => {
    expect(browserFramePathFits(pattern, path)).toBe(fits)
  })
})

describe('a request fits a frame', () => {
  it('the method exactly', () => {
    expect(browserFrameMismatch(frame('/a'), { method: 'POST', path: '/a', fields: {} })).toBeNull()
    expect(browserFrameMismatch(frame('/a'), { method: 'post', path: '/a', fields: {} })).toBe('method')
    expect(browserFrameMismatch(frame('/a'), { method: 'PUT', path: '/a', fields: {} })).toBe('method')
  })

  it('an undeclared `_method` never passes; a declared one exactly', () => {
    expect(browserFrameMismatch(frame('/a'), { method: 'POST', path: '/a', fields: { _method: 'DELETE' } })).toBe('method-override')
    const f = frame('/a', { _method: 'PATCH' })
    expect(browserFrameMismatch(f, { method: 'POST', path: '/a', fields: {} })).toBe('method-override')
    expect(browserFrameMismatch(f, { method: 'POST', path: '/a', fields: { _method: 'DELETE' } })).toBe('method-override')
    expect(browserFrameMismatch(f, { method: 'POST', path: '/a', fields: { _method: 'PATCH' } })).toBeNull()
  })

  it('the frame\'s fixed fields exactly, and nothing else named', () => {
    const f = frame('/a', { kind: 'copy' })
    expect(browserFrameMismatch(f, { method: 'POST', path: '/a', fields: { kind: 'copy' } })).toBeNull()
    expect(browserFrameMismatch(f, { method: 'POST', path: '/a', fields: { kind: 'move' } })).toBe('fields')
    expect(browserFrameMismatch(f, { method: 'POST', path: '/a', fields: {} })).toBe('fields')
    expect(browserFrameMismatch(f, { method: 'POST', path: '/a', fields: { kind: 'copy', name: 'x' } })).toBe('fields')
    expect(browserFrameMismatch(frame('/a'), { method: 'POST', path: '/a', fields: { name: 'x' } })).toBe('fields')
  })
})

describe('an AI-written plan', () => {
  it('begins every path with a literal segment', () => {
    expect(browserAdhocWritesProblem([frame('/api/{n}'), frame('/x/{x}/y')])).toBeNull()
    for (const p of ['/{x}', '/{n}/a', '/']) expect(browserAdhocWritesProblem([frame('/api/a'), frame(p)])).toBe('wide-path')
    // "Only what this run made" is a reviewed Skill's, never an AI-written plan's.
    expect(browserAdhocWritesProblem([frame('/api/a'), frame('/api/a/{made:1}/b')])).toBe('made')
  })
})

describe('a {made:<n>} frame fits only what this run made', () => {
  const f = frame('/api/plans/{made:1}/items')
  const req = (id: string) => ({ method: 'POST', path: `/api/plans/${id}/items`, fields: {} })
  const made = (ids: Record<number, string[]>) => new Map(Object.entries(ids).map(([k, v]) => [Number(k), new Set(v)]))

  it('nothing fits without what was made, nor another frame\'s, nor another id', () => {
    expect(browserFrameMismatch(f, req('77'))).toBe('made')
    expect(browserFrameMismatch(f, req('77'), made({}))).toBe('made')
    expect(browserFrameMismatch(f, req('77'), made({ 2: ['77'] }))).toBe('made')
    expect(browserFrameMismatch(f, req('78'), made({ 1: ['77'] }))).toBe('made')
    expect(browserFrameMismatch(f, req('77'), made({ 1: ['77'] }))).toBeNull()
    expect(browserFrameMismatch(f, req('p9'), made({ 1: ['77', 'p9'] }))).toBeNull()
  })

  it('the rest of the path still decides first, and a made id is one plain segment', () => {
    expect(browserFrameMismatch(f, { method: 'POST', path: '/api/plans/77/other', fields: {} }, made({ 1: ['77'] }))).toBe('path')
    expect(browserFrameMismatch(f, { method: 'PUT', path: '/api/plans/77/items', fields: {} }, made({ 1: ['77'] }))).toBe('method')
    for (const id of ['..', '%2e%2e', 'a%2Fb', '']) expect(browserFrameMismatch(f, req(id), made({ 1: [id] })), id).toBe('path')
    expect(browserFramePathFits('/api/plans/{made:1}/items', '/api/plans/77/items')).toBe(false)
    expect(browserFramePathFits('/api/plans/{made:1}/items', '/api/plans/77/items', made({ 1: ['77'] }))).toBe(true)
  })
})

describe('a request with a query (agent-browser.md "A write with an exact query")', () => {
  const at = (path: string, fields: Record<string, string> = {}) => ({ method: 'POST', path, fields })

  it('a frame without a query refuses any query, even an empty one', () => {
    expect(browserFrameMismatch(frame('/a'), at('/a'))).toBeNull()
    for (const p of ['/a?', '/a?x', '/a?x=1', '/a?#']) expect([p, browserFrameMismatch(frame('/a'), at(p))]).toEqual([p, 'query'])
  })

  it('a frame with a query takes exactly that raw string and nothing near it', () => {
    const f = frame('/a', {}, 'POST', 'return')
    expect(browserFrameMismatch(f, at('/a?return'))).toBeNull()
    for (const p of ['/a', '/a?', '/a?return=', '/a?return=1', '/a?Return', '/a?RETURN', '/a?return&return', '/a?return&x', '/a?x&return',
      '/a?%72eturn', '/a?return%00', '/a?return;', '/a?return;x=1', '/a?return#', '/a?return#x', '/a?return+', '/a?+return', '/a?return&_method=DELETE',
      '/a??return', '/a?return?']) {
      expect([p, browserFrameMismatch(f, at(p))]).toEqual([p, 'query'])
    }
  })

  it('key=value pairs in the declared order only', () => {
    const f = frame('/a', {}, 'POST', 'b=2&a=1')
    expect(browserFrameMismatch(f, at('/a?b=2&a=1'))).toBeNull()
    expect(browserFrameMismatch(f, at('/a?a=1&b=2'))).toBe('query')
    expect(browserFrameMismatch(f, at('/a?b=2&a=1&a=1'))).toBe('query')
    expect(browserFrameMismatch(f, at('/a?b=02&a=1'))).toBe('query')
  })

  it('the path still decides first; {n} / {made} unchanged', () => {
    const f = frame('/a/{n}', {}, 'POST', 'return')
    expect(browserFrameMismatch(f, at('/a/7?return'))).toBeNull()
    expect(browserFrameMismatch(f, at('/a/x?return'))).toBe('path')
    expect(browserFrameMismatch(f, at('/a/7/?return'))).toBe('path')
    const m = frame('/a/{made:1}/b', {}, 'POST', 'return')
    expect(browserFrameMismatch(m, at('/a/77/b?return'), new Map([[1, new Set(['77'])]]))).toBeNull()
    expect(browserFrameMismatch(m, at('/a/78/b?return'), new Map([[1, new Set(['77'])]]))).toBe('made')
  })

  it('an override never rides in the address: the body\'s `_method` is still asked, and a frame holding a bad query fits nothing', () => {
    const f = frame('/a', {}, 'POST', 'return')
    expect(browserFrameMismatch(f, at('/a?return', { _method: 'DELETE' }))).toBe('method-override')
    // A frame that somehow holds a query the parser would refuse (not from a parsed declaration) fits nothing, even exactly.
    for (const q of ['_method=DELETE', 'a%20b', 'a;b', 'a&a', 'a=']) expect([q, browserFrameMismatch(frame('/a', {}, 'POST', q), at(`/a?${q}`))]).toEqual([q, 'query'])
  })

  it('a value not fixed ("A query value not fixed"): one plain value of its kind, everything else as exact as before', () => {
    const x = frame('/api/tags', {}, 'POST', 'return={x}')
    for (const p of ['/api/tags?return=1', '/api/tags?return=folder-7.v2_~', `/api/tags?return=${'a'.repeat(64)}`]) expect([p, browserFrameMismatch(x, at(p))]).toEqual([p, null])
    for (const p of [
      '/api/tags', '/api/tags?', '/api/tags?return', '/api/tags?return=', // missing or empty: never fits
      '/api/tags?return=%31', '/api/tags?return=a%20b', '/api/tags?return=a+b', '/api/tags?return=a;b', '/api/tags?return=a#b', '/api/tags?return=a/b', '/api/tags?return=ä',
      '/api/tags?return=a=b', `/api/tags?return=${'a'.repeat(65)}`,
      '/api/tags?return=1&x', '/api/tags?x&return=1', '/api/tags?return=1&return=2', '/api/tags?Return=1', '/api/tags?%72eturn=1', // keys exact
      '/api/tags?return=1&_method=DELETE', '/api/tags?return={x}x', '/api/tags?returnx', '/api/tags?return1',
    ]) expect([p, browserFrameMismatch(x, at(p))]).toEqual([p, 'query'])
    // `{n}`: digits only.
    const n = frame('/api/tags', {}, 'POST', 'page={n}')
    expect(browserFrameMismatch(n, at('/api/tags?page=12'))).toBeNull()
    for (const p of ['/api/tags?page=1a', '/api/tags?page=', '/api/tags?page=-1', '/api/tags?page=%31', '/api/tags?page={n}']) expect([p, browserFrameMismatch(n, at(p))]).toEqual([p, 'query'])
    // The placeholder sent literally is not a value of its kind (Codex review: no shortcut on equal strings).
    expect(browserFrameMismatch(x, at('/api/tags?return={x}'))).toBe('query')
    // Two keys: the declared order, a literal beside a placeholder compared byte for byte.
    const two = frame('/api/tags', {}, 'POST', 'kind=label&return={x}')
    expect(browserFrameMismatch(two, at('/api/tags?kind=label&return=7'))).toBeNull()
    for (const p of ['/api/tags?return=7&kind=label', '/api/tags?kind=Label&return=7', '/api/tags?kind=label', '/api/tags?kind=label&return=7&return=8']) {
      expect([p, browserFrameMismatch(two, at(p))]).toEqual([p, 'query'])
    }
    // A frame holding a placeholder where the grammar refuses one (a name) fits nothing.
    expect(browserFrameMismatch(frame('/api/tags', {}, 'POST', '{x}=1'), at('/api/tags?a=1'))).toBe('query')
  })

  it('an AI-written plan carries no query', () => {
    expect(browserAdhocWritesProblem([frame('/api/a', {}, 'POST', 'return')])).toBe('query')
    expect(browserAdhocWritesProblem([frame('/api/a')])).toBeNull()
  })
})
