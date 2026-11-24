/**
 * The write words of opened lines (generalization PR 6; agent-browser.md "The write words and the first write line"):
 * `shared/core/browser-write-line.ts`, the map's `writes` / `delivers` / html things (`browser-map.ts`) and the opened
 * line's optional `writes` (`browser-opened.ts`). On a made-up example map (not a site's), so the words are tried on
 * their own; the Lステップ line is `client/tests/browser-step-template-line.test.ts`.
 *
 * Guards (each test fails when its guard is removed):
 * - a map lets a line write only what it lists, on a list kept in any order, with who it reaches and the account (and
 *   parent) held; an html thing has no keys and its id from the address;
 * - a line's writes: only what the map lets, **only one write on what existed before** (the harmless prefix, §4-1),
 *   named by the plan's values (the lock), adding only what the line reads under the account;
 * - an html thing's read: the address's id, the parent main asked for, the reader's state exactly the map's fields —
 *   anything else not read;
 * - the prediction adds exactly once and nothing else; the judgement says "as predicted" only for exactly that;
 * - an inspection's meaning hash does not move when a map gains writes; a line's writes and a written thing's reach do.
 */
import { describe, expect, it } from 'vitest'
import { browserMapProblem, readBrowserThing, type BrowserMap } from '../../../shared/core/browser-map'
import type { BrowserReadFacts } from '../../../shared/core/browser-read-line'
import { browserLineMeaning, browserOpenedLineProblem, type BrowserOpenedLine } from '../../../shared/core/browser-opened'
import { judgeBrowserWrites, predictBrowserWrites } from '../../../shared/core/browser-write-line'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const MAP: BrowserMap = {
  site: 'example_site',
  version: '1.0.0',
  account: { label: 'アカウント' },
  things: {
    shelf: {
      label: '棚', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' },
      must_hold: { account: true },
    },
    box: {
      label: '箱', answer: 'html', id: 'id', id_from: 'address',
      parent: { thing: 'shelf', field: 'shelf' },
      fields: { id: { kind: 'id', label: '番号' }, shelf: { kind: 'id', label: '棚' }, items: { kind: 'id_set', label: '中身' }, order: { kind: 'id_list', label: '並び' } },
      writes: { add_child: { items: 'item' } },
      delivers: 'scheduled',
      must_hold: { account: true, parent: true, note: '見本の注意書き' },
    },
    item: {
      label: '品', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' },
      must_hold: { account: true },
    },
    loose_item: {
      label: '品（アカウントなし）', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' },
    },
  },
}

const LINE: BrowserOpenedLine = {
  name: 'box_add',
  version: '1.0.0',
  label: '箱に足す',
  read: {
    site: 'example_site',
    values: {
      shelf: { kind: 'id', role: 'target', from: ['site_fact'] },
      box: { kind: 'id', role: 'target', from: ['site_fact'] },
      item: { kind: 'id', role: 'target', from: ['site_fact'] },
    },
    reads: [
      { name: 'shelf', thing: 'shelf', id: { value: 'shelf' } },
      { name: 'box', thing: 'box', id: { value: 'box' }, parent: { value: 'shelf' } },
      { name: 'item', thing: 'item', id: { value: 'item' } },
    ],
    checks: [],
  },
  writes: [{ read: 'box', verb: 'add_child', field: 'items', value: 'item' }],
  readLabels: { shelf: '棚', box: '箱', item: '足す品' },
  show: [{ read: 'box', fields: ['items'] }],
}

/** The example's html reader: `items=a,b;order=a,b` (site code would parse a page; this one only fails closed). */
const readBox = (page: unknown, ids?: { id: string; parent: string | null }): unknown => {
  if (typeof page !== 'string' || !ids?.parent) throw new Error('page')
  const m = /^items=([0-9,]*);order=([0-9,]*)$/.exec(page)
  if (!m) throw new Error('shape')
  const list = (s: string) => (s ? s.split(',') : [])
  return { shelf: ids.parent, items: list(m[1]), order: list(m[2]) }
}
const readNamed = (a: unknown): unknown => ({ id: (a as { id: unknown }).id, name: (a as { name: unknown }).name })

