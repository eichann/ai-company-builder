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
 * - an inspection's meaning hash does not move when a map gains writes; a line's writes and a written thing's reach do;
 * - creating (PR 8): a map lets a copy set only an id of an account-bound thing or a plain text / date / time, never its
 *   own id or parent, and only of a thing that reaches nobody until handed out; a line's creates use only what an earlier
 *   write created, ids it reads under the account, `write` values of the field's kind (each used); the prediction is the
 *   original with the set fields and the site's new id, the judgement "as predicted" only for exactly that — the original
 *   unchanged, the copy not its original —; an id set from a value must differ from the original's before anything is
 *   sent; the lock is the object the originals are reached from.
 */
import { describe, expect, it } from 'vitest'
import { browserMapProblem, readBrowserThing, type BrowserMap } from '../../../shared/core/browser-map'
import type { BrowserReadFacts } from '../../../shared/core/browser-read-line'
import { browserLineMeaning, browserOpenedLineProblem, type BrowserOpenedLine } from '../../../shared/core/browser-opened'
import { browserLineWriteLocks, browserWritesPlanProblem, judgeBrowserWrites, predictBrowserWrites } from '../../../shared/core/browser-write-line'

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

// --- creating (generalization PR 8): `create_from` on a made-up map shaped like a copy that needs a copy of its child ---

const CMAP: BrowserMap = {
  site: 'example_site',
  version: '1.0.0',
  account: { label: 'アカウント' },
  things: {
    card: {
      label: 'カード', answer: 'json', id: 'id', id_from: 'address',
      fields: {
        id: { kind: 'id', label: '番号' }, title: { kind: 'text', label: '題' }, due: { kind: 'date', label: '期日', nullable: true },
        at: { kind: 'time', label: '時刻', nullable: true }, pack: { kind: 'id', label: '中身' }, size: { kind: 'number', label: '大きさ' },
      },
      keys: { title: 'required', due: 'required', at: 'required', pack: 'required', size: 'required' },
      writes: { create_from: { title: null, due: null, at: null, pack: 'pack' } },
      delivers: 'none',
      must_hold: { account: true },
    },
    pack: {
      label: '中身', answer: 'json', id: 'id', id_from: 'address',
      fields: { id: { kind: 'id', label: '番号' }, labels: { kind: 'id_set', label: '札' }, steps: { kind: 'id_list', label: '手順' } },
      keys: { labels: 'required', steps: 'required' },
      writes: { create_from: { labels: 'label' } },
      delivers: 'none',
      must_hold: { account: true },
    },
    label: {
      label: '札', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' },
      must_hold: { account: true },
    },
    loose_label: {
      label: '札（アカウントなし）', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' },
    },
    box: {
      label: '箱', answer: 'json', id: 'id', parent: { thing: 'card', field: 'card' },
      fields: { id: { kind: 'id', label: '番号' }, card: { kind: 'id', label: 'カード' }, inner: { kind: 'id', label: '内側' } },
      keys: { id: 'required', card: 'required', inner: 'required' },
      must_hold: { account: true, parent: true },
    },
    crate: {
      label: '木箱', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, inner: { kind: 'id', label: '内側' } },
      keys: { id: 'required', inner: 'required' },
      writes: { create_from: { inner: 'pack' } },
      delivers: 'none',
      must_hold: { account: true },
    },
  },
}

const CLINE: BrowserOpenedLine = {
  name: 'card_copy',
  version: '1.0.0',
  label: 'カードを複製して作る',
  read: {
    site: 'example_site',
    values: {
      source: { kind: 'id', role: 'target', from: ['site_fact'] },
      label: { kind: 'id', role: 'target', from: ['site_fact'] },
      title: { kind: 'text', role: 'write', from: ['person'] },
      due: { kind: 'date', role: 'write', from: ['person'] },
      at: { kind: 'time', role: 'write', from: ['person'] },
    },
    reads: [
      { name: 'source', thing: 'card', id: { value: 'source' } },
      { name: 'source_pack', thing: 'pack', id: { read: 'source', field: 'pack' } },
      { name: 'label', thing: 'label', id: { value: 'label' } },
    ],
    checks: [],
  },
  writes: [
    { read: 'source_pack', verb: 'create_from', set: { labels: { value: 'label' } }, as: 'new_pack' },
    { read: 'source', verb: 'create_from', set: { title: { value: 'title' }, due: { value: 'due' }, at: { value: 'at' }, pack: { created: 'new_pack' } }, as: 'new_card' },
  ],
  readLabels: { source: '元のカード', source_pack: '元の中身', label: '札' },
  show: [{ read: 'source', fields: ['title'] }],
}

