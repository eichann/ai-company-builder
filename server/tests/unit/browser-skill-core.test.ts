/**
 * A company Skill's browser declaration (`browser.yaml`, shared/core/browser-skill.ts; agent-browser.md "A Skill's browser
 * declaration and its approval"). The site is fictional.
 *
 * Guards: strict keys at every level, every list and string within its limit, the file's size, the strict YAML subset
 * (no anchors or aliases), the path grammar (no query on a write, `{created}` only after writing, no dot segments or
 * encodings), `_method` only on a POST and only as PUT / PATCH / DELETE, no login / CSRF field fixed in a company file, a
 * domain in its exact spelling and registered, the frames a copy nothing outside can change; a `{made:<id>}` names only an
 * earlier target's id, once per path, only in a write, and is said in plain words.
 */
import { describe, expect, it } from 'vitest'
import {
  BROWSER_SKILL_LIMITS, browserMadeFrom, browserSkillDomainProblem, browserSkillFrames, browserSkillWriteLine, isBrowserSkillPath, parseBrowserSkillDeclaration,
} from '../../../shared/core/browser-skill'

const GOOD = `
domain: shop.example.test
writes:
  - { method: POST, path: /api/orders/register, max: 1 }
  - method: POST
    path: /api/orders/{n}
    max: 2
    fields: { _method: PATCH, action: copy }
never_read: [ "/api/orders/{n}?copy=1" ]
after_read: [ "/api/orders/{created}", /api/orders ]
account_marker: { meta: shop-account-id }
safe_pattern: none
`

const problemOf = (text: string) => {
  const r = parseBrowserSkillDeclaration(text)
  return r.ok ? null : r.problem
}