describe('the map\'s write facts and html things', () => {
  it('the example map is a map', () => expect(browserMapProblem(MAP)).toBeNull())
  const broken: [string, (m: Loose) => void][] = [
    ['writes on an ordered list (where it lands is not predictable)', m => { m.things.box.writes.add_child = { order: 'item' } }],
    ['writes on a field it does not have', m => { m.things.box.writes.add_child = { nowhere: 'item' } }],
    ['a child thing not in the map', m => { m.things.box.writes.add_child = { items: 'nowhere' } }],
    ['a child thing not bound to the account', m => { m.things.box.writes.add_child = { items: 'loose_item' } }],
    ['a child thing with must-hold facts but not the account', m => { m.things.loose_item.must_hold = { note: '見本' }; m.things.box.writes.add_child = { items: 'loose_item' } }],
    ['the old list form', m => { m.things.box.writes.add_child = ['items'] }],
    ['writes on a list that may be null', m => { m.things.box.fields.items.nullable = true }],
    ['an unknown verb', m => { m.things.box.writes = { remove_child: { items: 'item' } } }],
    ['no verb at all', m => { m.things.box.writes = {} }],
    ['writes without who it reaches', m => { delete m.things.box.delivers }],
    ['a reach the path never opens', m => { m.things.box.delivers = 'immediate' }],
    ['a reach without writes', m => { m.things.shelf.delivers = 'none' }],
    ['writes without the account held', m => { m.things.box.must_hold.account = false }],
    ['writes on a thing with a parent, the parent not held', m => { delete m.things.box.must_hold.parent }],
    ['an html thing with keys', m => { m.things.box.keys = { id: 'required' } }],
    ['an html thing whose id is not the address\'s', m => { delete m.things.box.id_from }],
    ['a json thing without keys', m => { delete m.things.shelf.keys }],
    ['another way of reading', m => { m.things.shelf.answer = 'xml' }],
  ]
  for (const [what, change] of broken) {
    it(`refuses ${what}`, () => {
      const m = clone(MAP)
      change(m)
      expect(browserMapProblem(m)).not.toBeNull()
    })
  }
})

describe('an html thing\'s read', () => {
  const read = (page: unknown, id?: string, parent?: string, reader = readBox) => readBrowserThing(MAP, 'box', page, reader, id, parent)
  it('reads the page with the ids main asked for; the id is the address\'s', () => {
    const r = read('items=1,2;order=1,2', '50', '9')
    expect(r).toEqual({ status: 'read', state: { id: '50', shelf: '9', items: ['1', '2'], order: ['1', '2'] } })
  })
  const refused: [string, () => ReturnType<typeof read>][] = [
    ['no id asked', () => read('items=1;order=1', undefined, '9')],
    ['an id not plain', () => read('items=1;order=1', '5/0', '9')],
    ['no parent asked for a thing with one', () => read('items=1;order=1', '50', undefined)],
    ['not a page', () => read({ items: [] }, '50', '9')],
    ['a page too long', () => read('x'.repeat(5_000_001), '50', '9', (() => ({ shelf: '9', items: [], order: [] })) as Loose)],
    ['no parent asked, a reader that makes one up', () => read('items=;order=', '50', undefined, (() => ({ shelf: '9', items: [], order: [] })) as Loose)],
    ['a reader that throws', () => read('nonsense', '50', '9')],
    ['a reader that gives its own id', () => read('items=;order=', '50', '9', ((p: unknown, i?: Loose) => ({ ...(readBox(p, i) as object), id: '51' })) as Loose)],
    ['a reader whose parent is not the one asked', () => read('items=;order=', '50', '9', ((p: unknown, i?: Loose) => ({ ...(readBox(p, i) as object), shelf: '8' })) as Loose)],
    ['a reader with a field more', () => read('items=;order=', '50', '9', ((p: unknown, i?: Loose) => ({ ...(readBox(p, i) as object), extra: 1 })) as Loose)],
  ]
  for (const [what, r] of refused) {
    it(`not read: ${what} (no key name told)`, () => {
      const got = r()
      expect(got.status).toBe('not_read')
      if (got.status === 'not_read') expect(got.notices.every(n => n.change === 'unreadable')).toBe(true)
    })
  }
})

describe('a line\'s writes', () => {
  it('the example line opens', () => expect(browserOpenedLineProblem(LINE, MAP)).toBeNull())
  const broken: [string, (l: Loose) => void][] = [
    ['a field the map does not let it write', l => { l.writes[0].field = 'order' }],
    ['a thing the map lets it write nothing of', l => { l.writes[0].read = 'item' }],
    ['a read the line does not make', l => { l.writes[0].read = 'nowhere' }],
    ['an unknown verb', l => { l.writes[0].verb = 'remove_child' }],
    ['a write of another shape', l => { l.writes[0].extra = 1 }],
    ['no write in the list', l => { l.writes = [] }],
    ['a second write on what existed before (the harmless prefix, §4-1)', l => { l.writes = [l.writes[0], l.writes[0]] }],
    ['a written object named by an earlier read, not by the plan', l => {
      l.read.values.box = undefined; delete l.read.values.box
      l.read.reads[1].id = { read: 'shelf', field: 'id' }
    }],
    ['a written object whose parent is not named by the plan', l => {
      l.read.values.other = { kind: 'id', role: 'target', from: ['site_fact'] }
      l.read.reads.unshift({ name: 'other', thing: 'shelf', id: { value: 'other' } })
      l.read.reads[2].parent = { read: 'other', field: 'id' }
    }],
    ['adding a value the line does not read', l => {
      l.read.values.extra = { kind: 'id', role: 'target', from: ['site_fact'] }
      l.read.reads.push({ name: 'shelf2', thing: 'shelf', id: { value: 'extra' } })
      l.read.reads = l.read.reads.filter((r: Loose) => r.name !== 'item'); delete l.read.values.item; delete l.readLabels.item
      l.readLabels.shelf2 = '棚2'
      l.writes[0].value = 'nowhere'
    }],
    ['adding what is read outside the account', l => { l.read.reads[2].thing = 'loose_item' }],
    ['adding another kind of thing than the map says goes in', l => { l.writes[0].value = 'shelf' }],
    ['an extra key on the line', l => { l.extra = 1 }],
  ]
  for (const [what, change] of broken) {
    it(`refuses ${what}`, () => {
      const l = clone(LINE)
      change(l)
      expect(browserOpenedLineProblem(l, MAP)).not.toBeNull()
    })
  }
})

