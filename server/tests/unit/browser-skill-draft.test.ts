/**
 * A draft of a company Skill's `browser.yaml` made from a person's own recordings (shared/core/browser-skill-draft.ts;
 * agent-browser.md "A Skill's draft from a recording").
 *
 * Guards: only writes the site took become targets; a delete, a path that could be any path, a query or an override the
 * declaration cannot say are left out with their reason; a query keeps the recorded names only; `{made}` only where one
 * earlier create of the same recording answered an id (never across recordings, never with two candidates, never beside a
 * broader target); every write of the draft is one the person sent; the marks (changes something that exists, an id in
 * the body, a query of names only); the same recordings give the same text, and the text always parses. A change of a draft
 * is taken only when it is no wider than what the recordings gave.
 *
 * The two Lステップ recordings' shapes are the owner's trial of 2026-11-26/27 (`.claude/skills/lstep-round-inflow`'s notes:
 * the tag create with `?return`, the action's register, the route's create; plus a save of an existing route, which must be
 * marked). Names only — a recording holds no value.
 */
import { describe, expect, it } from 'vitest'
import { browserQueryKeptExactly, browserRecordingProblem, type BrowserRecordedSend, type BrowserRecordingContent, type BrowserRecordingStep } from '../../../shared/core/browser-recording'
import { parseBrowserSkillDeclaration, type BrowserSkillDeclaration } from '../../../shared/core/browser-skill'
import { browserFrameMismatch } from '../../../shared/core/browser-frame-match'
import {
  BROWSER_SKILL_DRAFT_WORDS, browserSkillDraftCoveredProblem, browserSkillDraftFrom, type BrowserSkillDraft,
} from '../../../shared/core/browser-skill-draft'

const LSTEP = 'manager.linestep.net'

const recording = (domain: string, steps: BrowserRecordingStep[]): BrowserRecordingContent => {
  const r: BrowserRecordingContent = { format: 2, domain, steps, hosts: [] }
  // Every fixture is a recording the server would have stored.
  expect(browserRecordingProblem(r, domain)).toBeNull()
  return r
}
const send = (id: number, method: string, address: string, extra: Partial<BrowserRecordedSend> = {}): BrowserRecordedSend => ({
  id, kind: 'send', method, override: null, address, fields: [], status: 200, answerKeys: null, after: null, count: 1, bareQuery: false, ...extra,
})

/** Making the round's tag: the tag page, 「新しいタグ」, the name typed, 「作成」 → `POST /api/tags?return` (204). */
const TAG_RECORDING = recording(LSTEP, [
  { id: 1, kind: 'page', address: '/line/tag' },
  send(2, 'GET', '/api/tag-groups', { answerKeys: ['[]', '[].id', '[].name'] }),
  { id: 3, kind: 'click', target: 'button', label: '新しいタグ', address: null },
  { id: 4, kind: 'input', label: 'タグ名', name: 'name', value: '値1', from: null },
  { id: 5, kind: 'click', target: 'button', label: '作成', address: null },
  send(6, 'POST', '/api/tags?return', { fields: [{ name: 'name', value: '値1', from: null }, { name: 'group_id', value: '値2', from: { step: 2, key: '[].id' } }], status: 204, after: 5, bareQuery: true }),
  send(7, 'GET', '/api/tags?group&page', { answerKeys: ['data', 'data[].id', 'data[].name'], count: 2 }),
])

/**
 * Copying a route: the list, 「コピーを作成」 (`/line/landing/edit?group&copy`), the source read, 「この条件で決定する」 →
 * `POST /api/action/register` (200, answer `aid`), 「登録」 → `POST /api/landings` (201, no body) — and, in the same
 * trial, a save of an existing route's edit page (`POST /api/landings/{n}`), the write the hand-made Skill must not hold.
 */
const COPY_RECORDING = recording(LSTEP, [
  { id: 1, kind: 'page', address: '/line/landing' },
  send(2, 'GET', '/api/landings?group&page', { answerKeys: ['data', 'data[].id', 'data[].name'] }),
  { id: 3, kind: 'page', address: '/line/landing/edit?group&copy' },
  send(4, 'GET', '/api/landings/{n}', { answerKeys: ['id', 'name', 'group_id', 'action_id'] }),
  send(5, 'GET', '/api/actions/{n}', { answerKeys: ['aid', 'a_name', 'inputs', 'inputs[].type'] }),
  { id: 6, kind: 'click', target: 'button', label: 'この条件で決定する', address: null },
  send(7, 'POST', '/api/action/register', {
    fields: [
      { name: 'aid', value: '値1', from: null },
      { name: 'inputs[{n}][type]', value: '値2', from: null },
      { name: 'inputs[{n}][tag_ids][]', value: '値3', from: null },
    ],
    answerKeys: ['aid'], after: 6,
  }),
  { id: 8, kind: 'click', target: 'button', label: '登録', address: null },
  send(9, 'POST', '/api/landings', {
    fields: [
      { name: 'name', value: '値4', from: null },
      { name: 'action_id', value: '値5', from: { step: 7, key: 'aid' } },
      { name: 'group_id', value: '値6', from: { step: 4, key: 'group_id' } },
    ],
    status: 201, after: 8,
  }),
  { id: 10, kind: 'page', address: '/line/landing/edit/{n}' },
  { id: 11, kind: 'click', target: 'button', label: '保存', address: null },
  send(12, 'POST', '/api/landings/{n}', { fields: [{ name: 'name', value: '値7', from: null }], after: 11 }),
])

