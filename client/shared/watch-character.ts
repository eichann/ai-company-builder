/**
 * The watch character's figure (.claude/rules/watch.md): which bundled parts a member's character is
 * made of, and the SVG elements those parts draw. Pure — no React, no DOM, no `Math.random` — so the
 * renderer, the preview page and the tests share one copy.
 *
 * - A character is chosen from the member's id and how many times they chose another one
 *   (`rerolls`), never from an email or a name. The id is only hashed: nothing in the output is
 *   taken from it, so no outside string ever reaches the SVG.
 * - Parts come from a versioned table. A released version's table and a released part's drawing
 *   never change: adding parts is a new version, so everyone keeps the character they have.
 * - At 32 px and under the pattern and the small tool are left out and the figure is cropped to the
 *   body with larger eyes; the colour, body and head tell characters apart there.
 * - There is no mouth: results are told by the text beside the character, never by its face.
 */

// --- Sizes and states --------------------------------------------------------------------------

export const WATCH_SIZES = [16, 24, 32, 64, 128] as const
export type WatchSize = typeof WATCH_SIZES[number]

/** Shown by motion only (the words beside it carry the result). Listed from the one that wins down. */
export const WATCH_STATES = ['stale', 'working', 'thinking', 'noticed', 'done', 'idle'] as const
export type WatchState = typeof WATCH_STATES[number]

/** At this size and under, the small figure: no pattern, no tool, cropped, larger eyes. */
export const WATCH_SMALL_MAX = 32

// --- Deterministic randomness ------------------------------------------------------------------