describe('creating: the map\'s facts', () => {
  it('the example map is a map', () => expect(browserMapProblem(CMAP)).toBeNull())
  const broken: [string, (m: Loose) => void][] = [
    ['setting the copy\'s own id', m => { m.things.card.writes.create_from.id = null }],
    ['creating a thing that has a parent (a new child changes its parent: not a harmless prefix)', m => { m.things.box.writes = { create_from: { inner: 'pack' } }; m.things.box.delivers = 'none' }],
    ['a field it does not have', m => { m.things.card.writes.create_from.nowhere = null }],
    ['a number (not a kind a copy may set)', m => { m.things.card.writes.create_from.size = null }],
    ['an ordered list (not a kind a copy may set)', m => { m.things.pack.writes.create_from.steps = 'label' }],
    ['a plain field naming a thing', m => { m.things.card.writes.create_from.title = 'label' }],
    ['an id field with no thing', m => { m.things.card.writes.create_from.pack = null }],
    ['an id of a thing not bound to the account', m => { m.things.pack.writes.create_from.labels = 'loose_label' }],
    ['a thing created that reaches people (§4-1: only what nobody gets until handed out)', m => { m.things.card.delivers = 'scheduled' }],
    ['created without the account held', m => { m.things.card.must_hold = {} }],
  ]
  for (const [what, change] of broken) {
    it(`refuses ${what}`, () => {
      const m = clone(CMAP)
      change(m)
      expect(browserMapProblem(m)).not.toBeNull()
    })
  }
})

describe('creating: a line\'s creates', () => {
  it('the example line opens', () => expect(browserOpenedLineProblem(CLINE, CMAP)).toBeNull())
  const broken: [string, (l: Loose) => void][] = [
    ['setting a field the map does not let a copy set', l => { l.writes[1].set.size = { value: 'title' } }],
    ['creating a thing the map does not let be created', l => { l.writes[0].read = 'label' }],
    ['no field set (a plain duplicate)', l => { l.writes[0].set = {} }],
    ['what a later write creates', l => { l.writes = [l.writes[1], l.writes[0]] }],
    ['what no write creates', l => { l.writes[1].set.pack = { created: 'nowhere' } }],
    ['what was created put in a field for another thing', l => {
      l.writes.push({ read: 'source', verb: 'create_from', set: { pack: { created: 'new_card' } }, as: 'third' })
    }],
    ['a created object named like a read', l => { l.writes[0].as = 'source'; l.writes[1].set.pack = { created: 'source' } }],
    ['two creates under one name', l => { l.writes[1].as = 'new_pack' }],
    ['an id set from a value the line does not read as that thing', l => {
      l.read.values.other = { kind: 'id', role: 'target', from: ['site_fact'] }
      l.read.reads.push({ name: 'other', thing: 'card', id: { value: 'other' } }); l.readLabels.other = '別'
      l.writes[0].set.labels = { value: 'other' }
    }],
    ['an id read outside the account', l => { l.read.reads[2].thing = 'loose_label' }],
    ['a plain value from a target value', l => { l.writes[1].set.title = { value: 'label' } }],
    ['a plain value of another kind', l => { l.writes[1].set.due = { value: 'title' }; l.writes[1].set.title = { value: 'due' } }],
    ['a write value nothing writes', l => { delete l.writes[1].set.at }],
    ['a set entry of another shape', l => { l.writes[1].set.title = { value: 'title', created: 'new_pack' } }],
    ['the one-field shape for a create', l => { l.writes[0] = { read: 'source_pack', verb: 'create_from', field: 'labels', value: 'label' } }],
    ['a create whose original is not reached from a plan value (no lock)', l => {
      l.read.values.box = { kind: 'id', role: 'target', from: ['site_fact'] }
      l.read.reads.push({ name: 'box', thing: 'box', id: { value: 'box' }, parent: { read: 'source', field: 'id' } })
      l.read.reads.push({ name: 'crate', thing: 'crate', id: { read: 'box', field: 'inner' } })
      l.readLabels.box = '箱'; l.readLabels.crate = '木箱'
      l.writes.push({ read: 'crate', verb: 'create_from', set: { inner: { created: 'new_pack' } }, as: 'new_crate' })
    }],
  ]
  for (const [what, change] of broken) {
    it(`refuses ${what}`, () => {
      const l = clone(CLINE)
      change(l)
      expect(browserOpenedLineProblem(l, CMAP)).not.toBeNull()
    })
  }
  it('an inspection holding a write value is refused (a write value is used only by writes)', () => {
    const l = clone(CLINE) as Loose
    delete l.writes
    expect(browserOpenedLineProblem(l, CMAP)).toMatch(/使われていません/)
  })
  it('a change of what existed before the plan may not come before a create (the harmless prefix, §4-1)', () => {
    const m = clone(CMAP) as Loose
    m.things.pack.writes.add_child = { labels: 'label' }
    const l = clone(CLINE) as Loose
    l.read.values.pack = { kind: 'id', role: 'target', from: ['site_fact'] }
    l.read.reads.push({ name: 'pack', thing: 'pack', id: { value: 'pack' } }); l.readLabels.pack = '中身'
    const add = { read: 'pack', verb: 'add_child', field: 'labels', value: 'label' }
    expect(browserOpenedLineProblem({ ...l, writes: [...l.writes, add] }, m)).toBeNull()
    expect(browserOpenedLineProblem({ ...l, writes: [l.writes[0], add, l.writes[1]] }, m)).not.toBeNull()
    expect(browserOpenedLineProblem({ ...l, writes: [add, ...l.writes] }, m)).not.toBeNull()
  })
  it('a create\'s writes and the created thing\'s facts are part of the meaning', () => {
    const base = browserLineMeaning(CLINE, CMAP)
    const m = clone(CMAP) as Loose
    m.things.card.writes.create_from = { title: null, due: null, at: null, pack: 'pack' }
    m.things.card.writes.create_from.size = undefined
    delete m.things.card.writes.create_from.size
    m.things.pack.writes.create_from.labels = 'label'
    expect(browserLineMeaning(CLINE, m)).toBe(base)
    delete m.things.card.writes.create_from.at
    const l = clone(CLINE) as Loose
    delete l.writes[1].set.at; delete l.read.values.at
    expect(browserLineMeaning(l, m)).not.toBe(base)
  })
})