const draftOf = (recordings: BrowserRecordingContent[]): BrowserSkillDraft => {
  const r = browserSkillDraftFrom(recordings)
  if (!r.ok) throw new Error(`no draft: ${r.refusal}`)
  return r.draft
}
const parsed = (text: string): BrowserSkillDeclaration => {
  const r = parseBrowserSkillDeclaration(text)
  if (!r.ok) throw new Error(`does not parse: ${r.problem}`)
  return r.declaration
}

/** The hand-made Skill built from the same two recordings (`lstep-round-inflow/browser.yaml`). */
const HAND_MADE = `domain: manager.linestep.net
writes:
  - { method: POST, path: /api/tags, query: "return", max: 1 }
  - method: POST
    path: /api/action/register
    max: 1
    fields: { aid: "0" }
  - { method: POST, path: /api/landings, max: 1 }
safe_pattern: none
`

describe('a draft from the two Lステップ recordings', () => {
  const draft = draftOf([TAG_RECORDING, COPY_RECORDING])

  it('holds exactly the writes the site took, in the order they were made, with the recorded query names', () => {
    expect(draft.text).toBe(`domain: manager.linestep.net
writes:
  - { method: POST, path: "/api/tags", query: "return", max: 1, body: ["group_id", "name"] }
  - { method: POST, path: "/api/action/register", max: 1 }
  - { method: POST, path: "/api/landings", max: 1, body: ["action_id", "group_id", "name"] }
  - { method: POST, path: "/api/landings/{n}", max: 1, body: ["name"] }
safe_pattern: none
`)
    expect(draft.leftOut).toEqual([])
  })

  it('marks the save of an existing route and the id field typed into the action', () => {
    expect(draft.writes.map(w => w.marks)).toEqual([[], ['id-in-body'], [], ['updates-existing']])
    // `aid` was typed (no earlier answer gave it); the route's `action_id` and `group_id` came from earlier answers.
    expect(draft.writes.map(w => w.idFields)).toEqual([[], ['aid'], [], []])
    expect(draft.writes[3].seen).toEqual([{ recording: 1, step: 12 }])
  })

  it('the hand-made Skill is a change within it: the action fixed to a new one, the save of an existing route taken out', () => {
    expect(browserSkillDraftCoveredProblem(parsed(HAND_MADE), draft.declaration)).toBeNull()
  })

  it('its frames take the very writes of the trial and refuse the same path with another query', () => {
    const [tags] = draft.declaration.writes
    expect(browserFrameMismatch(tags, { method: 'POST', path: '/api/tags?return', fields: {} })).toBeNull()
    expect(browserFrameMismatch(tags, { method: 'POST', path: '/api/tags', fields: {} })).toBe('query')
    expect(browserFrameMismatch(tags, { method: 'POST', path: '/api/tags?return=1', fields: {} })).toBe('query')
  })

  it('the same recordings always give the same text', () => {
    expect(draftOf([TAG_RECORDING, COPY_RECORDING]).text).toBe(draft.text)
  })
})

const SHOP = 'shop.example.test'