/** cyrb53: a string to a 53-bit number. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** mulberry32: a fixed sequence of numbers in [0, 1) from one seed. */
export function mulberry32(seed: number): () => number {
  let a = (seed >>> 0) ^ Math.floor(seed / 4294967296)
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- The SVG the parts draw --------------------------------------------------------------------

/** How a shape is painted; the CSS (features/watch/watch-character.css) maps each to tokens. */
export type WatchPaint =
  | 'body' | 'shade' | 'shadeFlat' | 'tint' | 'ink' | 'paper' | 'paperTool' | 'highlight'
  | 'inkLine' | 'toolLine' | 'hueLine' | 'ground' | 'dot'

/** The groups the motions move; the CSS animates them by state. */
export type WatchGroup = 'nod' | 'breath' | 'lean' | 'head' | 'look' | 'blink' | 'closed' | 'item'

interface Paint { paint: WatchPaint; strokeWidth?: number; transform?: string }
export type WatchShape =
  | Paint & { tag: 'path'; d: string }
  | Paint & { tag: 'circle'; cx: number; cy: number; r: number }
  | Paint & { tag: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | Paint & { tag: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
export interface WatchGroupNode {
  tag: 'g'
  group?: WatchGroup
  /** The point a motion turns around (px of the 48 × 48 drawing). */
  origin?: readonly [number, number]
  transform?: string
  /** Cut to the body's outline (the pattern). */
  clipToBody?: boolean
  children: WatchNode[]
}
export type WatchNode = WatchShape | WatchGroupNode

export interface WatchFigure {
  viewBox: string
  /** The body's outline, for the pattern's clip path. */
  bodyPath: string
  /** The department colour (01–12) the body is mixed from. */
  hue: string
  nodes: WatchNode[]
}

const r2 = (n: number) => Math.round(n * 100) / 100
const MIRROR = 'matrix(-1 0 0 1 48 0)'
const path = (d: string, paint: WatchPaint, strokeWidth?: number, transform?: string): WatchShape => ({ tag: 'path', d, paint, strokeWidth, transform })
const circle = (cx: number, cy: number, r: number, paint: WatchPaint, strokeWidth?: number): WatchShape => ({ tag: 'circle', cx: r2(cx), cy: r2(cy), r: r2(r), paint, strokeWidth })
const ellipse = (cx: number, cy: number, rx: number, ry: number, paint: WatchPaint, transform?: string): WatchShape => ({ tag: 'ellipse', cx: r2(cx), cy: r2(cy), rx: r2(rx), ry: r2(ry), paint, transform })
const rect = (x: number, y: number, width: number, height: number, paint: WatchPaint, rx?: number): WatchShape => ({ tag: 'rect', x: r2(x), y: r2(y), width: r2(width), height: r2(height), rx, paint })
const g = (children: WatchNode[], more: Omit<WatchGroupNode, 'tag' | 'children'> = {}): WatchGroupNode => ({ tag: 'g', ...more, children })
const mirrored = (shapes: WatchNode[]): WatchNode[] => [...shapes, g(shapes, { transform: MIRROR })]

// --- The parts (each part is drawn by its key; a released key's drawing never changes) ----------

/** t: top of the head, ey: eye line, dx: half the eye distance, sh: half width near the top. */
interface Body { name: string; t: number; ey: number; dx: number; sh: number; d: string }
const BODIES = {
  round: { name: 'まる', t: 13, ey: 26, dx: 5.6, sh: 10, d: 'M24 13C33 13 39 20 39 29C39 37 34 42 24 42C14 42 9 37 9 29C9 20 15 13 24 13Z' },
  square: { name: 'かく', t: 14, ey: 25.5, dx: 5.8, sh: 12, d: 'M17 14H31C36 14 38 16 38 21V36C38 40 36 42 32 42H16C12 42 10 40 10 36V21C10 16 12 14 17 14Z' },
  egg: { name: 'たまご', t: 10, ey: 24, dx: 5.2, sh: 8, d: 'M24 10C32 10 37 19 37 29C37 37 32 42 24 42C16 42 11 37 11 29C11 19 16 10 24 10Z' },
  koma: { name: 'こま', t: 11, ey: 26, dx: 5.4, sh: 9, d: 'M24 11L34.6 15.6Q36.4 16.4 36.7 18.4L39 38Q39.4 42 35.5 42H12.5Q8.6 42 9 38L11.3 18.4Q11.6 16.4 13.4 15.6Z' },
  barrel: { name: 'たる', t: 14, ey: 26, dx: 5.8, sh: 9.5, d: 'M16.5 14H31.5C36.5 17.5 40 22.5 40 28C40 33.5 37 38.5 32 42H16C11 38.5 8 33.5 8 28C8 22.5 11.5 17.5 16.5 14Z' },
  onigiri: { name: 'おにぎり', t: 12, ey: 30, dx: 4.6, sh: 5, d: 'M24 12C26.6 12 28.4 13.6 30 16.4L39 33C41.4 37.8 39 42 34 42H14C9 42 6.6 37.8 9 33L18 16.4C19.6 13.6 21.4 12 24 12Z' },
} as const satisfies Record<string, Body>

interface Head { name: string; draw: (b: Body) => { back: WatchNode[]; front: WatchNode[] } }
const HEADS = {
  none: { name: 'なし', draw: () => ({ back: [], front: [] }) },
  pointyEars: { name: 'とがり耳', draw: b => {
    const c = 24 - b.sh * 0.62, t = b.t
    return { back: mirrored([
      path(`M${r2(c - 3.4)} ${t + 5}L${r2(c - 1.6)} ${t - 4.6}L${r2(c + 3)} ${t + 3}Z`, 'body'),
      path(`M${r2(c - 2.1)} ${t + 3.6}L${r2(c - 1.3)} ${t - 1.6}L${r2(c + 1.2)} ${t + 2.6}Z`, 'tint'),
    ]), front: [] }
  } },
  roundEars: { name: 'まる耳', draw: b => {
    const c = 24 - b.sh * 0.72, t = b.t
    return { back: mirrored([circle(c, t + 1.6, 3.6, 'body'), circle(c, t + 1.6, 1.7, 'tint')]), front: [] }
  } },
  antenna: { name: 'アンテナ', draw: b => ({ back: [path(`M24 ${b.t + 1}V${b.t - 4}`, 'hueLine', 1.2), circle(24, b.t - 5.4, 2.1, 'shade')], front: [] }) },
  cowlick: { name: 'はね毛', draw: b => {
    const t = b.t
    return { back: [], front: [path(`M22.2 ${r2(t + 1.2)}Q21 ${r2(t - 3.4)} 18.4 ${r2(t - 3.6)}M24.2 ${r2(t + 0.8)}Q24.6 ${r2(t - 3.8)} 26.6 ${r2(t - 5.2)}`, 'hueLine', 1.3)] }
  } },
  sprout: { name: '芽', draw: b => {
    const t = b.t
    return { back: [
      path(`M24 ${t + 1}V${t - 3}`, 'hueLine', 1.1),
      path(`M24 ${r2(t - 2.8)}C22.4 ${r2(t - 6.6)} 18.6 ${r2(t - 6.4)} 17.8 ${r2(t - 4.6)}C19.4 ${r2(t - 2.4)} 22.4 ${t - 2} 24 ${r2(t - 2.8)}Z`, 'shade'),
      path(`M24 ${r2(t - 3.1)}C25.4 ${r2(t - 7.2)} 29.6 ${r2(t - 7.8)} 30.8 ${r2(t - 5.8)}C29.4 ${r2(t - 3.2)} 26.2 ${r2(t - 2.4)} 24 ${r2(t - 3.1)}Z`, 'shade'),
    ], front: [] }
  } },
  hat: { name: 'ぼうし', draw: b => {
    const t = b.t, w = Math.min(7, Math.max(5, b.sh * 0.75))
    return { back: [], front: [
      path(`M${r2(24 - w + 1)} ${r2(t + 2.2)}C${r2(24 - w + 1)} ${r2(t - 3.4)} ${r2(24 + w - 1)} ${r2(t - 3.4)} ${r2(24 + w - 1)} ${r2(t + 2.2)}Z`, 'shade'),
      rect(24 - w - 1, t + 1.4, 2 * w + 2, 2, 'shade', 1),
      circle(24, t - 2.6, 1.1, 'shade'),
    ] }
  } },
  floppyEars: { name: 'たれ耳', draw: b => {
    const cx = r2(24 - (b.sh + 1.4)), cy = r2(b.t + 6.5)
    return { back: [], front: mirrored([ellipse(cx, cy, 2.6, 5.2, 'shade', `rotate(16 ${cx} ${cy})`)]) }
  } },
} as const satisfies Record<string, Head>

/** side: -1 for the left eye, 1 for the right; k: how much larger (small sizes). */
interface Eyes { name: string; draw: (x: number, y: number, k: number, side: -1 | 1) => WatchShape[] }
const EYES = {
  dot: { name: 'てん', draw: (x, y, k) => [circle(x, y, 1.9 * k, 'ink')] },
  tall: { name: 'たて長', draw: (x, y, k) => [ellipse(x, y, 1.45 * k, 2.6 * k, 'ink')] },
  apart: { name: 'はなれ目', draw: (x, y, k, side) => [circle(x + side * 1.7, y + 0.6, 1.7 * k, 'ink')] },
  sleepy: { name: 'ねむそう', draw: (x, y, k) => [path(`M${r2(x - 2.3 * k)} ${r2(y - 0.3)}A${r2(2.3 * k)} ${r2(2.3 * k)} 0 0 0 ${r2(x + 2.3 * k)} ${r2(y - 0.3)}Z`, 'ink')] },
  shine: { name: 'ひかり', draw: (x, y, k) => [circle(x, y, 2.3 * k, 'ink'), circle(x + 0.8 * k, y - 0.8 * k, 0.75 * k, 'highlight')] },
  square: { name: 'しかく', draw: (x, y, k) => [rect(x - 1.6 * k, y - 1.6 * k, 3.2 * k, 3.2 * k, 'ink', r2(0.6 * k))] },
} as const satisfies Record<string, Eyes>

interface Pattern { name: string; draw: (b: Body) => WatchShape[] }
const PATTERNS = {
  none: { name: 'なし', draw: () => [] },
  belly: { name: 'おなか', draw: b => [ellipse(24, b.ey + 13, 8, 6.2, 'tint')] },
  band: { name: 'はらまき', draw: b => [rect(0, b.ey + 7, 48, 3.2, 'shadeFlat')] },
  dots: { name: 'みずたま', draw: b => [circle(17, b.ey + 9, 1.3, 'shadeFlat'), circle(24, b.ey + 12, 1.3, 'shadeFlat'), circle(31, b.ey + 9, 1.3, 'shadeFlat')] },
  hakama: { name: 'はかま', draw: b => [rect(0, b.ey + 10, 48, 12, 'shadeFlat'), rect(23.4, b.ey + 10, 1.2, 12, 'tint')] },
  sash: { name: 'たすき', draw: b => [path(`M4 ${b.ey - 3}L8 ${b.ey - 5}L46 ${b.ey + 15}L42 ${b.ey + 17.5}Z`, 'shadeFlat')] },
} as const satisfies Record<string, Pattern>

/** origin: the point the tool turns around while working. */
interface Item { name: string; origin: readonly [number, number]; draw: () => WatchNode[] }
const ITEMS = {
  none: { name: 'なし', origin: [12, 34], draw: () => [] },
  lantern: { name: 'ちょうちん', origin: [10, 28], draw: () => [
    path('M10 26.5V29.6', 'toolLine', 0.9), rect(7.8, 29.2, 4.4, 1.4, 'shade', 0.5), rect(6.4, 30.4, 7.2, 8, 'paper', 3.2),
    path('M6.8 33.1H13.2M6.8 35.7H13.2', 'hueLine', 0.7), rect(7.8, 38.2, 4.4, 1.4, 'shade', 0.5),
  ] },
  magnifier: { name: '虫めがね', origin: [13, 37], draw: () => [
    path('M11.6 35.4L14.6 38.6', 'toolLine', 1.9), circle(9, 33, 3.4, 'paperTool', 1.3),
    path('M7 32.4A2.2 2.2 0 0 1 8.4 30.8L8.7 31.6A1.4 1.4 0 0 0 7.8 32.6Z', 'highlight'),
  ] },
  pencil: { name: '鉛筆', origin: [10, 39], draw: () => [g([
    rect(8.2, 27.6, 3.6, 10, 'shade', 0.6), rect(8.2, 27.4, 3.6, 1.8, 'paper', 0.5),
    path('M8.2 37.6L10 41.4L11.8 37.6Z', 'paper'), path('M9.4 40.1L10 41.4L10.6 40.1Z', 'ink'),
  ], { transform: 'rotate(-28 10 35)' })] },
  envelope: { name: '封筒', origin: [9, 39], draw: () => [rect(3.6, 32.2, 10.4, 7.2, 'paper', 1), path('M4.1 32.8L8.8 36.4L13.5 32.8', 'hueLine', 0.9)] },
  flag: { name: '旗', origin: [6, 41], draw: () => [path('M6 25.6V41.4', 'toolLine', 1.1), path('M6.4 26.2L13.6 28.4L6.4 31.2Z', 'shade')] },
  key: { name: '鍵', origin: [8, 30], draw: () => [circle(8, 31.4, 2.6, 'toolLine', 1.3), path('M8 34V41.2M8 38.4H10.2M8 40.8H10.8', 'toolLine', 1.3)] },
} as const satisfies Record<string, Item>

/** The 12 department colours (`--data-department-01` …), with a name for the preview. */
const HUES = {
  '01': '山吹', '02': '空', '03': '若竹', '04': '桃', '05': '藤', '06': '桔梗',
  '07': '朱', '08': '青磁', '09': '柿', '10': '萌黄', '11': '水', '12': '菫',
} as const

// --- The versioned tables ----------------------------------------------------------------------

export interface WatchPartsTable {
  hue: ReadonlyArray<keyof typeof HUES>
  body: ReadonlyArray<keyof typeof BODIES>
  head: ReadonlyArray<keyof typeof HEADS>
  eyes: ReadonlyArray<keyof typeof EYES>
  pattern: ReadonlyArray<keyof typeof PATTERNS>
  item: ReadonlyArray<keyof typeof ITEMS>
}
export type WatchPartKind = keyof WatchPartsTable
/** The order parts are picked in: fixed, so one seed always gives one character. */
export const WATCH_PART_ORDER: readonly WatchPartKind[] = ['hue', 'body', 'head', 'eyes', 'pattern', 'item']

/**
 * Every released table, by version. A released entry is never edited (that would change everyone's
 * character): a new part is a new version whose table lists it. 12 × 6 × 8 × 6 × 6 × 7 = 145,152.
 */
export const WATCH_PARTS_TABLES: Readonly<Record<number, WatchPartsTable>> = {
  1: {
    hue: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
    body: ['round', 'square', 'egg', 'koma', 'barrel', 'onigiri'],
    head: ['none', 'pointyEars', 'roundEars', 'antenna', 'cowlick', 'sprout', 'hat', 'floppyEars'],
    eyes: ['dot', 'tall', 'apart', 'sleepy', 'shine', 'square'],
    pattern: ['none', 'belly', 'band', 'dots', 'hakama', 'sash'],
    item: ['none', 'lantern', 'magnifier', 'pencil', 'envelope', 'flag', 'key'],
  },
}
/** The version a new member's character (or a new choice) is made with. */
export const WATCH_PARTS_LATEST = 1

/** A member's character: one part of each kind, by its key. */
export interface WatchParts {
  hue: keyof typeof HUES
  body: keyof typeof BODIES
  head: keyof typeof HEADS
  eyes: keyof typeof EYES
  pattern: keyof typeof PATTERNS
  item: keyof typeof ITEMS
}

/** What a character is chosen from: the member's id, how many times they chose another, the table. */
export interface WatchSeed {
  memberId: string
  /** 0 for the first character; each 「ほかの子にする」 adds one. */
  rerolls?: number
  /** The parts table it was chosen from; the newest when left out. */
  version?: number
}

/**
 * The parts of a member's character, or null when the version is one this app does not know (saved
 * by a newer app): then nothing is drawn rather than another character.
 */
export function watchPartsFor(seed: WatchSeed, tables: Readonly<Record<number, WatchPartsTable>> = WATCH_PARTS_TABLES): WatchParts | null {
  const version = seed.version ?? WATCH_PARTS_LATEST
  const table = Object.prototype.hasOwnProperty.call(tables, version) ? tables[version] : undefined
  if (!table) return null
  const rerolls = seed.rerolls ?? 0
  if (!Number.isSafeInteger(rerolls) || rerolls < 0) throw new RangeError('rerolls must be a whole number from 0')
  const next = mulberry32(cyrb53(`v${version}:${rerolls ? `${seed.memberId}#${rerolls}` : seed.memberId}`))
  const pick = <T>(list: ReadonlyArray<T>): T => list[Math.floor(next() * list.length)]
  const parts = {} as Record<WatchPartKind, string>
  for (const kind of WATCH_PART_ORDER) parts[kind] = pick(table[kind])
  return parts as unknown as WatchParts
}

/** The parts' names in members' words (the preview page's list). */
export function watchPartNames(p: WatchParts): Record<WatchPartKind, string> {
  return {
    hue: HUES[p.hue], body: BODIES[p.body].name, head: HEADS[p.head].name,
    eyes: EYES[p.eyes].name, pattern: PATTERNS[p.pattern].name, item: ITEMS[p.item].name,
  }
}

// --- Assembly: only the bundled parts above are ever drawn -------------------------------------

/** The SVG elements of a character at a size; every state is drawn and the CSS shows the right one. */
export function watchFigure(p: WatchParts, size: number): WatchFigure {
  const small = size <= WATCH_SMALL_MAX
  const tiny = size <= 24
  const b: Body = BODIES[p.body]
  const head = HEADS[p.head].draw(b)
  const eyes = EYES[p.eyes]
  const k = tiny ? 1.3 : small ? 1.15 : 1
  const dx = small ? b.dx + 0.3 : b.dx
  const ey = b.ey
  const pattern = small ? [] : PATTERNS[p.pattern].draw(b)
  const item = small ? [] : ITEMS[p.item].draw()
  const dotX = Math.min(40.5, 24 + b.sh + 5)
  const dotY = b.t + 1
  const headOrigin = [24, b.t + 2] as const
  const lx = r2(24 - dx), rx = r2(24 + dx)
  const closed = `M${r2(lx - 2.2)} ${ey}Q${lx} ${r2(ey + 1.7)} ${r2(lx + 2.2)} ${ey}M${r2(rx - 2.2)} ${ey}Q${rx} ${r2(ey + 1.7)} ${r2(rx + 2.2)} ${ey}`

  const figure: WatchNode[] = [
    g(head.back, { group: 'head', origin: headOrigin }),
    path(b.d, 'body'),
    ...(pattern.length ? [g(pattern, { clipToBody: true })] : []),
    g(head.front, { group: 'head', origin: headOrigin }),
    g([
      g([...eyes.draw(lx, ey, k, -1), ...eyes.draw(rx, ey, k, 1)], { group: 'blink', origin: [24, ey] }),
      g([path(closed, 'inkLine', 1.3)], { group: 'closed' }),
    ], { group: 'look' }),
    ...(item.length ? [g(item, { group: 'item', origin: ITEMS[p.item].origin })] : []),
    circle(dotX, dotY, 3, 'dot', 1.6),
  ]
  return {
    viewBox: small ? '7.5 6 33 36.5' : '0 0 48 48',
    bodyPath: b.d,
    hue: p.hue,
    nodes: [
      ...(small ? [] : [ellipse(24, 43.4, 13, 1.7, 'ground')]),
      g([g([g(figure, { group: 'lean', origin: [24, 42] })], { group: 'breath', origin: [24, 42] })], { group: 'nod', origin: [24, 42] }),
    ],
  }
}