describe('the meaning', () => {
  const inspection: BrowserOpenedLine = { ...clone(LINE), name: 'box_look' }
  delete (inspection as Loose).writes
  it('an inspection\'s meaning does not move when the map gains or loses writes on what it reads (its grants stay)', () => {
    const withoutWrites = clone(MAP) as Loose
    delete withoutWrites.things.box.writes; delete withoutWrites.things.box.delivers
    withoutWrites.things.box.must_hold = { account: true, parent: true, note: '見本の注意書き' }
    expect(browserMapProblem(withoutWrites)).toBeNull()
    // What a thing lets a line write is part of the meaning of a line that writes it, not of one that only reads it.
    expect(browserLineMeaning(inspection, withoutWrites)).toBe(browserLineMeaning(inspection, MAP))
  })
  it('a line\'s writes and a written thing\'s reach move the meaning', () => {
    const base = browserLineMeaning(LINE, MAP)
    expect(browserLineMeaning(inspection, MAP)).not.toBe(base)
    const m = clone(MAP) as Loose
    m.things.box.delivers = 'none'
    expect(browserLineMeaning(LINE, m)).not.toBe(base)
  })
})

describe('the prediction and the judgement', () => {
  const site = (value: string) => ({ value, from: { kind: 'site_fact' as const } })
  const facts = (page: string, item = 'pen', account = { before: '1', after: '1' }): BrowserReadFacts => ({
    reads: {
      shelf: readBrowserThing(MAP, 'shelf', { id: '9', name: '棚' }, readNamed),
      box: readBrowserThing(MAP, 'box', page, readBox, '50', '9'),
      item: readBrowserThing(MAP, 'item', { id: '3', name: item }, readNamed),
    },
    values: { shelf: site('9'), box: site('50'), item: site('3') },
    account,
  })
  const writes = LINE.writes!
  const judge = (b: BrowserReadFacts, a: BrowserReadFacts) => judgeBrowserWrites(LINE.read, writes, MAP, b, a, '1')
  it('adds the value exactly once more and changes nothing else (the states read are not touched)', () => {
    const before = { shelf: { id: '9', name: '棚' }, box: { id: '50', shelf: '9', items: ['3'], order: [] }, item: { id: '3', name: 'pen' } }
    const after = predictBrowserWrites(LINE.read, writes, MAP, before, { item: '3' })
    expect(after?.box.items).toEqual(['3', '3'])
    expect(after?.shelf).toEqual(before.shelf)
    expect(before.box.items).toEqual(['3'])
    expect(predictBrowserWrites(LINE.read, writes, MAP, before, { item: '3 or 4' })).toBeNull()
    expect(predictBrowserWrites(LINE.read, writes, MAP, { ...before, box: { id: '50' } }, { item: '3' })).toBeNull()
  })
  it('only exactly the prediction is "as predicted"', () => {
    expect(judge(facts('items=1;order='), facts('items=3,1;order='))).toEqual({ status: 'as_predicted' })
    expect(judge(facts('items=1;order='), facts('items=1;order='))).toMatchObject({ status: 'not_as_predicted', differs: { box: ['items'] } })
    // A field the write does not name moved (the order list): not as predicted, naming it.
    expect(judge(facts('items=1;order='), facts('items=1,3;order=1'))).toMatchObject({ status: 'not_as_predicted', differs: { box: ['order'] } })
    // Another read moved.
    expect(judge(facts('items=1;order='), facts('items=1,3;order=', 'pencil'))).toMatchObject({ status: 'not_as_predicted', differs: { item: ['name'] } })
    // The account moved, or the page after is not read.
    expect(judge(facts('items=1;order='), facts('items=1,3;order=', 'pen', { before: '2', after: '2' })).status).toBe('unreadable')
    // Before and after agree, but not with the plan's account.
    const other = { before: '2', after: '2' }
    expect(judge(facts('items=1;order=', 'pen', other), facts('items=1,3;order=', 'pen', other)).status).toBe('unreadable')
    // Read before under another account, after under the plan's: the before is not the plan's state.
    expect(judge(facts('items=1;order=', 'pen', other), facts('items=1,3;order=')).status).toBe('unreadable')
    expect(judge(facts('items=1;order='), facts('nonsense')).status).toBe('unreadable')
  })
})