describe('what is left out, and why', () => {
  it('a write the site did not take or did not answer, a delete, a path that could be any path, an unsayable query or override', () => {
    const r = recording(SHOP, [
      send(1, 'POST', '/api/orders', { status: 201 }),
      send(2, 'POST', '/api/orders', { status: 422 }),
      send(3, 'POST', '/api/orders', { status: 500 }),
      send(4, 'POST', '/api/orders', { status: null }),
      send(5, 'DELETE', '/api/orders/{n}'),
      send(6, 'POST', '/api/orders/{n}', { override: 'DELETE' }),
      send(7, 'POST', '/{n}/orders'),
      send(8, 'PUT', '/{x}'),
      send(9, 'POST', '/'),
      send(10, 'POST', '/api/orders?{x}', { bareQuery: true }),
      send(11, 'POST', '/api/orders?_method', { bareQuery: true }),
      send(12, 'POST', '/api/orders?token', { bareQuery: true }),
      send(13, 'PUT', '/api/orders/{n}', { override: 'PATCH' }),
      send(14, 'OTHER', '/api/orders'),
      send(15, 'POST', '/api/orders?preview'),
      send(16, 'POST', '/api/orders', { status: 302 }), // an expired session sent to the login page: nothing done
    ])
    const d = draftOf([r])
    // Step 15's query was sent with a value (`bareQuery` false): its name with a value placeholder ("A query value not fixed").
    expect(d.declaration.writes.map(w => [w.path, w.query])).toEqual([['/api/orders', null], ['/api/orders', 'preview={x}']])
    expect(d.leftOut.map(l => [l.step, l.reason])).toEqual([
      [2, 'not-taken'], [3, 'not-taken'], [4, 'no-answer'], [5, 'deletes'], [6, 'deletes'], [7, 'wide-path'], [8, 'wide-path'],
      [9, 'wide-path'], [10, 'query'], [11, 'query'], [12, 'query'], [13, 'override'], [14, 'override'], [16, 'not-taken'],
    ])
    for (const l of d.leftOut) expect(BROWSER_SKILL_DRAFT_WORDS.leftOut[l.reason]).toBeTruthy()
  })

  it('a query is named only when the recording vouches it was sent exactly so: never from a value dropped, never from format 1', () => {
    // `?preview=false` is kept as `?preview`: naming it would permit a request the person never sent (Codex review).
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?preview=false`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?preview=`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?a&a`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?%72eturn`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?Return`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://other.example.test/api/a?return`, SHOP)).toBe(false)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?return`, SHOP)).toBe(true)
    expect(browserQueryKeptExactly(`https://${SHOP}/api/a?return&full#top`, SHOP)).toBe(true)
    const old = { format: 1, domain: SHOP, hosts: [], steps: [{ id: 1, kind: 'send', method: 'POST', override: null, address: '/api/tags?return', fields: [], status: 204, answerKeys: null, after: null, count: 1 }] } as BrowserRecordingContent
    expect(browserRecordingProblem(old, SHOP)).toBeNull()
    expect(draftOf([old, recording(SHOP, [send(1, 'POST', '/api/tags')])]).leftOut).toEqual([{ recording: 0, step: 1, reason: 'query-values' }])
  })

  it('the server takes a format-2 recording only with `bareQuery` on every send, true only beside a query; format 1 as before', () => {
    const steps = (extra: Record<string, unknown>) => [{ id: 1, kind: 'send', method: 'POST', override: null, address: '/api/a', fields: [], status: 200, answerKeys: null, after: null, count: 1, ...extra }]
    expect(browserRecordingProblem({ format: 2, domain: SHOP, hosts: [], steps: steps({}) }, SHOP)).toBe('send')
    expect(browserRecordingProblem({ format: 2, domain: SHOP, hosts: [], steps: steps({ bareQuery: 'yes' }) }, SHOP)).toBe('send')
    expect(browserRecordingProblem({ format: 2, domain: SHOP, hosts: [], steps: steps({ bareQuery: true }) }, SHOP)).toBe('send')
    expect(browserRecordingProblem({ format: 2, domain: SHOP, hosts: [], steps: steps({ bareQuery: false }) }, SHOP)).toBeNull()
    expect(browserRecordingProblem({ format: 2, domain: SHOP, hosts: [], steps: steps({ address: '/api/a?return', bareQuery: true }) }, SHOP)).toBeNull()
    expect(browserRecordingProblem({ format: 1, domain: SHOP, hosts: [], steps: steps({ bareQuery: false }) }, SHOP)).toBe('send')
    expect(browserRecordingProblem({ format: 1, domain: SHOP, hosts: [], steps: steps({}) }, SHOP)).toBeNull()
    expect(browserRecordingProblem({ format: 3, domain: SHOP, hosts: [], steps: steps({ bareQuery: false }) }, SHOP)).toBe('format')
    // A malformed address beside `bareQuery: true` is refused, never a thrown error (an internal error to the sender).
    for (const address of [null, 7, ['/a?b'], { includes: 1 }]) {
      expect(browserRecordingProblem({ format: 2, domain: SHOP, hosts: [], steps: steps({ address, bareQuery: true }) }, SHOP)).toBe('send')
    }
  })

  it('a query sent with values (`bareQuery` false: the incident of 2026-11-27) is named with `{x}` per name, marked, and fits any one value', () => {
    // Lステップ's ［作成］ sent `POST /api/tags?return=<a value>`; the recording keeps `?return` and says it was not bare.
    const d = draftOf([recording(LSTEP, [
      send(1, 'POST', '/api/tags?return', { status: 204, bareQuery: false }),
      send(2, 'POST', '/api/labels?kind&return', { bareQuery: false }),
      send(3, 'POST', '/api/notes?return', { bareQuery: true }),
    ])])
    expect(d.declaration.writes.map(w => [w.path, w.query])).toEqual([['/api/tags', 'return={x}'], ['/api/labels', 'kind={x}&return={x}'], ['/api/notes', 'return']])
    expect(d.text).toContain('query: "return={x}"')
    expect(d.writes.map(w => w.marks.includes('query-value-open'))).toEqual([true, true, false])
    expect(BROWSER_SKILL_DRAFT_WORDS.marks['query-value-open']).toContain('（何かの値）')
    expect(d.leftOut).toEqual([])
    // The frame fits the real request whatever the value, and never a bare name or an empty value.
    const tags = d.declaration.writes[0]
    expect(browserFrameMismatch(tags, { method: 'POST', path: '/api/tags?return=1', fields: {} })).toBeNull()
    expect(browserFrameMismatch(tags, { method: 'POST', path: '/api/tags?return', fields: {} })).toBe('query')
    expect(browserFrameMismatch(tags, { method: 'POST', path: '/api/tags?return=', fields: {} })).toBe('query')
    // A masked name is never named, values or not; a name that says delete is still marked.
    const masked = draftOf([recording(SHOP, [send(1, 'POST', '/api/a?{x}', { bareQuery: false }), send(2, 'POST', '/api/b?purge', { bareQuery: false })])])
    expect(masked.leftOut).toEqual([{ recording: 0, step: 1, reason: 'query' }])
    expect(masked.writes[0].marks).toEqual(['may-delete', 'query-value-open'])
    // A name that says id with its value left open may point at any existing thing: marked as changing what exists.
    const ids = draftOf([recording(SHOP, [send(1, 'POST', '/api/notes?item_id', { bareQuery: false }), send(2, 'POST', '/api/notes?paid', { bareQuery: true })])])
    expect(ids.writes.map(w => w.marks)).toEqual([['updates-existing', 'query-value-open'], []])
  })

  it('a write whose address says delete or remove is marked: only the method DELETE is left out', () => {
    const d = draftOf([recording(SHOP, [send(1, 'POST', '/api/items/bulk-delete'), send(2, 'POST', '/api/remove_item'), send(3, 'POST', '/api/deleted-items'), send(4, 'POST', '/api/items?trash', { bareQuery: true })])])
    expect(d.writes.map(w => w.marks.includes('may-delete'))).toEqual([true, true, false, true])
    for (const w of d.writes) for (const m of w.marks) expect(BROWSER_SKILL_DRAFT_WORDS.marks[m]).toBeTruthy()
  })

  it('reads and the pages are never targets', () => {
    expect(browserSkillDraftFrom([recording(SHOP, [{ id: 1, kind: 'page', address: '/a' }, send(2, 'GET', '/api/a', { count: 3 }), send(3, 'HEAD', '/api/a'), send(4, 'OPTIONS', '/api/a')])]))
      .toEqual({ ok: false, refusal: 'no-writes' })
  })

  it('no draft from nothing, another domain mixed in, more than five recordings, more than 16 targets, or a recording the server would refuse', () => {
    const one = recording(SHOP, [send(1, 'POST', '/api/a')])
    expect(browserSkillDraftFrom([])).toEqual({ ok: false, refusal: 'not-a-recording' })
    expect(browserSkillDraftFrom([one, recording('other.example.test', [send(1, 'POST', '/api/a')])])).toEqual({ ok: false, refusal: 'domains' })
    expect(browserSkillDraftFrom([one, one, one, one, one, one])).toEqual({ ok: false, refusal: 'too-many-recordings' })
    expect(browserSkillDraftFrom([one, one, one, one, one]).ok).toBe(true)
    const many = 'abcdefghijklmnopq'.split('').map((c, i) => send(i + 1, 'POST', `/api/${c}`))
    expect(browserSkillDraftFrom([recording(SHOP, many)])).toEqual({ ok: false, refusal: 'too-many-writes' })
    expect(browserSkillDraftFrom([recording(SHOP, many.slice(0, 16))]).ok).toBe(true)
    // A value in a label (digits) is not a kept recording: refused before anything is read from it.
    const bad = { format: 1, domain: SHOP, hosts: [], steps: [{ id: 1, kind: 'click', target: 'button', label: '注文 12345', address: null }, send(2, 'POST', '/api/a')] }
    expect(browserSkillDraftFrom([bad as BrowserRecordingContent])).toEqual({ ok: false, refusal: 'not-a-recording' })
  })
})

