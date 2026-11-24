/**
 * The read-side words of the browser generalization (PR 2; `.claude/rules/agent-browser.md` "The read-side words",
 * `shared/core/browser-map.ts`, `shared/core/browser-read-line.ts`). Pure; nothing calls them yet.
 *
 * Guards (each test fails when its guard is removed):
 * - strict read: an unknown key at any depth, a key spelled to look like a nested path, a missing required key, a
 *   reader that gives anything but exactly the map's fields → not read, no plan; the owner's notice never names a key;
 * - unreadable is never ✓: a check whose material is not read whole, is another object, or is a parent's list not
 *   read whole / not this parent's, is `unreadable` and makes no plan;
 * - where a value comes from: which / when only from a bound record field or a person's confirmation; never the AI
 *   alone or the site; a field the AI wrote last needs the person; a target only from the site;
 * - the line's validator refuses unknown things, fields, words, arguments of the wrong kind, after-words in a line
 *   without writes, unused values;
 * - the new core modules name no site, thing or field (§17-2).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  BROWSER_SHAPE_WORDS, browserMapProblem, readBrowserThing, type BrowserMap, type BrowserThingResult,
} from '../../../shared/core/browser-map'
import {
  browserLineValuesProblem, browserReadLineProblem, dateInText, evaluateBrowserReadLine, siblingNameKey, sourceUnchanged,
  type BrowserReadFacts, type BrowserReadLine, type BrowserSuppliedValue,
} from '../../../shared/core/browser-read-line'
import { canonicalJson } from '../../../shared/core/fixed-content'
import { parsePluginManifest } from '../../../shared/core/plugins'
import { EXAMPLE_CHECK_LINE, EXAMPLE_MAP, landingAnswer, readLanding, readNamed } from '../fixtures/browser/example-map'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
// A map or line taken apart on purpose: the tests break it in ways its type forbids.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any
const readLandingAnswer = (answer: unknown): BrowserThingResult => readBrowserThing(EXAMPLE_MAP, 'landing', answer, readLanding)

describe('the map', () => {
  it('the example map is a map', () => {
    expect(browserMapProblem(EXAMPLE_MAP)).toBeNull()
  })

  const broken: [string, (m: Loose) => void][] = [
    ['an unknown key', m => { m.extra = 1 }],
    ['a bad version', m => { m.version = '1.0' }],
    ['an unknown field kind', m => { m.things.tag.fields.name.kind = 'html' }],
    ['an id field not of kind id', m => { m.things.tag.id = 'name' }],
    ['a nullable id field', m => { m.things.tag.fields.id.nullable = true }],
    ['a parent thing not in the map', m => { m.things.landing.parent.thing = 'nowhere' }],
    ['a parent field not an id', m => { m.things.landing.parent.field = 'name' }],
    ['a key path not of the shape', m => { m.things.tag.keys['a..b'] = 'required' }],
    ['a key path ending in a list marker (the walker names a list by its key)', m => { m.things.tag.keys['name[]'] = 'ignored' }],
    ['a key whose container is not listed', m => { m.things.tag.keys['meta.size'] = 'ignored' }],
    ['an unknown key use', m => { m.things.tag.keys.name = 'maybe' }],
    ['only ignored keys', m => { m.things.tag.keys = { id: 'ignored', name: 'ignored' } }],
    ['an html thing', m => { m.things.tag.answer = 'html' }],
  ]
  for (const [what, change] of broken) {
    it(`refuses ${what}`, () => {
      const m = clone(EXAMPLE_MAP)
      change(m)
      expect(browserMapProblem(m)).not.toBeNull()
    })
  }
})

describe('strict read', () => {
  it('reads a whole answer into exactly the map\'s fields', () => {
    const r = readLandingAnswer(landingAnswer())
    expect(r.status).toBe('read')
    if (r.status === 'read') expect(Object.keys(r.state).sort()).toEqual(Object.keys(EXAMPLE_MAP.things.landing.fields).sort())
  })

  it('an optional key may be absent and an ignored key present or absent', () => {
    const a = landingAnswer({ updated_at: '2026-11-24 10:00' })
    delete a.custom_params
    delete a.qr_text
    expect(readLandingAnswer(a).status).toBe('read')
  })

  it('an unknown key at the top → not read; the notice names the thing and counts, never the key', () => {
    const r = readLandingAnswer(landingAnswer({ customer_12345: 'x', other_new: 1 }))
    expect(r.status).toBe('not_read')
    if (r.status !== 'not_read') return
    expect(r.notices).toEqual([{ site: 'example_site', mapVersion: '1.0.0', thing: 'landing', change: 'unknown_keys', count: 2 }])
    expect(canonicalJson(r.notices)).not.toContain('customer_12345')
    expect(r.diagnosis.unknownKeys).toContain('customer_12345')
  })

  it('an unknown key inside a list\'s items → not read', () => {
    const a = landingAnswer({ custom_params: [{ var_id: '11', name: 'a', secret_flag: true }] })
    const r = readLandingAnswer(a)
    expect(r.status === 'not_read' && r.notices[0].change).toBe('unknown_keys')
  })

  it('a key spelled like a nested path is unknown and never named', () => {
    // `custom_params[].var_id` is a known path; a top-level key spelled so must not pass for it.
    const r = readLandingAnswer(landingAnswer({ 'custom_params[].var_id': '1', 'a.b': 2 }))
    expect(r.status).toBe('not_read')
    if (r.status !== 'not_read') return
    expect(r.notices[0]).toMatchObject({ change: 'unknown_keys', count: 2 })
    expect(r.diagnosis.unknownKeys).toEqual([])
  })

  it('a missing required key → not read (missing_keys), at the top and in a list item', () => {
    const a = landingAnswer()
    delete a.action_id
    const r = readLandingAnswer(a)
    expect(r.status === 'not_read' && r.notices).toEqual([{ site: 'example_site', mapVersion: '1.0.0', thing: 'landing', change: 'missing_keys', count: 1 }])
    const b = readLandingAnswer(landingAnswer({ custom_params: [{ name: 'no var id' }] }))
    expect(b.status === 'not_read' && b.notices[0].change).toBe('missing_keys')
  })

  it('a container of the wrong shape → not read (its required keys would never be asked)', () => {
    for (const custom_params of ['x', [[{ var_id: '1' }]], [null], { var_id: '1' }]) {
      const r = readLandingAnswer(landingAnswer({ custom_params }))
      expect(r.status === 'not_read' && r.notices.map(n => n.change)).toContain('missing_keys')
    }
    // An optional container may be null; a required one may not.
    expect(readBrowserThing(EXAMPLE_MAP, 'landing', landingAnswer({ custom_params: null }), a => readLanding({ ...(a as object), custom_params: [] })).status).toBe('read')
    const m = clone(EXAMPLE_MAP) as Loose
    m.things.landing.keys.custom_params = 'required'
    const r = readBrowserThing(m, 'landing', landingAnswer({ custom_params: null }), a => readLanding({ ...(a as object), custom_params: [] }))
    expect(r.status === 'not_read' && r.notices[0].change).toBe('missing_keys')
  })

  it('a reader that throws or hands back anything but exactly the fields → not read', () => {
    const readers: ((a: unknown) => unknown)[] = [
      () => { throw new Error('x') },
      a => ({ ...(readLanding(a) as object), extra: 1 }),
      a => { const s = readLanding(a) as Record<string, unknown>; delete s.name; return s },
      a => ({ ...(readLanding(a) as object), to_date: '2026-02-30' }),
      a => ({ ...(readLanding(a) as object), prevent_default: 'no' }),
      () => null,
    ]
    for (const reader of readers) {
      const r = readBrowserThing(EXAMPLE_MAP, 'landing', landingAnswer(), reader)
      expect(r.status === 'not_read' && r.notices[0].change).toBe('unreadable')
    }
  })

  it('an answer that is not an object, or too deep, is not read', () => {
    expect(readLandingAnswer([landingAnswer()]).status).toBe('not_read')
    let deep: unknown = { var_id: '1' }
    for (let i = 0; i < 12; i++) deep = [deep]
    expect(readLandingAnswer(landingAnswer({ custom_params: deep })).status).toBe('not_read')
    let deepList: unknown = 1
    for (let i = 0; i < 12; i++) deepList = [deepList]
    expect(readLandingAnswer(landingAnswer({ custom_params: deepList })).status).toBe('not_read')
  })

  it('a thing the map does not have is not read and tells nothing', () => {
    const r = readBrowserThing(EXAMPLE_MAP, 'customer_12345', landingAnswer(), readLanding)
    expect(r).toEqual({ status: 'not_read', notices: [], diagnosis: { unknownKeys: [], missingKeys: [] } })
  })

  it('the member\'s sentence holds no key, JSON or version word', () => {
    expect(BROWSER_SHAPE_WORDS.member).toBe('サイトの形が変わったので確認中です。今回は手でお願いします。')
    expect(BROWSER_SHAPE_WORDS.member).not.toMatch(/[A-Za-z]/)
  })
})

// --- the line ---

const person = (value: string, confirmed = true): BrowserSuppliedValue => ({ value, from: { kind: 'person', confirmed } })
const site = (value: string): BrowserSuppliedValue => ({ value, from: { kind: 'site_fact' } })

function goodFacts(): BrowserReadFacts {
  const landing = readLandingAnswer(landingAnswer())
  const reference = readLandingAnswer(landingAnswer({ id: '400', name: '参加者_20261126 の入口', to_date: '2026-11-26', action_id: '6001' }))
  const folder = readBrowserThing(EXAMPLE_MAP, 'landing_folder', { id: '9', name: 'フォルダ' }, readNamed)
  const tag = readBrowserThing(EXAMPLE_MAP, 'tag', { id: '33', name: '参加者_20261203' }, readNamed)
  const sibling = (id: string, name: string) => ({ ...(landing.status === 'read' ? landing.state : {}), id, name })
  return {
    reads: { landing, reference, folder, add_tag: tag },
    siblings: { landing: { status: 'read', items: [sibling('501', '参加者_20261203 の入口'), sibling('400', '参加者_20261126 の入口')] } },
    values: { landing: site('501'), reference: site('400'), add_tag: site('33'), round_date: person('2026-12-03') },
  }
}

describe('the line\'s validator', () => {
  it('the example check line is a line', () => {
    expect(browserReadLineProblem(EXAMPLE_CHECK_LINE, EXAMPLE_MAP)).toBeNull()
  })

  const broken: [string, (l: Loose) => void][] = [
    ['another site', l => { l.site = 'other' }],
    ['an unknown key', l => { l.show = [] }],
    ['a thing the map does not have', l => { l.reads[3].thing = 'coupon' }],
    ['an id from a later read', l => { l.reads[2].id = { read: 'add_tag', field: 'id' } }],
    ['an id from a field that is not an id', l => { l.reads[2].id = { read: 'landing', field: 'name' } }],
    ['a read of the same object again (an id from a read\'s own id field)', l => {
      l.reads[1].id = { read: 'landing', field: 'id' }
      delete l.values.reference
    }],
    ['an id from a value that is not a target', l => {
      l.values.picked = { kind: 'id', role: 'which', from: ['person'] }
      l.reads[3].id = { value: 'picked' }
      delete l.values.add_tag
    }],
    ['a text date compared against an id value', l => { l.checks[1].date = 'landing' }],
    ['a word the core does not have', l => { l.checks[0].word = 'looks_right' }],
    ['an extra argument', l => { l.checks[1].when = 'always' }],
    ['a field the map does not have', l => { l.checks[1].field = 'title' }],
    ['a date word on a field of another kind', l => { l.checks[3].field = 'name' }],
    ['a text word on a date field', l => { l.checks[1].field = 'to_date' }],
    ['a date format not in the list', l => { l.checks[1].format = 'D.M.YYYY' }],
    ['unchanged_except against another kind of thing', l => { l.checks[0].reference = 'add_tag' }],
    ['unchanged_except against itself', l => { l.checks[0].reference = 'landing' }],
    ['unchanged_except leaving out the id', l => { l.checks[0].except = ['id'] }],
    ['no_sibling_named on a thing without a parent', l => { l.checks[4].read = 'add_tag' }],
    ['an after-word in a line that writes nothing', l => { l.checks.push({ word: 'source_unchanged', read: 'reference' }) }],
    ['a which value the AI alone may give', l => { l.values.round_date.from = ['ai'] }],
    ['a which value read from the site', l => { l.values.round_date.from = ['record_field', 'site_fact'] }],
    ['a target the AI may give', l => { l.values.landing.from = ['ai'] }],
    ['a date compared against a target value', l => { l.values.round_date = { kind: 'date', role: 'target', from: ['site_fact'] } }],
    ['a value nothing uses', l => { l.values.spare = { kind: 'text', role: 'write', from: ['ai'] } }],
    ['no read', l => { l.reads = []; l.checks = [] }],
  ]
  for (const [what, change] of broken) {
    it(`refuses ${what}`, () => {
      const l = clone(EXAMPLE_CHECK_LINE)
      change(l)
      expect(browserReadLineProblem(l, EXAMPLE_MAP)).not.toBeNull()
    })
  }
})

describe('where a value comes from', () => {
  const values = (round: BrowserSuppliedValue, extra: Record<string, unknown> = {}) =>
    ({ landing: site('501'), reference: site('400'), add_tag: site('33'), round_date: round, ...extra })

  it('which / when from a bound record field or a confirmed person passes', () => {
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values(person('2026-12-03')))).toBeNull()
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values({ value: '2026-12-03', from: { kind: 'record_field', aiWroteLast: false } }))).toBeNull()
  })

  it('which / when from the AI alone or from the site is refused, whatever the line says', () => {
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values({ value: '2026-12-03', from: { kind: 'ai' } }))).toEqual({ problem: 'source', value: 'round_date' })
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values(site('2026-12-03')))).toEqual({ problem: 'source', value: 'round_date' })
    // A line that (wrongly) lists the AI is still refused at the values: the role's rule is asked too.
    const loose = clone(EXAMPLE_CHECK_LINE) as Loose
    loose.values.round_date.from = ['ai', 'person']
    expect(browserLineValuesProblem(loose, values({ value: '2026-12-03', from: { kind: 'ai' } }))).toEqual({ problem: 'source', value: 'round_date' })
  })

  it('a record field the AI wrote last, or a person not yet confirmed, waits for the person', () => {
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values({ value: '2026-12-03', from: { kind: 'record_field', aiWroteLast: true } })))
      .toEqual({ problem: 'unconfirmed', value: 'round_date' })
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values(person('2026-12-03', false)))).toEqual({ problem: 'unconfirmed', value: 'round_date' })
  })

  it('a target the AI names is refused; values missing, extra or of another shape are refused', () => {
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, { ...values(person('2026-12-03')), landing: { value: '501', from: { kind: 'ai' } } }))
      .toEqual({ problem: 'source', value: 'landing' })
    const missing: Record<string, unknown> = values(person('2026-12-03'))
    delete missing.add_tag
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, missing)?.problem).toBe('missing')
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values(person('2026-12-03'), { spare: site('1') }))?.problem).toBe('extra')
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values(person('2026-02-30')))?.problem).toBe('shape')
    expect(browserLineValuesProblem(EXAMPLE_CHECK_LINE, values({ value: '2026-12-03', from: { kind: 'person', confirmed: true, by: 'x' } } as Loose))?.problem).toBe('source')
  })
})

describe('judging a line', () => {
  it('everything read whole and every check ✓ → a plan may be made', () => {
    const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, goodFacts())
    expect(out.checks.map(c => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(out.problem).toBeNull()
  })

  it('a read not read whole makes no plan, even one no check uses', () => {
    const f = goodFacts()
    const notRead = readLandingAnswer(landingAnswer({ brand_new: 1 }))
    const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, reads: { ...f.reads, landing: notRead } })
    expect(out.problem).toBe('not-read')
    expect(out.checks.every(c => c.status !== 'ok' || c.word === 'date_in_text')).toBe(true)
    // The folder is read only to be the landing's: no check names it, and still its failure stops the plan.
    const g = goodFacts()
    const folderNotRead = readBrowserThing(EXAMPLE_MAP, 'landing_folder', { id: '9', name: 'x', extra: 1 }, readNamed)
    expect(evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...g, reads: { ...g.reads, folder: folderNotRead } }).problem).toBe('not-read')
  })

  it('a read that is another object than asked is unreadable, never ✓', () => {
    const f = goodFacts()
    const other = readLandingAnswer(landingAnswer({ id: '777' }))
    const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, reads: { ...f.reads, landing: other } })
    expect(out.problem).toBe('wrong-object')
    expect(out.checks.filter(c => c.status === 'ok').map(c => c.word)).toEqual(['date_in_text'])
    // The folder read by the landing's field: another folder than the landing's is the wrong object.
    const g = goodFacts()
    const otherFolder = readBrowserThing(EXAMPLE_MAP, 'landing_folder', { id: '8', name: 'x' }, readNamed)
    expect(evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...g, reads: { ...g.reads, folder: otherFolder } }).problem).toBe('wrong-object')
  })

  it('unreadable never becomes ✓: every word with its material unread is unreadable', () => {
    const notRead: BrowserThingResult = { status: 'not_read', notices: [], diagnosis: { unknownKeys: [], missingKeys: [] } }
    for (const name of ['landing', 'reference', 'add_tag']) {
      const f = goodFacts()
      const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, reads: { ...f.reads, [name]: notRead } })
      const touching = EXAMPLE_CHECK_LINE.checks.map((c, i) => [c, out.checks[i]] as const)
        .filter(([c]) => c.read === name || ('reference' in c && c.reference === name))
      expect(touching.length).toBeGreaterThan(0)
      for (const [, r] of touching) expect(r.status).toBe('unreadable')
      expect(out.problem).not.toBeNull()
    }
    // A state slipped in without passing the map is not trusted either.
    const f = goodFacts()
    const forged: BrowserThingResult = { status: 'read', state: { id: '501', name: '参加者_20261203' } }
    expect(evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, reads: { ...f.reads, landing: forged } }).problem).toBe('not-read')
  })

  it('a value problem makes no plan and the date words cannot be ✓ without a good date', () => {
    const f = goodFacts()
    const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, values: { ...f.values, round_date: { value: '2026-12-03', from: { kind: 'ai' } } } })
    expect(out.problem).toBe('values')
    expect(out.checks.filter(c => c.word === 'date_in_text' || c.word === 'datetime_on_date').every(c => c.status === 'unreadable')).toBe(true)
  })

  it('a value is read once: what was checked is what the checks use (review L3)', () => {
    const f = goodFacts()
    let reads = 0
    const shifty = { from: { kind: 'person', confirmed: true }, get value() { return reads++ === 0 ? '2026-12-03' : '2026-11-26' } }
    const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, values: { ...f.values, round_date: shifty as Loose } })
    expect(out.problem).toBeNull()
    expect(reads).toBe(1)
  })

  it('unchanged_except: ✗ with the fields that differ; an id set in another order is the same', () => {
    const f = goodFacts()
    const changed = readLandingAnswer(landingAnswer({ id: '400', name: 'x', prevent_default: true, custom_params: [{ var_id: '12', name: 'b' }, { var_id: '11', name: 'a' }] }))
    const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, reads: { ...f.reads, reference: changed } })
    expect(out.checks[0]).toEqual({ word: 'unchanged_except', status: 'ng', differs: ['prevent_default'] })
    expect(out.problem).toBe('check-ng')
  })

  it('the previous round\'s tag: date_in_text ✗', () => {
    const f = goodFacts()
    const oldTag = readBrowserThing(EXAMPLE_MAP, 'tag', { id: '33', name: '参加者_20261126' }, readNamed)
    const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, reads: { ...f.reads, add_tag: oldTag } })
    expect(out.checks[2].status).toBe('ng')
    expect(out.problem).toBe('check-ng')
  })

  it('datetime_on_date: another day or none is ✗', () => {
    for (const to_date of ['2026-12-04', null]) {
      const f = goodFacts()
      const l = readLandingAnswer(landingAnswer({ to_date }))
      const out = evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, reads: { ...f.reads, landing: l } })
      expect(out.checks[3].status).toBe('ng')
    }
  })

  it('no_sibling_named: a twin ✗; a list not read whole, without the thing, or of another parent is unreadable', () => {
    const f = goodFacts()
    const items = (f.siblings!.landing as { items: Record<string, unknown>[] }).items
    const judge = (siblings: BrowserReadFacts['siblings']) => evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...f, siblings }).checks[4].status
    expect(judge({ landing: { status: 'read', items: [...items, { ...items[1], id: '402', name: '参加者_20261203 の入口' }] } })).toBe('ng')
    // Names that differ only by spaces, width or ASCII case are the same name (owner decision 2026-11-24).
    for (const twin of ['参加者_20261203 の入口 ', ' 参加者_20261203  の入口', '参加者＿２０２６１２０３\u3000の入口']) {
      expect(judge({ landing: { status: 'read', items: [...items, { ...items[1], id: '402', name: twin }] } }), twin).toBe('ng')
    }
    const upper = (x: string) => x.replace('参加者', 'Entry')
    const g = goodFacts()
    const named = readLandingAnswer(landingAnswer({ name: 'Entry_20261203 の入口' }))
    const siblings = { landing: { status: 'read' as const, items: [{ ...items[0], name: upper('参加者_20261203 の入口') }, { ...items[1], id: '402', name: 'ENTRY_20261203 の入口' }] } }
    expect(evaluateBrowserReadLine(EXAMPLE_CHECK_LINE, EXAMPLE_MAP, { ...g, reads: { ...g.reads, landing: named }, siblings }).checks[4].status).toBe('ng')
    // Another name stays another name.
    expect(judge({ landing: { status: 'read', items: [...items, { ...items[1], id: '402', name: '参加者_20261210 の入口' }] } })).toBe('ok')
    expect(judge({ landing: { status: 'not_read' } })).toBe('unreadable')
    expect(judge(undefined)).toBe('unreadable')
    expect(judge({ landing: { status: 'read', items: [items[1]] } })).toBe('unreadable')
    expect(judge({ landing: { status: 'read', items: [items[0], { ...items[1], group_id: '8' }] } })).toBe('unreadable')
    expect(judge({ landing: { status: 'read', items: [items[0], { ...items[1], surprise: 1 }] } })).toBe('unreadable')
    expect(judge({ landing: { status: 'read', items: [items[0], items[0]] } })).toBe('unreadable')
  })

  it('source_unchanged cannot stand in a line that writes nothing', () => {
    const line: BrowserReadLine = { ...EXAMPLE_CHECK_LINE, checks: [{ word: 'source_unchanged', read: 'reference' }] }
    expect(evaluateBrowserReadLine(line, EXAMPLE_MAP, goodFacts()).problem).toBe('line')
  })

  it('source_unchanged: ✓ only when the read before and after are the same; anything unread is unreadable', () => {
    const thing = EXAMPLE_MAP.things.landing
    const f = goodFacts()
    expect(sourceUnchanged(thing, f.reads.reference, f.reads.reference)).toEqual({ word: 'source_unchanged', status: 'ok' })
    const moved = readLandingAnswer(landingAnswer({ id: '400', name: 'changed', to_date: '2026-11-26', action_id: '6001' }))
    expect(sourceUnchanged(thing, f.reads.reference, moved)).toEqual({ word: 'source_unchanged', status: 'ng', differs: ['name'] })
    const notRead: BrowserThingResult = { status: 'not_read', notices: [], diagnosis: { unknownKeys: [], missingKeys: [] } }
    expect(sourceUnchanged(thing, notRead, f.reads.reference).status).toBe('unreadable')
    expect(sourceUnchanged(thing, f.reads.reference, notRead).status).toBe('unreadable')
    expect(sourceUnchanged(thing, f.reads.reference, undefined).status).toBe('unreadable')
  })
})

describe('the sibling name key', () => {
  it('folds spaces, width and ASCII case, nothing else', () => {
    expect(siblingNameKey('  Abc\u3000 ＤＥＦ１２  ')).toBe('abc def12')
    expect(siblingNameKey('参加者_1')).not.toBe(siblingNameKey('参加者_2'))
    expect(siblingNameKey('ｶﾅ')).toBe('ｶﾅ') // half-width kana is not folded (full-width ASCII and the space only)
  })
})

describe('dates in a text', () => {
  const cases: [string, string, 'YYYYMMDD' | 'YYYY-MM-DD' | 'M/D', boolean][] = [
    ['参加者_20261203', '2026-12-03', 'YYYYMMDD', true],
    ['参加者_20261126', '2026-12-03', 'YYYYMMDD', false],
    ['参加者_202612031', '2026-12-03', 'YYYYMMDD', false],
    ['参加者_20261203_20261126', '2026-12-03', 'YYYYMMDD', false],
    ['参加者_20261203 電話 12345678', '2026-12-03', 'YYYYMMDD', true],
    ['参加者_２０２６１２０３', '2026-12-03', 'YYYYMMDD', false],
    ['12/3回 説明会', '2026-12-03', 'M/D', true],
    ['12/31回', '2026-12-03', 'M/D', false],
    ['2026/12/3回', '2026-12-03', 'M/D', false],
    ['12/03回', '2026-12-03', 'M/D', false],
    ['112/3回', '2026-12-03', 'M/D', false],
    ['12/3/1回', '2026-12-03', 'M/D', false],
    ['12/3回と12/10回', '2026-12-03', 'M/D', false],
    ['開催 2026-12-03', '2026-12-03', 'YYYY-MM-DD', true],
    ['開催 2026-12-03-2', '2026-12-03', 'YYYY-MM-DD', false],
    ['名前だけ', '2026-12-03', 'YYYYMMDD', false],
    // Another day in another spelling, also full-width (review M2).
    ['20261203（変更: 2026/12/04）', '2026-12-03', 'YYYYMMDD', false],
    ['2026/12/4 開催 12/3', '2026-12-03', 'M/D', false],
    ['12/3 または １２/４', '2026-12-03', 'M/D', false],
    ['2026-12-03 と 12月4日', '2026-12-03', 'YYYY-MM-DD', false],
    ['2026-12-03 と 2025年12月3日', '2026-12-03', 'YYYY-MM-DD', false],
    ['参加者_20261203（12月3日 18:20）', '2026-12-03', 'YYYYMMDD', true],
    ['12/3回 2026.12.03 開催', '2026-12-03', 'M/D', true],
  ]
  for (const [text, date, format, want] of cases) {
    it(`${text} / ${format} → ${want ? '✓' : '✗'}`, () => expect(dateInText(text, date, format)).toBe(want))
  }
})

describe('the new core modules name no site, thing or field (§17-2)', () => {
  const NEW_PATH = ['shared/core/browser-map.ts', 'shared/core/browser-read-line.ts']
  const root = resolve(__dirname, '../../..')
  // Names a site's data gives: every approved connector's id, hosts, operation, checker, reader and read names, and the
  // example map's things and fields. The old path (`plugin-browser-declaration.ts`, `browser-plans.ts`) is a named
  // exception (memo §16-7 R8): it predates the map and is left as it is.
  function siteNames(): string[] {
    const approved = JSON.parse(readFileSync(resolve(root, 'shared/browser-connectors/approved.json'), 'utf8')) as { combinations: { connector: string; declaration: string }[] }
    const names = new Set<string>()
    for (const c of approved.combinations) {
      names.add(c.connector)
      const parsed = parsePluginManifest(c.declaration)
      if (!parsed.ok || !parsed.value.browser) continue
      names.add(parsed.value.label)
      const b = parsed.value.browser
      for (const h of [b.host, ...b.assetHosts, ...b.loginHelpers.map(l => l.host)]) names.add(h)
      for (const [op, o] of Object.entries(b.operations)) {
        names.add(op); names.add(o.label); names.add(o.checker); if (o.lock) names.add(o.lock.kind)
      }
      for (const [read, r] of Object.entries(b.explore)) { names.add(read); names.add(r.reader); names.add(r.label) }
    }
    const map: BrowserMap = EXAMPLE_MAP
    names.add(map.site)
    for (const [thing, t] of Object.entries(map.things)) {
      names.add(thing)
      names.add(t.label)
      for (const f of Object.keys(t.fields)) if (f.includes('_')) names.add(f)
      // Each part of a key path too (`custom_params[].var_id` → `custom_params`, `var_id`).
      for (const k of Object.keys(t.keys)) for (const part of k.replace(/\[\]/g, '').split('.')) if (part.includes('_')) names.add(part)
    }
    return [...names]
  }

  it('collects the names to look for', () => {
    const names = siteNames()
    expect(names).toContain('lstep')
    expect(names).toContain('landing')
    expect(names).toContain('流入経路')
    expect(names).toContain('var_id')
    expect(names.length).toBeGreaterThan(15)
  })

  for (const file of NEW_PATH) {
    it(`${file} holds none of them`, () => {
      const source = readFileSync(resolve(root, file), 'utf8')
      const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // An ASCII name as a whole word; a Japanese label anywhere.
      const found = siteNames().filter(n => (/^[\x20-\x7e]+$/.test(n)
        ? new RegExp(`(?<![A-Za-z0-9_.-])${escape(n)}(?![A-Za-z0-9_-])`)
        : new RegExp(escape(n))).test(source))
      expect(found).toEqual([])
    })
  }
})