describe('browser.yaml', () => {
  it('a declaration in the shape is read', () => {
    const r = parseBrowserSkillDeclaration(GOOD)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.declaration).toEqual({
      domain: 'shop.example.test',
      writes: [
        { method: 'POST', path: '/api/orders/register', max: 1, fields: {} },
        { method: 'POST', path: '/api/orders/{n}', max: 2, fields: { _method: 'PATCH', action: 'copy' } },
      ],
      neverRead: ['/api/orders/{n}?copy=1'],
      afterRead: ['/api/orders/{created}', '/api/orders'],
      accountMarker: { meta: 'shop-account-id' },
      safePattern: 'none',
    })
    // Only domain and writes are required.
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: PUT, path: /x, max: 1 } ]\n')).toBeNull()
  })

  it('refuses unknown keys, at the top and in a write', () => {
    expect(problemOf(`${GOOD}extra: 1\n`)).toBe('unknown-key')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1, note: hi } ]\n')).toBe('bad-writes')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\naccount_marker: { meta: a, name: b }\n')).toBe('bad-account-marker')
  })

  it('refuses what is missing or not of its kind', () => {
    expect(problemOf('writes: [ { method: POST, path: /x, max: 1 } ]\n')).toBe('missing-key')
    expect(problemOf('domain: shop.example.test\n')).toBe('missing-key')
    expect(problemOf('domain: shop.example.test\nwrites: []\n')).toBe('bad-writes')
    expect(problemOf('- a\n- b\n')).toBe('not-object')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: GET, path: /x, max: 1 } ]\n')).toBe('bad-method')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: post, path: /x, max: 1 } ]\n')).toBe('bad-method')
    for (const max of ['0', '21', '1.5', '"1"']) {
      expect(problemOf(`domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: ${max} } ]\n`), max).toBe('bad-max')
    }
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\nsafe_pattern: strict\n')).toBe('bad-safe-pattern')
  })

  it('refuses a domain not in its exact spelling', () => {
    for (const d of ['*.example.test', 'Shop.example.test', 'https://shop.example.test', 'shop.example.test.', '127.0.0.1', 'localhost']) {
      expect(problemOf(`domain: "${d}"\nwrites: [ { method: POST, path: /x, max: 1 } ]\n`), d).toBe('bad-domain')
    }
  })

  it('refuses a file over its size, and YAML\'s corners', () => {
    const big = `${GOOD}# ${'x'.repeat(BROWSER_SKILL_LIMITS.bytes)}\n`
    expect(problemOf(big)).toBe('too-large')
    // Counted in UTF-8 bytes, not characters.
    const wide = `${GOOD}# ${'あ'.repeat(Math.ceil(BROWSER_SKILL_LIMITS.bytes / 3))}\n`
    expect(wide.length).toBeLessThan(BROWSER_SKILL_LIMITS.bytes)
    expect(problemOf(wide)).toBe('too-large')
    expect(problemOf('domain: &d shop.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\nalias: *d\n')).toBe('not-yaml')
    expect(problemOf('domain: shop.example.test\ndomain: other.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\n')).toBe('not-yaml')
  })

  it('refuses lists over their limits', () => {
    const writes = Array.from({ length: BROWSER_SKILL_LIMITS.writes + 1 }, (_, i) => `  - { method: POST, path: /w${i}, max: 1 }`).join('\n')
    expect(problemOf(`domain: shop.example.test\nwrites:\n${writes}\n`)).toBe('bad-writes')
    const never = Array.from({ length: BROWSER_SKILL_LIMITS.neverRead + 1 }, (_, i) => `/r${i}`).join(', ')
    expect(problemOf(`domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\nnever_read: [ ${never} ]\n`)).toBe('bad-never-read')
    const fields = Array.from({ length: BROWSER_SKILL_LIMITS.fields + 1 }, (_, i) => `f${i}: v`).join(', ')
    expect(problemOf(`domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1, fields: { ${fields} } } ]\n`)).toBe('bad-fields')
  })

  it('the path grammar', () => {
    for (const p of ['/', '/api/orders', '/api/orders/', '/api/orders/{n}', '/a/{x}/b', '/v2/a.json', '/a_b/c-d/~e']) expect(isBrowserSkillPath(p), p).toBe(true)
    for (const p of ['', 'api/orders', '/api//orders', '/api/../x', '/api/./x', '/api/%2e%2e', '/api/a%2Fb', '/a?b=1', '/a#f', '/a/{id}', '/a/{created}', '/a/{n', '/a b', `/${'a'.repeat(BROWSER_SKILL_LIMITS.path)}`]) {
      expect(isBrowserSkillPath(p), p).toBe(false)
    }
    // A query only where reading must not happen; `{created}` only after writing.
    expect(isBrowserSkillPath('/a/{n}?copy=1&x', { query: true })).toBe(true)
    expect(isBrowserSkillPath('/a?copy=1=2', { query: true })).toBe(false)
    expect(isBrowserSkillPath('/a?c%3D=1', { query: true })).toBe(false)
    expect(isBrowserSkillPath('/a/{created}', { created: true })).toBe(true)
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: "/a?x=1", max: 1 } ]\n')).toBe('bad-path')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: "/a/{created}", max: 1 } ]\n')).toBe('bad-path')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\nnever_read: [ "/a/{created}" ]\n')).toBe('bad-never-read')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\nafter_read: [ "/a?x=1" ]\n')).toBe('bad-after-read')
    expect(problemOf('domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1 } ]\nafter_read: [ /a, /a ]\n')).toBe('bad-after-read')
  })

  it('_method only on a POST and only PUT / PATCH / DELETE (I4)', () => {
    const w = (m: string, v: string) => `domain: shop.example.test\nwrites: [ { method: ${m}, path: /x, max: 1, fields: { _method: ${v} } } ]\n`
    expect(problemOf(w('POST', 'DELETE'))).toBeNull()
    expect(problemOf(w('PUT', 'DELETE'))).toBe('bad-override')
    expect(problemOf(w('POST', 'GET'))).toBe('bad-override')
    expect(problemOf(w('POST', 'delete'))).toBe('bad-override')
  })

  it('no login, CSRF or session field may be fixed, and values are plain', () => {
    for (const k of ['_token', 'csrf_token', 'password', 'session_id', 'api_key']) {
      expect(problemOf(`domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1, fields: { ${k}: abc } } ]\n`), k).toBe('bad-fields')
    }
    for (const v of ['"a b"', '"a&b=c"', '"x/y"', '""', 'true', '-1']) {
      expect(problemOf(`domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1, fields: { action: ${v} } } ]\n`), v).toBe('bad-fields')
    }
    // A number is kept as its text.
    const r = parseBrowserSkillDeclaration('domain: shop.example.test\nwrites: [ { method: POST, path: /x, max: 1, fields: { type: 8 } } ]\n')
    expect(r.ok && r.declaration.writes[0].fields).toEqual({ type: '8' })
  })

  it('the same write twice is refused (fields in any order)', () => {
    expect(problemOf('domain: shop.example.test\nwrites:\n  - { method: POST, path: /x, max: 1, fields: { a: b, c: d } }\n  - { method: POST, path: /x, max: 2, fields: { c: d, a: b } }\n')).toBe('duplicate-write')
    expect(problemOf('domain: shop.example.test\nwrites:\n  - { method: POST, path: /x, max: 1, fields: { a: b } }\n  - { method: POST, path: /x, max: 2, fields: { a: c } }\n')).toBeNull()
  })

  it('the domain must be one the company registered', () => {
    expect(browserSkillDomainProblem({ domain: 'shop.example.test' }, ['shop.example.test'])).toBeNull()
    expect(browserSkillDomainProblem({ domain: 'shop.example.test' }, ['other.example.test'])).toBe('not-registered')
    expect(browserSkillDomainProblem({ domain: 'shop.example.test' }, [])).toBe('not-registered')
  })

  it('the frames are a frozen copy', () => {
    const r = parseBrowserSkillDeclaration(GOOD)
    if (!r.ok) throw new Error(r.problem)
    const frames = browserSkillFrames(r.declaration)
    expect(frames).toEqual(r.declaration)
    expect(Object.isFrozen(frames.writes[1].fields)).toBe(true)
    expect(() => { (frames.writes as unknown as unknown[]).push({}) }).toThrow()
    expect(() => { (frames.writes[1].fields as Record<string, string>)._method = 'DELETE' }).toThrow()
  })

  it('a write target in plain words', () => {
    const r = parseBrowserSkillDeclaration(GOOD)
    if (!r.ok) throw new Error(r.problem)
    expect(r.declaration.writes.map(browserSkillWriteLine)).toEqual([
      '/api/orders/register に送る（作る・保存する）：1回まで',
      '/api/orders/{n} に一部を変える：2回まで（決まった項目：_method=PATCH、action=copy）',
    ])
  })
})