describe('the targets', () => {
  it('max is what one run did: the most a write was sent in one recording (never the sum over recordings), at most 20', () => {
    const items = Array.from({ length: 25 }, (_, i) => send(i + 1, 'POST', '/api/items'))
    expect(draftOf([recording(SHOP, items.slice(0, 3)), recording(SHOP, items.slice(0, 2))]).declaration.writes[0].max).toBe(3)
    expect(draftOf([recording(SHOP, items.slice(0, 1)), recording(SHOP, items.slice(0, 1)), recording(SHOP, items.slice(0, 1))]).declaration.writes[0].max).toBe(1)
    expect(draftOf([recording(SHOP, items)]).declaration.writes[0].max).toBe(20)
  })

  it('a method override the declaration can say becomes its fixed `_method`, and changes something that exists', () => {
    const d = draftOf([recording(SHOP, [send(1, 'POST', '/api/orders/{n}', { override: 'PATCH' })])])
    expect(d.declaration.writes[0].fields).toEqual({ _method: 'PATCH' })
    expect(d.writes[0].marks).toEqual(['updates-existing'])
  })

  it('a PUT or PATCH without a placeholder still changes something that exists; a plain create does not', () => {
    const d = draftOf([recording(SHOP, [send(1, 'PUT', '/api/settings'), send(2, 'PATCH', '/api/profile'), send(3, 'POST', '/api/orders')])])
    expect(d.writes.map(w => w.marks)).toEqual([['updates-existing'], ['updates-existing'], []])
  })

  it('`id-in-body` only for a create, only for a field not taken from an earlier answer, and never an empty one', () => {
    const d = draftOf([recording(SHOP, [
      send(1, 'GET', '/api/groups', { answerKeys: ['[].id'] }),
      send(2, 'POST', '/api/orders', { fields: [
        { name: 'customer_id', value: '値1', from: null },
        { name: 'group_id', value: '値2', from: { step: 1, key: '[].id' } },
        { name: 'parent_id', value: 'empty', from: null },
        { name: 'items[{n}][id]', value: '値3', from: null },
        { name: 'ids', value: '値4', from: null },
      ] }),
      send(3, 'PATCH', '/api/orders/{n}', { fields: [{ name: 'customer_id', value: '値1', from: null }] }),
    ])])
    expect(d.writes.map(w => w.idFields)).toEqual([['customer_id', 'items[{n}][id]'], []])
  })
})