describe('creating: the prediction and the judgement', () => {
  const readCard = (a: unknown): unknown => { const o = a as Record<string, unknown>; return { title: o.title, due: o.due, at: o.at, pack: o.pack, size: o.size } }
  const readPack = (a: unknown): unknown => { const o = a as Record<string, unknown>; return { labels: o.labels, steps: o.steps } }
  const card = (over: Record<string, unknown> = {}) => ({ title: '元', due: '2026-11-26', at: '17:00', pack: '70', size: 3, ...over })
  const pack = (labels: string[], over: Record<string, unknown> = {}) => ({ labels, steps: ['5', '6'], ...over })
  const person = (value: string) => ({ value, from: { kind: 'person' as const, confirmed: true } })
  const site = (value: string) => ({ value, from: { kind: 'site_fact' as const } })
  const values = { source: site('40'), label: site('22'), title: person('新'), due: person('2026-12-03'), at: person('17:00') }
  const plain = { source: '40', label: '22', title: '新', due: '2026-12-03', at: '17:00' }
  const facts = (o: { card?: Record<string, unknown>; pack?: Record<string, unknown>; account?: string } = {}): BrowserReadFacts => ({
    reads: {
      source: readBrowserThing(CMAP, 'card', o.card ?? card(), readCard, '40'),
      source_pack: readBrowserThing(CMAP, 'pack', o.pack ?? pack(['21']), readPack, '70'),
      label: readBrowserThing(CMAP, 'label', { id: '22', name: '札' }, readNamed),
    },
    values,
    account: { before: o.account ?? '1', after: o.account ?? '1' },
  })
  const made = (o: { card?: Record<string, unknown>; pack?: Record<string, unknown>; cardId?: string; packId?: string } = {}) => ({
    new_pack: { id: o.packId ?? '71', read: readBrowserThing(CMAP, 'pack', o.pack ?? pack(['22']), readPack, o.packId ?? '71') },
    new_card: { id: o.cardId ?? '41', read: readBrowserThing(CMAP, 'card', o.card ?? card({ title: '新', due: '2026-12-03', pack: o.packId ?? '71' }), readCard, o.cardId ?? '41') },
  })
  const judge = (after = facts(), m: Loose = made()) => judgeBrowserWrites(CLINE.read, CLINE.writes!, CMAP, facts(), after, '1', m)
  it('the copy is its original with the set fields and its own new id; the original is not touched', () => {
    const before = { source: { id: '40', ...card() }, source_pack: { id: '70', ...pack(['21']) }, label: { id: '22', name: '札' } }
    const after = predictBrowserWrites(CLINE.read, CLINE.writes!, CMAP, before, plain, { new_pack: '71', new_card: '41' })
    expect(after?.new_pack).toEqual({ id: '71', labels: ['22'], steps: ['5', '6'] })
    expect(after?.new_card).toEqual({ id: '41', title: '新', due: '2026-12-03', at: '17:00', pack: '71', size: 3 })
    expect(after?.source).toEqual(before.source)
    expect(after?.source_pack).toEqual(before.source_pack)
    // No id from the site, an id that is one read before (the original), one id for two creates of a thing, a bad value.
    expect(predictBrowserWrites(CLINE.read, CLINE.writes!, CMAP, before, plain, { new_pack: '71' })).toBeNull()
    expect(predictBrowserWrites(CLINE.read, CLINE.writes!, CMAP, before, plain, { new_pack: '70', new_card: '41' })).toBeNull()
    expect(predictBrowserWrites(CLINE.read, CLINE.writes!, CMAP, before, plain, { new_pack: '71', new_card: '40' })).toBeNull()
    expect(predictBrowserWrites(CLINE.read, CLINE.writes!, CMAP, before, { ...plain, at: '25:00' }, { new_pack: '71', new_card: '41' })).toBeNull()
  })
  it('only exactly the prediction is "as predicted"', () => {
    expect(judge()).toEqual({ status: 'as_predicted' })
    expect(judge(facts(), made({ card: card({ title: '新', due: '2026-12-03' }) }))).toMatchObject({ status: 'not_as_predicted', differs: { new_card: ['pack'] } })
    expect(judge(facts(), made({ pack: pack(['21', '22']) }))).toMatchObject({ status: 'not_as_predicted', differs: { new_pack: ['labels'] } })
    expect(judge(facts(), made({ pack: pack(['22'], { steps: ['6', '5'] }) }))).toMatchObject({ status: 'not_as_predicted', differs: { new_pack: ['steps'] } })
    expect(judge(facts(), made({ card: card({ title: '新', due: '2026-12-03', pack: '71', size: 4 }) }))).toMatchObject({ status: 'not_as_predicted', differs: { new_card: ['size'] } })
    expect(judge(facts({ pack: pack(['22']) }))).toMatchObject({ status: 'not_as_predicted', differs: { source_pack: ['labels'] } })
    expect(judge(facts({ card: card({ size: 9 }) }))).toMatchObject({ status: 'not_as_predicted', differs: { source: ['size'] } })
    expect(judge(facts(), made({ packId: '70' }))).toMatchObject({ status: 'not_as_predicted', differs: { new_pack: ['id'] } })
    expect(judge(facts(), made({ cardId: '40' }))).toMatchObject({ status: 'not_as_predicted', differs: { new_card: ['id'] } })
    expect(judge(facts({ account: '2' })).status).toBe('unreadable')
    expect(judge(facts(), { new_pack: made().new_pack }).status).toBe('unreadable')
    expect(judge(facts(), { ...made(), new_card: { id: '42', read: made().new_card.read } }).status).toBe('unreadable')
    expect(judge(facts(), { ...made(), new_card: { id: '41', read: readBrowserThing(CMAP, 'card', { ...card(), extra: 1 }, readCard, '41') } }).status).toBe('unreadable')
  })
  it('before anything is sent: an id set from a value must differ from the original\'s; a plain value may be the same', () => {
    expect(browserWritesPlanProblem(CLINE.read, CLINE.writes!, CMAP, facts(), '1')).toBeNull()
    expect(browserWritesPlanProblem(CLINE.read, CLINE.writes!, CMAP, facts({ pack: pack(['22']) }), '1')).toBe('same-as-original')
    expect(browserWritesPlanProblem(CLINE.read, CLINE.writes!, CMAP, facts({ pack: pack(['21', '22']) }), '1')).toBe('same-as-original')
    expect(browserWritesPlanProblem(CLINE.read, CLINE.writes!, CMAP, facts({ card: card({ at: '17:00' }) }), '1')).toBeNull()
    expect(browserWritesPlanProblem(CLINE.read, CLINE.writes!, CMAP, facts({ account: '2' }), '1')).toBe('reads')
    // The judgement refuses the same plan: never "done" for a copy that kept its original's id.
    expect(judgeBrowserWrites(CLINE.read, CLINE.writes!, CMAP, facts({ pack: pack(['22']) }), facts({ pack: pack(['22']) }), '1', made()).status).toBe('unreadable')
  })
  it('the lock is the object the originals are reached from', () => {
    const keys = browserLineWriteLocks(CLINE.read, CLINE.writes!, CMAP, plain, { company: 'c', host: 'h', account: '1' })
    expect(keys).toHaveLength(1)
    expect(keys?.[0]).toContain('example_site.card')
    expect(keys?.[0]).toContain('"40"')
  })
})
