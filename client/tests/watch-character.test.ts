// The watch character (.claude/rules/watch.md): one member always gets the same character, a new
// parts version never changes anyone's, the small sizes leave the pattern and tool out, no outside
// string reaches the SVG, and its name is written in one place.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WATCH_PART_ORDER, WATCH_PARTS_LATEST, WATCH_PARTS_TABLES, WATCH_SIZES, watchFigure, watchPartsFor,
  type WatchNode, type WatchParts, type WatchPartsTable,
} from '../shared/watch-character'

const sig = (p: WatchParts | null) => (p ? WATCH_PART_ORDER.map(k => p[k]).join('-') : 'none')
const walk = (nodes: WatchNode[], visit: (n: WatchNode) => void) => {
  for (const n of nodes) { visit(n); if (n.tag === 'g') walk(n.children, visit) }
}

test('the same member id and choice count always give the same character and the same drawing', () => {
  for (const memberId of ['1', '29', 'b3c1e0a2-7f0e-4c2b-9a51-3d2c1b0a9f88']) {
    for (const rerolls of [0, 1, 7]) {
      const a = watchPartsFor({ memberId, rerolls })!
      assert.deepEqual(watchPartsFor({ memberId, rerolls, version: WATCH_PARTS_LATEST }), a)
      for (const size of WATCH_SIZES) assert.deepEqual(watchFigure(a, size), watchFigure(watchPartsFor({ memberId, rerolls })!, size))
    }
  }
  assert.notEqual(sig(watchPartsFor({ memberId: '29' })), sig(watchPartsFor({ memberId: '29', rerolls: 1 })), 'choosing another gives another')
})

// Version 1's characters as members already have them (they match the owner's image board,
// 2026-11-28). Editing version 1's table or the way parts are picked fails here.
const V1_RELEASED: Record<string, string> = {
  '1': '01-koma-pointyEars-sleepy-none-magnifier',
  '1#3': '04-onigiri-floppyEars-tall-dots-none',
  '29': '03-koma-roundEars-shine-hakama-lantern',
  '29#3': '10-square-roundEars-tall-belly-flag',
  'member-0042': '01-round-none-square-band-none',
  'member-0042#3': '11-koma-hat-square-band-none',
  'a1b2c3': '08-round-cowlick-apart-sash-none',
  'a1b2c3#3': '02-barrel-floppyEars-square-hakama-lantern',
}

test('a new parts version leaves every character of an earlier version as it was', () => {
  const v1 = (id: string, rerolls: number) => sig(watchPartsFor({ memberId: id, rerolls, version: 1 }))
  for (const [key, expected] of Object.entries(V1_RELEASED)) {
    const [id, n] = key.split('#')
    assert.equal(v1(id, Number(n ?? 0)), expected, key)
  }
  // A version 2 with more parts: version 1's characters stay, and version 2 gives other ones.
  const t1 = WATCH_PARTS_TABLES[1]
  const v2: WatchPartsTable = { ...t1, head: [...t1.head, 'hat', 'antenna'], item: [...t1.item, 'key'] }
  const tables = { ...WATCH_PARTS_TABLES, 2: v2 }
  let changed = 0
  for (let i = 1; i <= 100; i++) {
    const id = String(i)
    assert.equal(sig(watchPartsFor({ memberId: id, version: 1 }, tables)), v1(id, 0))
    if (sig(watchPartsFor({ memberId: id, version: 2 }, tables)) !== v1(id, 0)) changed++
  }
  assert.ok(changed > 50, 'version 2 is really another table')
})

test('a version this app does not know draws no character rather than another one', () => {
  assert.equal(watchPartsFor({ memberId: '1', version: 99 }), null)
  assert.equal(watchPartsFor({ memberId: '1', version: 0 }), null)
  assert.throws(() => watchPartsFor({ memberId: '1', rerolls: -1 }), RangeError)
  assert.throws(() => watchPartsFor({ memberId: '1', rerolls: 1.5 }), RangeError)
})

test('the preview\'s 100 members all get different characters', () => {
  const seen = new Set<string>()
  for (let i = 1; i <= 100; i++) seen.add(sig(watchPartsFor({ memberId: String(i) })))
  assert.equal(seen.size, 100)
})

test('at 32 px and under the pattern, the tool and the ground are left out and the figure is cropped', () => {
  // A character with both a pattern and a tool.
  const p = watchPartsFor({ memberId: '29' })!
  assert.ok(p.pattern !== 'none' && p.item !== 'none')
  const kinds = (size: number) => {
    const found = new Set<string>()
    walk(watchFigure(p, size).nodes, n => {
      if (n.tag === 'g' && n.clipToBody) found.add('pattern')
      if (n.tag === 'g' && n.group === 'item') found.add('item')
      if (n.tag !== 'g' && n.paint === 'ground') found.add('ground')
    })
    return [...found].sort()
  }
  for (const size of [16, 24, 32]) {
    assert.deepEqual(kinds(size), [], `${size}px`)
    assert.equal(watchFigure(p, size).viewBox, '7.5 6 33 36.5')
  }
  for (const size of [64, 128]) {
    assert.deepEqual(kinds(size), ['ground', 'item', 'pattern'], `${size}px`)
    assert.equal(watchFigure(p, size).viewBox, '0 0 48 48')
  }
})

// Only numbers, path data, transforms and the bundled names: nothing a member id could carry.
const SAFE = /^[0-9A-Za-z .,()-]*$/
test('the drawing is made from the bundled parts only: a member id never appears in it', () => {
  const ids = ['<script>alert(1)</script>', '" onload="x', 'url(#evil)', '../../etc', '中村さん', 'x'.repeat(5000)]
  for (const memberId of ids) {
    const p = watchPartsFor({ memberId })!
    for (const size of WATCH_SIZES) {
      const fig = watchFigure(p, size)
      const text = JSON.stringify(fig)
      assert.ok(!text.includes(memberId), 'the id is not in the drawing')
      const strings: string[] = []
      JSON.parse(text, (_k, v) => { if (typeof v === 'string') strings.push(v); return v })
      for (const s of strings) assert.match(s, SAFE)
      // The drawing depends on the chosen parts alone.
      assert.deepEqual(fig, watchFigure({ ...p }, size))
    }
  }
})

test('the character\'s screen name is written in one place (thing-words.ts)', () => {
  const client = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const found: string[] = []
  const scan = (dir: string) => {
    for (const e of fs.readdirSync(path.join(client, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) scan(rel)
      else if (/\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && fs.readFileSync(path.join(client, rel), 'utf8').includes('見張り役')) found.push(rel)
    }
  }
  scan('src'); scan('shared')
  assert.deepEqual(found, ['shared/thing-words.ts'])
})