describe('`{made}`: what this run made', () => {
  it('a path with one placeholder after exactly one create of the same recording that answered an id', () => {
    const d = draftOf([recording(SHOP, [
      send(1, 'POST', '/api/plans', { status: 201, answerKeys: ['id', 'name'] }),
      send(2, 'POST', '/api/plans/{n}/items'),
      send(3, 'POST', '/api/plans/{n}/items'),
      send(4, 'PATCH', '/api/plans/{n}'),
    ])])
    expect(d.text).toContain('{ id: w1, method: POST, path: "/api/plans", max: 1 }')
    expect(d.text).toContain('{ method: POST, path: "/api/plans/{made:w1}/items", max: 2 }')
    expect(d.text).toContain('{ method: PATCH, path: "/api/plans/{made:w1}", max: 1 }')
    // Changing what this run made is not changing something that existed.
    expect(d.writes.map(w => w.marks)).toEqual([[], [], []])
    // The frame then fits only what this run made.
    const items = d.declaration.writes[1]
    expect(browserFrameMismatch(items, { method: 'POST', path: '/api/plans/77/items', fields: {} })).toBe('made')
    expect(browserFrameMismatch(items, { method: 'POST', path: '/api/plans/77/items', fields: {} }, new Map([[1, new Set(['77'])]]))).toBeNull()
  })

  it('`data.id` answers count too', () => {
    const d = draftOf([recording(SHOP, [send(1, 'POST', '/api/plans', { answerKeys: ['data', 'data.id'] }), send(2, 'POST', '/api/plans/{x}/items')])])
    expect(d.declaration.writes[1].path).toBe('/api/plans/{made:1}/items')
  })

  it('never a guess: no create answering an id, two of them, one in another recording, a later one, two placeholders', () => {
    const paths = (rs: BrowserRecordingContent[]) => draftOf(rs).declaration.writes.map(w => w.path)
    expect(paths([recording(SHOP, [send(1, 'POST', '/api/plans', { answerKeys: ['name'] }), send(2, 'POST', '/api/plans/{n}/items')])]))
      .toEqual(['/api/plans', '/api/plans/{n}/items'])
    expect(paths([recording(SHOP, [send(1, 'POST', '/api/plans', { answerKeys: ['id'] }), send(2, 'POST', '/api/lists', { answerKeys: ['id'] }), send(3, 'POST', '/api/plans/{n}/items')])]))
      .toEqual(['/api/plans', '/api/lists', '/api/plans/{n}/items'])
    expect(paths([recording(SHOP, [send(1, 'POST', '/api/plans', { answerKeys: ['id'] })]), recording(SHOP, [send(1, 'POST', '/api/plans/{n}/items')])]))
      .toEqual(['/api/plans', '/api/plans/{n}/items'])
    expect(paths([recording(SHOP, [send(1, 'POST', '/api/plans/{n}/items'), send(2, 'POST', '/api/plans', { answerKeys: ['id'] })])]))
      .toEqual(['/api/plans/{n}/items', '/api/plans'])
    expect(paths([recording(SHOP, [send(1, 'POST', '/api/plans', { answerKeys: ['id'] }), send(2, 'POST', '/api/plans/{n}/items/{n}')])]))
      .toEqual(['/api/plans', '/api/plans/{n}/items/{n}'])
    // A create made later is never the maker, and does not cost the earlier write's own link.
    expect(paths([recording(SHOP, [send(1, 'POST', '/api/lists/{n}/x'), send(2, 'POST', '/api/plans', { answerKeys: ['id'] }), send(3, 'POST', '/api/plans/{n}/items')])]))
      .toEqual(['/api/lists/{n}/x', '/api/plans', '/api/plans/{made:2}/items'])
    // A maker that changes something (an override) or is not a create is never one.
    expect(paths([recording(SHOP, [send(1, 'POST', '/api/plans', { override: 'PATCH', answerKeys: ['id'] }), send(2, 'POST', '/api/plans/{n}/items')])]))
      .toEqual(['/api/plans', '/api/plans/{n}/items'])
  })

  it('beside a broader target of the same method, the placeholders stay (a `{made}` frame there would mean nothing)', () => {
    // The same path with a query, sent in another recording (so not linked), covers the `{made}` one: no link at all.
    const d = draftOf([
      recording(SHOP, [send(1, 'POST', '/api/plans', { answerKeys: ['id'] }), send(2, 'POST', '/api/plans/{n}/items')]),
      recording(SHOP, [send(1, 'POST', '/api/plans/{n}/items?full', { bareQuery: true })]),
    ])
    expect(d.declaration.writes.map(w => w.path)).toEqual(['/api/plans', '/api/plans/{n}/items', '/api/plans/{n}/items'])
    expect(d.writes[1].marks).toEqual(['updates-existing'])
  })

  it('a `{x}` that does not become `{made}` leaves its write out: it would fit any segment (a masked or hidden word)', () => {
    const d = draftOf([recording(SHOP, [
      send(1, 'POST', '/api/{x}/tags'), // `/api/v2/tags`: `v2` is masked
      send(2, 'POST', '/ajax/{x}'), // `/ajax/save.php`
      send(3, 'POST', '/api/plans', { answerKeys: ['id'] }),
      send(4, 'POST', '/api/plans/{x}/items'), // a token id this run made: kept as `{made}`
    ])])
    expect(d.declaration.writes.map(w => w.path)).toEqual(['/api/plans', '/api/plans/{made:1}/items'])
    expect(d.leftOut).toEqual([{ recording: 0, step: 1, reason: 'any-segment' }, { recording: 0, step: 2, reason: 'any-segment' }])
    expect(browserSkillDraftFrom([recording(SHOP, [send(1, 'POST', '/api/{x}')])])).toEqual({ ok: false, refusal: 'no-writes' })
  })
})