describe('writes only to what this run made ({made:<id>})', () => {
  const decl = (writes: string) => `domain: shop.example.test\nwrites:\n${writes}`
  const MADE = decl([
    '  - { id: new-plan, method: POST, path: /api/plans, max: 1 }',
    '  - { id: item, method: POST, path: "/api/plans/{made:new-plan}/items", max: 10 }',
    '  - { method: PATCH, path: "/api/items/{made:item}", max: 10 }',
  ].join('\n') + '\n')

  it('an id names a target; a later target\'s {made:<id>} becomes that target\'s place', () => {
    const r = parseBrowserSkillDeclaration(MADE)
    if (!r.ok) throw new Error(r.problem)
    expect(r.declaration.writes.map(w => w.path)).toEqual(['/api/plans', '/api/plans/{made:1}/items', '/api/items/{made:2}'])
    expect(r.declaration.writes.map(w => browserMadeFrom(w.path))).toEqual([null, 1, 2])
    // The id itself is not kept: the frames carry only the place.
    expect(Object.keys(r.declaration.writes[0]).sort()).toEqual(['fields', 'max', 'method', 'path'])
    // Block style too.
    expect(problemOf(decl('  - id: a\n    method: POST\n    path: /x\n    max: 1\n  - method: POST\n    path: "/x/{made:a}"\n    max: 1\n'))).toBeNull()
  })

  it('refuses an undeclared id, a later one, itself, two in one path, and a bad or repeated id', () => {
    const two = (first: string, second: string) => decl(`  - { ${first} }\n  - { ${second} }\n`)
    expect(problemOf(two('id: a, method: POST, path: /x, max: 1', 'method: POST, path: "/x/{made:b}", max: 1'))).toBe('bad-made')
    expect(problemOf(two('method: POST, path: "/x/{made:b}", max: 1', 'id: b, method: POST, path: /y, max: 1'))).toBe('bad-made')
    expect(problemOf(two('id: a, method: POST, path: "/x/{made:a}", max: 1', 'method: POST, path: /y, max: 1'))).toBe('bad-made')
    expect(problemOf(two('id: a, method: POST, path: /x, max: 1', 'method: POST, path: "/x/{made:a}/{made:a}", max: 1'))).toBe('bad-made')
    expect(problemOf(two('id: a, method: POST, path: /x, max: 1', 'id: a, method: POST, path: /y, max: 1'))).toBe('bad-write-id')
    for (const id of ['A', '1a', 'a_b', 'a:b', '"a b"', `a${'b'.repeat(32)}`, '""', '7']) {
      expect(problemOf(two(`id: ${id}, method: POST, path: /x, max: 1`, 'method: POST, path: /y, max: 1')), id).toBe('bad-write-id')
    }
    // The parsed place cannot be written by hand, nor an unknown spelling.
    for (const p of ['/x/{made:1}', '/x/{made:}', '/x/{made:A}', '/x/{made: a}', '/x/{made}', '/x/a{made:a}']) {
      expect(problemOf(two('id: a, method: POST, path: /x, max: 1', `method: POST, path: "${p}", max: 1`)), p).toBe('bad-path')
    }
  })

  it('only in a write: never in after_read or never_read', () => {
    expect(isBrowserSkillPath('/x/{made:a}')).toBe(false)
    expect(isBrowserSkillPath('/x/{made:a}', { made: true })).toBe(true)
    expect(isBrowserSkillPath('/x/{made:a}', { created: true, query: true })).toBe(false)
    const base = '  - { id: a, method: POST, path: /x, max: 1 }\n'
    expect(problemOf(`${decl(base)}after_read: [ "/x/{made:a}" ]\n`)).toBe('bad-after-read')
    expect(problemOf(`${decl(base)}never_read: [ "/x/{made:a}" ]\n`)).toBe('bad-never-read')
  })

  it('says in plain words that the write goes only to what this run made', () => {
    const r = parseBrowserSkillDeclaration(MADE)
    if (!r.ok) throw new Error(r.problem)
    expect(r.declaration.writes.map(browserSkillWriteLine)).toEqual([
      '/api/plans に送る（作る・保存する）：1回まで',
      '/api/plans/{made:1}/items に送る（作る・保存する）：10回まで（この作業の中で、1つ目の書き込み先で作ったものにだけ）',
      '/api/items/{made:2} に一部を変える：10回まで（この作業の中で、2つ目の書き込み先で作ったものにだけ）',
    ])
  })
})
