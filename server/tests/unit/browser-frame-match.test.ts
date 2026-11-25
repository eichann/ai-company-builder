/**
 * Does a held write fit a frame (shared/core/browser-frame-match.ts; agent-browser.md "Writes within frames")? The one
 * rule the server's permit and ⑤b's app both ask. Guards: the path pattern never matches more than it says (a placeholder
 * is one segment, `{n}` digits only, no dot segment or encoded separator, no query, the trailing slash as written); an
 * undeclared `_method` never passes, a declared one must be exactly it; the frame's fixed fields exactly, and no other
 * field may be named; an AI-written plan may not be "any path". Fictional paths.
 */
import { describe, expect, it } from 'vitest'
import { browserAdhocWritesProblem, browserFrameMismatch, browserFramePathFits } from '../../../shared/core/browser-frame-match'
import type { BrowserSkillWrite } from '../../../shared/core/browser-skill'

const frame = (path: string, fields: Record<string, string> = {}, method: BrowserSkillWrite['method'] = 'POST'): BrowserSkillWrite => ({ method, path, max: 1, fields })

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
  })
})