describe('every draft is the person\'s own writes and always parses (generated recordings)', () => {
  // A small deterministic generator: methods, overrides, statuses, addresses and answers drawn from fixed pools.
  let seed = 7
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const METHODS = ['POST', 'POST', 'POST', 'PUT', 'PATCH', 'DELETE', 'GET']
  const OVERRIDES = [null, null, null, 'PUT', 'PATCH', 'DELETE']
  const STATUSES = [200, 201, 204, 302, 400, 409, 500, null]
  const ADDRESSES = ['/api/a', '/api/a/{n}', '/api/a/{n}/b', '/api/a/{x}', '/api/b?return', '/api/b?x&y', '/{n}', '/api/c/{n}/d/{n}', '/api/a/', '/api/d?{x}']
  const ANSWERS = [null, ['id'], ['data', 'data.id'], ['name']]

  it('300 generated recordings: the text parses, is within itself, never deletes, and each write is one the person sent', () => {
    let drafted = 0
    for (let round = 0; round < 300; round++) {
      const steps: BrowserRecordingStep[] = Array.from({ length: 1 + next(12) }, (_, i) => {
        const address = ADDRESSES[next(ADDRESSES.length)]
        return send(i + 1, METHODS[next(METHODS.length)], address, {
          override: OVERRIDES[next(OVERRIDES.length)] as BrowserRecordedSend['override'],
          status: STATUSES[next(STATUSES.length)],
          answerKeys: ANSWERS[next(ANSWERS.length)],
          bareQuery: address.includes('?') && next(2) === 0,
        })
      })
      const r: BrowserRecordingContent = { format: 2, domain: SHOP, steps, hosts: [] }
      const result = browserSkillDraftFrom([r])
      if (!result.ok) {
        expect(['no-writes'], `round ${round}: ${browserRecordingProblem(r, SHOP)}`).toContain(result.refusal)
        continue
      }
      const { draft } = result
      drafted++
      expect(parseBrowserSkillDeclaration(draft.text).ok, `round ${round}`).toBe(true)
      expect(browserSkillDraftCoveredProblem(draft.declaration, draft.declaration), `round ${round}`).toBeNull()
      for (const w of draft.declaration.writes) {
        expect(w.method === 'DELETE' || w.fields._method === 'DELETE', `round ${round}`).toBe(false)
        // A write of the draft is one the person sent and the site took: the same method, override, query and path (but `{made}`).
        const sent = steps.filter((s): s is BrowserRecordedSend => s.kind === 'send' && s.status !== null && s.status >= 200 && s.status < 300)
        const sameAddress = (s: BrowserRecordedSend) => {
          const address = s.address
          const [path, query = null] = address.split('?')
          const got = path.split('/')
          const want = w.path.split('/')
          // Sent exactly as kept: the names as they are; sent with values: each name with `{x}`, never a value.
          const named = query === null ? null : s.bareQuery ? query : query.split('&').map(k => `${k}={x}`).join('&')
          return named === w.query && got.length === want.length
            && want.every((seg, i) => seg === got[i] || (/^\{made:[0-9]+\}$/.test(seg) && (got[i] === '{n}' || got[i] === '{x}')))
        }
        // …and a query only from a send whose query the recording vouched for.
        expect(sent.some(s => s.method === w.method && (s.override ?? undefined) === w.fields._method && sameAddress(s)
          && (w.query === null || typeof s.bareQuery === 'boolean')), `round ${round}: ${w.path}`).toBe(true)
      }
    }
    expect(drafted).toBeGreaterThan(150)
  })
})

describe('a change of a draft is taken only when it is no wider', () => {
  const BASE = parsed(`domain: shop.example.test
writes:
  - { id: w1, method: POST, path: "/api/plans", max: 1 }
  - { method: POST, path: "/api/plans/{made:w1}/items", max: 2 }
  - { method: POST, path: "/api/orders/{n}", query: "return", max: 1, fields: { _method: PATCH } }
  - { method: PUT, path: "/api/notes/{x}", max: 1 }
safe_pattern: none
`)
  const change = (writes: string, domain = SHOP) => browserSkillDraftCoveredProblem(parsed(`domain: ${domain}\nwrites:\n${writes}\nsafe_pattern: none\n`), BASE)

  it('dropping, reordering, more uses (up to 20), a fixed field added, a placeholder narrowed, reads and a marker added', () => {
    expect(change('  - { method: POST, path: "/api/plans", max: 20, fields: { kind: "0" } }')).toBeNull()
    expect(change('  - { method: PUT, path: "/api/notes/today", max: 1 }\n  - { method: POST, path: "/api/orders/12", query: "return", max: 3, fields: { _method: PATCH, mode: copy } }')).toBeNull()
    expect(change('  - { id: a, method: POST, path: "/api/plans", max: 1 }\n  - { method: POST, path: "/api/orders/{made:a}", query: "return", max: 1, fields: { _method: PATCH } }')).toBeNull()
    expect(browserSkillDraftCoveredProblem(parsed(`domain: shop.example.test
writes:
  - { method: POST, path: "/api/plans", max: 1 }
never_read: [ "/api/export" ]
after_read: [ "/api/plans" ]
account_marker: { meta: shop-account-id }
`), BASE)).toBeNull()
  })

  it('refused: a write not recorded, another method, query, override or fewer fixed fields, a wider or other segment', () => {
    expect(change('  - { method: POST, path: "/api/refunds", max: 1 }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: PATCH, path: "/api/plans", max: 1 }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/plans", query: "return", max: 1 }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/orders/{n}", max: 1, fields: { _method: PATCH } }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/orders/{n}", query: "return", max: 1, fields: { _method: PUT } }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/orders/{n}", query: "return", max: 1 }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/orders/{x}", query: "return", max: 1, fields: { _method: PATCH } }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/orders/abc", query: "return", max: 1, fields: { _method: PATCH } }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/plans/{n}/items", max: 1 }')).toEqual({ problem: 'not-covered', write: 1 })
    expect(change('  - { method: POST, path: "/api/plans/", max: 1 }')).toEqual({ problem: 'not-covered', write: 1 })
  })

  it('a `{made}` stays tied to a create: never re-pointed at a write that updates an existing thing (independent review)', () => {
    const base = parsed(`domain: shop.example.test
writes:
  - { id: w1, method: POST, path: "/api/routes", max: 1 }
  - { method: POST, path: "/api/routes/{made:w1}/save", max: 1 }
  - { method: POST, path: "/api/routes/{n}", max: 1 }
  - { method: POST, path: "/api/notes/{n}", max: 1 }
`)
    const within = (writes: string) => browserSkillDraftCoveredProblem(parsed(`domain: shop.example.test\nwrites:\n${writes}\n`), base)
    // The reviewer's example: the save pointed at what an update of an existing route answered.
    expect(within('  - { id: u, method: POST, path: "/api/routes/{n}", max: 1 }\n  - { method: POST, path: "/api/routes/{made:u}/save", max: 1 }'))
      .toEqual({ problem: 'not-covered', write: 2 })
    // The same maker kept (also renamed) is fine.
    expect(within('  - { id: a, method: POST, path: "/api/routes", max: 1 }\n  - { method: POST, path: "/api/routes/{made:a}/save", max: 1 }')).toBeNull()
    // `{n}` → `{made}` only when the maker is within a plain create of the base.
    expect(within('  - { id: a, method: POST, path: "/api/routes", max: 1 }\n  - { method: POST, path: "/api/notes/{made:a}", max: 1 }')).toBeNull()
    expect(within('  - { id: a, method: POST, path: "/api/routes/{n}", max: 1 }\n  - { method: POST, path: "/api/notes/{made:a}", max: 1 }'))
      .toEqual({ problem: 'not-covered', write: 2 })
  })

  it('a fixed field of the base is kept: dropping or changing it is wider', () => {
    const base = parsed('domain: shop.example.test\nwrites:\n  - { method: POST, path: "/api/plans", max: 1, fields: { kind: "0" } }\n')
    const draft = (fields: string) => parsed(`domain: shop.example.test\nwrites:\n  - { method: POST, path: "/api/plans", max: 1${fields} }\n`)
    expect(browserSkillDraftCoveredProblem(draft(', fields: { kind: "0", mode: copy }'), base)).toBeNull()
    expect(browserSkillDraftCoveredProblem(draft(''), base)).toEqual({ problem: 'not-covered', write: 1 })
    expect(browserSkillDraftCoveredProblem(draft(', fields: { kind: "1" }'), base)).toEqual({ problem: 'not-covered', write: 1 })
  })

  it('one recorded target split into many narrower ones keeps one budget of 20 (Codex review)', () => {
    expect(change('  - { method: PUT, path: "/api/notes/a", max: 10 }\n  - { method: PUT, path: "/api/notes/b", max: 10 }')).toBeNull()
    expect(change('  - { method: PUT, path: "/api/notes/a", max: 10 }\n  - { method: PUT, path: "/api/notes/b", max: 10 }\n  - { method: PUT, path: "/api/notes/c", max: 1 }'))
      .toEqual({ problem: 'too-many-uses', write: 3 })
    expect(change('  - { method: POST, path: "/api/orders/1", query: "return", max: 20, fields: { _method: PATCH } }\n  - { method: POST, path: "/api/orders/{n}", query: "return", max: 1, fields: { _method: PATCH } }'))
      .toEqual({ problem: 'too-many-uses', write: 2 })
  })

  it('refused: another domain, a delete, a path that could be any path', () => {
    expect(change('  - { method: POST, path: "/api/plans", max: 1 }', 'other.example.test')).toEqual({ problem: 'domain', write: null })
    expect(change('  - { method: POST, path: "/api/plans", max: 1 }\n  - { method: DELETE, path: "/api/notes/{x}", max: 1 }')).toEqual({ problem: 'deletes', write: 2 })
    expect(change('  - { method: POST, path: "/api/orders/{n}", query: "return", max: 1, fields: { _method: DELETE } }')).toEqual({ problem: 'deletes', write: 1 })
    const wideBase = parsed('domain: shop.example.test\nwrites:\n  - { method: PUT, path: "/{x}/{x}", max: 1 }\n')
    expect(browserSkillDraftCoveredProblem(parsed('domain: shop.example.test\nwrites:\n  - { method: PUT, path: "/{x}/a", max: 1 }\n'), wideBase)).toEqual({ problem: 'wide-path', write: 1 })
  })
})

describe('the draft\'s `body` (agent-browser.md "The run\'s promise": the fields a recorded write carried)', () => {
  it('lists the names every send carried (never `_method` or a login / CSRF / session field); a body not read or a name the promise cannot name leaves it out', () => {
    const writes = draftOf([TAG_RECORDING, COPY_RECORDING]).declaration.writes
    // Each drafted body parses back as the declaration's `body` (the parser's own rules: plain names, none sensitive).
    for (const w of writes) for (const n of w.body ?? []) expect(n === '_method' || /token|csrf|session|password/i.test(n)).toBe(false)
    expect(writes.map(w => w.body ?? null)).toEqual([['group_id', 'name'], null, ['action_id', 'group_id', 'name'], ['name']])
  })
})
