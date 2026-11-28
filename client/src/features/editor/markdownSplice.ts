// Over ~300 lines: the one rule "write back only what changed" with its guards; split, the checks
// would sit apart from the writes they guard (files-and-editor.md "Editing a document in place").
//
// A rich-text editor writes the whole file back in its own style (`*` → `-`, table padding, blank
// lines, `_em_` → `*em*`), so one typed character would change many lines and make sync conflicts
// likelier. Here the file is cut into its top-level blocks (source offsets from the editor's own
// Markdown reader), each block is read alone (so it is known which editor nodes came from which
// bytes), and a change is written into the file as the smallest edit that reads back as exactly
// what the screen shows. Every byte outside the changed blocks — the `---` block, blank lines,
// untouched blocks — stays the file's own. What cannot be written that way is refused, never
// written approximately.
import type { Node as PMNode } from '@milkdown/prose/model'

/** A top-level block of the Markdown source: where it is and what the reader made of it. */
export interface SourceBlock { start: number; end: number; kind: string }

/** What the splice needs from the editor's Markdown reader and writer. */
export interface MarkdownCodec {
  /** Top-level blocks of `md` with their offsets (the reader's parse, before any transform). */
  blocks(md: string): SourceBlock[]
  /** `md` read into the editor's document. */
  parse(md: string): PMNode
  /** A document written as Markdown. */
  serialize(doc: PMNode): string
  /** Every character a reader of `md` sees (text, code, raw HTML, image descriptions). */
  visibleText(md: string): string
  /** Where each text block of `md` is (paragraph, heading, code, table cell, block HTML), in document order. */
  textblocks(md: string): Array<{ start: number; end: number }>
}

/** Why a document is not edited in place: shown to the member, who edits the source instead. */
export type InPlaceRefusal = 'unsupported' | 'lossy' | 'unreadable' | 'unavailable'

/** Block kinds read and written block by block. Anything else (footnotes, …) keeps the source view. */
const SUPPORTED = new Set(['paragraph', 'heading', 'thematicBreak', 'blockquote', 'list', 'code', 'html', 'table', 'definition'])

/** The `---` block byte for byte (with its closing line), and the rest. */
export function splitFront(text: string): { front: string; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: '', body: text }
}

/** What the reader shows of some nodes, for the "nothing lost on reading" check. */
export function nodesText(nodes: readonly PMNode[]): string {
  let out = ''
  for (const n of nodes) {
    n.descendants(d => {
      if (d.isText) out += d.text ?? ''
      else if (typeof d.attrs.value === 'string') out += d.attrs.value
      else if (d.type.name === 'image' && typeof d.attrs.alt === 'string') out += d.attrs.alt
      return true
    })
    if (typeof n.attrs.value === 'string' && n.isLeaf) out += n.attrs.value
  }
  return out
}

const squeeze = (s: string) => s.replace(/\s+/g, '')

/** A change written into the file: the whole new text, and `commit` to make it the new baseline. */
export interface SpliceWrite { text: string; commit(): void }

/**
 * A Markdown file opened in the editor block by block. `doc` is what the editor shows; `write`
 * turns the editor's current document into the file's new text (null: it cannot be written
 * faithfully — the caller keeps the last written state).
 */
export class SplicedDocument {
  private body: string
  private blocks: SourceBlock[]
  private nodes: PMNode[]
  /** Per block: its first node and how many nodes it made (a definition makes none). */
  private firstNode: number[] = []
  private nodeCount: number[] = []
  private readonly eol: '\n' | '\r\n'

  private constructor(private readonly codec: MarkdownCodec, private readonly front: string, body: string, blocks: SourceBlock[], nodes: PMNode[], counts: number[], private readonly docType: PMNode) {
    this.body = body
    this.blocks = blocks
    this.nodes = nodes
    this.eol = /\r\n/.test(body) ? '\r\n' : '\n'
    this.setCounts(counts)
  }

  /** Reads `text` block by block; refuses a document the editor cannot hold without losing text. */
  static load(text: string, codec: MarkdownCodec): { ok: true; doc: SplicedDocument } | { ok: false; reason: InPlaceRefusal } {
    try {
      const { front, body } = splitFront(text)
      const blocks = codec.blocks(body)
      if (blocks.some(b => !SUPPORTED.has(b.kind))) return { ok: false, reason: 'unsupported' }
      const defs = definitionsOf(body, blocks)
      const nodes: PMNode[] = []
      const counts: number[] = []
      for (const b of blocks) {
        if (b.kind === 'definition') { counts.push(0); continue }
        const source = body.slice(b.start, b.end)
        const made = children(codec.parse(withDefinitions(source, defs)))
        if (squeeze(codec.visibleText(withDefinitions(source, defs))) !== squeeze(nodesText(made))) return { ok: false, reason: 'lossy' }
        nodes.push(...made)
        counts.push(made.length)
      }
      return { ok: true, doc: new SplicedDocument(codec, front, body, blocks, nodes, counts, codec.parse('x')) }
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
  }

  /** The document to show. */
  get doc(): PMNode {
    return this.docType.type.create(this.docType.attrs, this.nodes)
  }

  /** The file's text as last written (or loaded). */
  get text(): string {
    return this.front + this.body
  }

  /**
   * The editor may normalise the document once when it is shown; that shown state is the baseline.
   * False when it changed the structure (then the document is not edited in place).
   */
  rebase(shown: PMNode): boolean {
    const now = children(shown)
    if (sameNodes(now, this.nodes)) { this.nodes = now; return true }
    // An empty file: the editor shows one empty paragraph that stands for no block.
    if (this.nodes.length === 0 && now.length === 1 && now[0].content.size === 0) { this.nodes = now; return true }
    return false
  }

  write(current: PMNode): SpliceWrite | null {
    // The editor's writer meeting a shape it cannot write throws: that change is not writable.
    try { return this.writeAll(current) } catch { return null }
  }

  private writeAll(current: PMNode): SpliceWrite | null {
    const now = children(current)
    const runs = changedRuns(this.nodes, now)
    if (runs.length <= 1) return this.writeRun(now)
    // Changes in several places at once (one step that touched two paragraphs): each is written as
    // its own run on a trial copy, so the unchanged blocks between them keep their bytes.
    const trial = this.copy()
    for (const run of runs) {
      const step = [...now.slice(0, run.newTo), ...this.nodes.slice(run.oldTo)]
      const w = trial.writeRun(step)
      if (!w) return null
      w.commit()
    }
    return { text: trial.text, commit: () => this.adopt(trial) }
  }

  private copy(): SplicedDocument {
    const c = new SplicedDocument(this.codec, this.front, this.body, [...this.blocks], [...this.nodes], [...this.nodeCount], this.docType)
    return c
  }

  private adopt(other: SplicedDocument) {
    this.body = other.body
    this.blocks = other.blocks
    this.nodes = other.nodes
    this.setCounts(other.nodeCount)
  }

  private writeRun(now: PMNode[]): SpliceWrite | null {
    const old = this.nodes
    let p = 0
    while (p < old.length && p < now.length && old[p].eq(now[p])) p++
    if (p === old.length && p === now.length) return { text: this.text, commit: () => { this.nodes = now } }
    let s = 0
    while (s < old.length - p && s < now.length - p && old[old.length - 1 - s].eq(now[now.length - 1 - s])) s++
    let oldStart = p
    let oldEnd = old.length - s
    if (oldStart === oldEnd) {
      // Only nodes added: the block before them is rewritten with them (or after, at the very top).
      if (oldStart > 0) oldStart--
      else oldEnd++
    }
    const range = this.blockRange(oldStart, Math.min(oldEnd, old.length))
    const { gFirst, gLast, fromNode, toNode, start, end } = range
    const newFrom = fromNode
    const newTo = now.length - (old.length - toNode)
    // What the file holds of these nodes: an empty paragraph or list item (just after Enter) has no
    // Markdown (the editor would write `<br />`), so it stays on screen only until text is typed in.
    const before = writable(old.slice(fromNode, toNode))
    const changed = writable(now.slice(newFrom, newTo))
    const region = this.body.slice(start, end)
    const defs = definitionsOf(this.body, this.blocks)
    const prev = gFirst > 0 ? this.blocks[gFirst - 1] : undefined
    const next = gFirst >= 0 ? this.blocks[gLast + 1] : undefined
    for (const written of this.candidates(region, before, changed, gFirst, gLast)) {
      let from = start
      let to = end
      let candidate = written
      if (candidate === '') {
        // A block removed whole takes the blank lines after it along (before it, at the end of the file).
        if (next && this.body.slice(end, next.start).trim() === '') to = next.start
        else if (!next && prev && this.body.slice(prev.end, start).trim() === '') from = prev.end
      } else if (region.trim() === '' && gFirst >= 0) {
        // Text typed into a line left empty on screen: it becomes a block of its own, apart from its neighbours.
        const eol = this.eol
        if (prev && !/\n[ \t]*\r?\n[ \t]*$/.test(this.body.slice(prev.end, start))) candidate = eol + eol + candidate
        if (next && !/^[ \t]*\r?\n[ \t]*\r?\n/.test(this.body.slice(end, next.start))) candidate += eol + eol
      }
      if (!this.readsBack(candidate, changed, defs)) continue
      if (!this.neighboursKept(from, to, candidate, gFirst, gLast)) continue
      const body = this.body.slice(0, from) + candidate + this.body.slice(to)
      return { text: this.front + body, commit: () => this.commit({ ...range, start: from, end: to }, candidate, body, now, newFrom, newTo, defs) }
    }
    return null
  }

  private setCounts(counts: number[]) {
    this.nodeCount = counts
    this.firstNode = []
    let n = 0
    for (const c of counts) { this.firstNode.push(n); n += c }
  }

  /** The blocks holding nodes `from`..`to` (exclusive) and their source range. */
  private blockRange(from: number, to: number) {
    const holding: number[] = []
    this.blocks.forEach((_, i) => {
      const a = this.firstNode[i]
      const z = a + this.nodeCount[i]
      if (this.nodeCount[i] > 0 && a < to && z > from) holding.push(i)
    })
    if (holding.length === 0) return { gFirst: -1, gLast: -1, fromNode: 0, toNode: this.nodes.length, start: 0, end: this.body.length }
    const gFirst = holding[0]
    const gLast = holding[holding.length - 1]
    return {
      gFirst, gLast,
      fromNode: this.firstNode[gFirst],
      toNode: this.firstNode[gLast] + this.nodeCount[gLast],
      start: this.blocks[gFirst].start,
      end: this.blocks[gLast].end,
    }
  }

  /** Ways to write `changed` over `region`, smallest first. */
  private *candidates(region: string, before: PMNode[], changed: PMNode[], gFirst: number, gLast: number): Generator<string> {
    const codec = this.codec
    const docOf = (ns: PMNode[]) => this.docType.type.create(this.docType.attrs, ns)
    const para = this.docType.type.schema.nodes.paragraph
    const lf = lfRegion(region)
    const back = (patched: string) => (lf.converted ? patched.replace(/\n/g, '\r\n') : patched)
    // 0. Nothing the file holds changed (an empty line added or removed on screen).
    if (sameNodes(before, changed)) { yield region; return }
    // 1. Typing inside a block: the same small text change made in the file's own bytes. The
    // smallest text block that changed is written alone first, so a table's or list's re-padding
    // elsewhere does not hide the one-character change.
    const inner = innermostChange(before, changed)
    const pairs: Array<[string, string]> = []
    if (inner && para) {
      const one = (n: PMNode) => codec.serialize(docOf([para.create(null, n.content)]))
      const [b, a] = [one(inner[0]), one(inner[1])]
      // First inside that text block's own bytes: the same words elsewhere (two equal list items)
      // cannot take the change.
      const at = textblockRange(lf.text, before, inner[0], codec)
      if (at) {
        for (const patched of textPatches(lf.text.slice(at.start, at.end), b, a)) yield back(lf.text.slice(0, at.start) + patched + lf.text.slice(at.end))
      }
      pairs.push([b, a])
    }
    pairs.push([codec.serialize(docOf(before)), codec.serialize(docOf(changed))])
    for (const [b, a] of pairs) for (const patched of textPatches(lf.text, b, a)) yield back(patched)
    // 2. A table's cells, rows or columns: only those cells / lines, keeping the file's padding.
    if (gFirst >= 0 && gFirst === gLast && this.blocks[gFirst].kind === 'table' && before.length === 1 && changed.length === 1) {
      const patched = tablePatch(lf.text, before[0], changed[0], codec, this.docType)
      if (patched !== null) yield back(patched)
    }
    // 3. Anything else (a new list item, bold, a block turned into another): only these blocks,
    // rewritten by the editor. Definitions between them stay as written.
    // With no block that shows anything (an empty file, or only definitions), the whole body is the
    // region: its definitions are kept as written after the new text.
    const keptDefs = (gFirst < 0 ? this.blocks : this.blocks.slice(gFirst, gLast + 1)).filter(b => b.kind === 'definition').map(b => this.body.slice(b.start, b.end))
    const written = keepReferenceLinks(region, codec.serialize(docOf(changed)).replace(/\s+$/, ''), this.body)
    const rewritten = [written, ...keptDefs].filter(Boolean).join('\n\n')
    const trailing = gFirst < 0 && rewritten !== '' ? (/\n$/.test(this.body) || this.body === '' ? '\n' : '') : ''
    // New lines as the region writes them (CRLF only where the region has nothing else).
    const eol = region.includes('\n') ? (lfRegion(region).converted ? '\r\n' : '\n') : this.eol
    const out = (rewritten + trailing).replace(/\r?\n/g, eol)
    // A list rewritten keeps the file's bullet (`-`) where the editor writes `*` (read back like any candidate).
    const bullet = /^[ \t]*([+-])[ \t]/m.exec(region)?.[1]
    if (bullet) yield out.replace(/^([ \t]*)\*(?=[ \t])/gm, `$1${bullet}`)
    yield out
  }

  /** The written region reads back as exactly what the screen shows. */
  private readsBack(candidate: string, changed: PMNode[], defs: string): boolean {
    try {
      const reread = this.codec.parse(withDefinitions(candidate, defs))
      return sameNodes(writable(children(reread)), changed)
    } catch {
      return false
    }
  }

  /** The blocks right before and after the region still read as the same blocks from the same bytes. */
  private neighboursKept(start: number, end: number, candidate: string, gFirst: number, gLast: number): boolean {
    if (gFirst < 0) return true
    const prev = this.blocks[gFirst - 1]
    const next = this.blocks[gLast + 1]
    const from = prev ? prev.start : start
    const tail = next ? this.body.slice(end, next.end) : ''
    const window = this.body.slice(from, start) + candidate + tail
    let found: SourceBlock[]
    try { found = this.codec.blocks(window) } catch { return false }
    // A block kept as one written region (its parts read differently alone) is checked by its edge only.
    const clean = (at: number) => !found.some(b => b.start < at && b.end > at)
    if (prev) {
      const first = found[0]
      const len = prev.end - prev.start
      if (prev.kind === 'region') { if (!clean(len)) return false }
      else if (!first || first.start !== 0 || first.end !== len || first.kind !== prev.kind) return false
    }
    if (next) {
      const last = found[found.length - 1]
      const at = window.length - (next.end - next.start)
      if (next.kind === 'region') { if (!clean(at)) return false }
      else if (!last || last.end !== window.length || last.start !== at || last.kind !== next.kind) return false
    }
    return true
  }

  /** The written text becomes the baseline: blocks re-read in the region, offsets after it shifted. */
  private commit(range: ReturnType<SplicedDocument['blockRange']>, candidate: string, body: string, now: PMNode[], newFrom: number, newTo: number, defs: string) {
    const { gFirst, gLast, start, end } = range
    const delta = candidate.length - (end - start)
    const shown = now.slice(newFrom, newTo)
    const changed = writable(shown)
    let fresh: SourceBlock[] = []
    let counts: number[] = []
    try {
      fresh = this.codec.blocks(candidate).map(b => ({ start: b.start + start, end: b.end + start, kind: b.kind }))
      const made: PMNode[] = []
      for (const b of fresh) {
        if (b.kind === 'definition') { counts.push(0); continue }
        const ns = children(this.codec.parse(withDefinitions(body.slice(b.start, b.end), defs)))
        made.push(...ns)
        counts.push(ns.length)
      }
      // Block by block the nodes must be the ones shown (an empty paragraph on screen has no block).
      if (!sameNodes(made, changed) || made.length !== shown.length) throw new Error('regroup')
    } catch {
      // Otherwise the written region is kept as one block holding the shown nodes.
      fresh = [{ start, end: start + candidate.length, kind: 'region' }]
      counts = [shown.length]
    }
    const lo = gFirst < 0 ? 0 : gFirst
    const hi = gFirst < 0 ? this.blocks.length : gLast + 1
    const after = this.blocks.slice(hi).map(b => ({ start: b.start + delta, end: b.end + delta, kind: b.kind }))
    this.blocks = [...this.blocks.slice(0, lo), ...fresh, ...after]
    this.setCounts([...this.nodeCount.slice(0, lo), ...counts, ...this.nodeCount.slice(hi)])
    this.body = body
    this.nodes = now
  }
}

/**
 * The runs of top-level nodes that differ between `old` and `now` (a longest common subsequence of
 * equal nodes between the common start and end). One run when the middle is too large to align.
 */
function changedRuns(old: PMNode[], now: PMNode[]): Array<{ oldTo: number; newTo: number }> {
  let p = 0
  while (p < old.length && p < now.length && old[p].eq(now[p])) p++
  if (p === old.length && p === now.length) return []
  let s = 0
  while (s < old.length - p && s < now.length - p && old[old.length - 1 - s].eq(now[now.length - 1 - s])) s++
  const a = old.slice(p, old.length - s)
  const b = now.slice(p, now.length - s)
  if (a.length * b.length > 40_000 || a.length === 0 || b.length === 0) return [{ oldTo: old.length - s, newTo: now.length - s }]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i].eq(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const runs: Array<{ oldTo: number; newTo: number }> = []
  let i = 0
  let j = 0
  let open = false
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].eq(b[j])) {
      if (open) { runs.push({ oldTo: p + i, newTo: p + j }); open = false }
      i++; j++
    } else {
      open = true
      if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) j++
      else i++
    }
  }
  if (open) runs.push({ oldTo: p + a.length, newTo: p + b.length })
  return runs
}

/**
 * The same document as read: node types, attributes, marks and text. Attributes the editor derives
 * for showing are left out: a heading's `id` (from its text) and a list item's `label` (its number,
 * renumbered on screen when an item is added): Markdown holds neither.
 */
export function sameNodes(a: readonly PMNode[], b: readonly PMNode[]): boolean {
  return a.length === b.length && a.every((n, i) => sameNode(n, b[i]))
}

function sameNode(a: PMNode, b: PMNode): boolean {
  if (a === b) return true
  if (a.type !== b.type || a.text !== b.text || !a.sameMarkup(b) && !sameIgnoringId(a, b)) return false
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) if (!sameNode(a.child(i), b.child(i))) return false
  return true
}

const DERIVED: Record<string, string> = { heading: 'id', list_item: 'label' }

function sameIgnoringId(a: PMNode, b: PMNode): boolean {
  const derived = DERIVED[a.type.name]
  if (!derived) return false
  const keep = (n: PMNode) => JSON.stringify(Object.entries(n.attrs).filter(([k]) => k !== derived))
  return keep(a) === keep(b) && a.marks.length === b.marks.length && a.marks.every((m, i) => m.eq(b.marks[i]))
}

/**
 * The nodes as the file holds them: empty paragraphs and list items whose only content is an empty
 * paragraph (what Enter makes before anything is typed) are left out, and so is a list left empty.
 */
export function writable(nodes: readonly PMNode[]): PMNode[] {
  const empty = (n: PMNode) => n.type.name === 'paragraph' && n.content.size === 0
  const isList = (n: PMNode) => /list/.test(n.type.name) && !/item/.test(n.type.name)
  const emptyItem = (n: PMNode) => /list_item/.test(n.type.name) && n.childCount === 1 && empty(n.firstChild!)
  const clean = (n: PMNode): PMNode | null => {
    if (empty(n)) return null
    if (n.isTextblock || n.isLeaf) return n
    const kept: PMNode[] = []
    let dropped = false
    n.forEach(c => {
      const k = isList(n) && emptyItem(c) ? null : clean(c)
      if (k !== c) dropped = true
      if (k) kept.push(k)
    })
    if (!dropped) return n
    // A list item or a list left with nothing in it is not written at all (an empty item has no Markdown).
    if (kept.length === 0) return null
    try { return n.type.create(n.attrs, kept, n.marks) } catch { return n }
  }
  return nodes.map(clean).filter((n): n is PMNode => n !== null)
}

/** The source range of `target` (a text block inside `nodes`), when the reader's text blocks line up with the editor's. */
function textblockRange(source: string, nodes: PMNode[], target: PMNode, codec: MarkdownCodec): { start: number; end: number } | null {
  const mine: PMNode[] = []
  for (const n of nodes) {
    if (n.isTextblock) { mine.push(n); continue }
    n.descendants(d => { if (d.isTextblock) { mine.push(d); return false } return true })
  }
  const index = mine.indexOf(target)
  if (index < 0) return null
  let ranges: Array<{ start: number; end: number }>
  try { ranges = codec.textblocks(source) } catch { return null }
  return ranges.length === mine.length ? ranges[index] : null
}

function children(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.content.forEach(c => { out.push(c) })
  return out
}

/** Link reference definitions resolve `[text][ref]` in any block: they are handed to every block's read. */
function definitionsOf(body: string, blocks: SourceBlock[]): string {
  return blocks.filter(b => b.kind === 'definition').map(b => body.slice(b.start, b.end)).join('\n')
}

function withDefinitions(source: string, defs: string): string {
  return defs ? `${source}\n\n${defs}\n` : source
}

/** A region with only CRLF line ends is patched as LF and written back as CRLF. */
function lfRegion(region: string): { text: string; converted: boolean } {
  if (!region.includes('\r\n') || /(^|[^\r])\n/.test(region)) return { text: region, converted: false }
  return { text: region.replace(/\r\n/g, '\n'), converted: true }
}

/**
 * `before` → `after` is the editor's own writing of a block before and after the edit. When the
 * change is one run of text on one line, find that spot in `source` by the characters around it
 * (as much as is the same in both writings, up to 16 on each side, the match unique) and make the
 * same change there. Whole lines added go under the same line of the source, in its indentation.
 */
export function textPatches(source: string, before: string, after: string): string[] {
  const out: string[] = []
  // A change the editor wrote as "replace the padding space with 。" is first tried as "add 。".
  const trimmed = textPatch(source, before, after, true)
  if (trimmed !== null) out.push(trimmed)
  const exact = textPatch(source, before, after)
  if (exact !== null) out.push(exact)
  const lines = linePatch(source, before, after)
  if (lines !== null) out.push(lines)
  return out
}

const LIST_MARKER = /^([*+-]|\d+[.)])(?=\s)/
const itemText = (line: string) => line.trim().replace(/^([*+-]|\d+[.)])\s+/, '').trim()

function linePatch(source: string, before: string, after: string): string | null {
  const bl = before.replace(/\s+$/, '').split('\n')
  const al = after.replace(/\s+$/, '').split('\n')
  // Lines compared without their list markers: the editor renumbers the items after a new one.
  const key = (l: string) => /^\s*/.exec(l)![0] + itemText(l)
  let p = 0
  while (p < bl.length && p < al.length && key(bl[p]) === key(al[p])) p++
  let s = 0
  while (s < bl.length - p && s < al.length - p && key(bl[bl.length - 1 - s]) === key(al[al.length - 1 - s])) s++
  if (bl.length - p - s !== 0 || p === 0) return null
  const added = al.slice(p, al.length - s)
  const anchor = bl[p - 1]
  if (anchor.trim() === '') return null
  const src = source.split('\n')
  // A list item is found by its text: the editor writes `*` and its own numbers, the file may not.
  const hits = src.map((l, i) => [l, i] as const).filter(([l]) => itemText(l) === itemText(anchor))
  if (hits.length !== 1) return null
  const [srcLine, at] = hits[0]
  const serIndent = /^\s*/.exec(anchor)![0]
  const srcIndent = /^\s*/.exec(srcLine)![0]
  const srcMarker = LIST_MARKER.exec(srcLine.slice(srcIndent.length))
  const rebased = added.map(l => {
    if (!l.startsWith(serIndent) || l.trim() === '') return l
    let rest = l.slice(serIndent.length)
    const m = LIST_MARKER.exec(rest)
    // A new item at the anchor's own level takes the file's marker: `-`, a list numbered `1.` on
    // every line keeps `1.`, otherwise the next number.
    if (m && srcMarker) {
      const num = /^(\d+)([.)])$/.exec(srcMarker[1])
      const markerOf = (line: string | undefined) => (line?.startsWith(srcIndent) ? LIST_MARKER.exec(line.slice(srcIndent.length))?.[1] : undefined)
      const repeated = markerOf(src[at + 1]) === srcMarker[1] || markerOf(src[at - 1]) === srcMarker[1]
      const marker = num && !repeated ? `${Number(num[1]) + 1}${num[2]}` : srcMarker[1]
      rest = marker + rest.slice(m[1].length)
    }
    return srcIndent + rest
  })
  return [...src.slice(0, at + 1), ...rebased, ...src.slice(at + 1)].join('\n')
}

/** The one text block that differs between two runs of nodes, descending while only one child differs. */
function innermostChange(old: PMNode[], now: PMNode[]): [PMNode, PMNode] | null {
  if (old.length !== 1 || now.length !== 1) return null
  let o = old[0]
  let n = now[0]
  for (;;) {
    if (o.type !== n.type || o.isTextblock) return o.isTextblock && n.isTextblock && o.type === n.type && sameAttrs(o, n) ? [o, n] : null
    if (o.childCount !== n.childCount || !sameAttrs(o, n)) return null
    let diff = -1
    for (let i = 0; i < o.childCount; i++) {
      if (!o.child(i).eq(n.child(i))) { if (diff >= 0) return null; diff = i }
    }
    if (diff < 0) return null
    o = o.child(diff)
    n = n.child(diff)
  }
}

function sameAttrs(a: PMNode, b: PMNode): boolean {
  return JSON.stringify(a.attrs) === JSON.stringify(b.attrs)
}

function textPatch(source: string, before: string, after: string, trimSpaces = false): string | null {
  let a = 0
  while (a < before.length && a < after.length && before[a] === after[a]) a++
  let b = 0
  while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++
  let removed = before.slice(a, before.length - b)
  let inserted = after.slice(a, after.length - b)
  if (trimSpaces) {
    if (!removed || removed.trim() !== '') return null
    removed = ''
    inserted = inserted.trim()
    b = before.length - a
  }
  if (removed.includes('\n') || inserted.includes('\n')) return null
  const lineStart = before.lastIndexOf('\n', a - 1) + 1
  const lineEndRaw = before.indexOf('\n', before.length - b)
  const lineEnd = lineEndRaw < 0 ? before.length : lineEndRaw
  for (let total = 32; total >= 1; total--) {
    for (let kl = Math.min(16, total); kl >= Math.max(0, total - 16); kl--) {
      const kr = total - kl
      if (a - kl < lineStart || before.length - b + kr > lineEnd) continue
      const pattern = before.slice(a - kl, a) + removed + before.slice(before.length - b, before.length - b + kr)
      const at = source.indexOf(pattern)
      if (at < 0 || source.indexOf(pattern, at + 1) >= 0) continue
      const from = at + kl
      return source.slice(0, from) + inserted + source.slice(from + removed.length)
    }
  }
  return null
}

/**
 * A GFM table edited in the editor (`old` → `now`, both table nodes): the same change made to the
 * table's own lines — changed cells rewritten in place, an added / removed row as one line, an
 * added / removed column as one cell on each line (Markdown keeps a column on every line). Null
 * when the change is not one of these or the source does not line up with the table.
 */
export function tablePatch(source: string, old: PMNode, now: PMNode, codec: MarkdownCodec, docType: PMNode): string | null {
  const grid = (t: PMNode) => { const rows: PMNode[][] = []; t.forEach(r => { const cs: PMNode[] = []; r.forEach(c => { cs.push(c) }); rows.push(cs) }); return rows }
  const o = grid(old)
  const n = grid(now)
  const trailing = /\s*$/.exec(source)![0]
  const lines = source.slice(0, source.length - trailing.length).split('\n')
  if (lines.length !== o.length + 1) return null
  const SPLIT = /(?<!\\)\|/
  const segs = lines.map(l => l.split(SPLIT))
  const lead = (s: string[]) => (s[0].trim() === '' ? 1 : 0)
  const lineOfRow = (r: number) => (r === 0 ? 0 : r + 1)
  const para = docType.type.schema.nodes.paragraph
  const cellMd = (c: PMNode) => {
    const inner = c.firstChild
    const md = inner && para ? codec.serialize(docType.type.create(docType.attrs, [para.create(null, inner.content)])).trim() : ''
    return md.replace(/(?<!\\)\|/g, '\\|')
  }
  const cellSeg = (c: PMNode) => ` ${cellMd(c)} `
  const delimFor = (c: PMNode) => { const a = c.attrs.alignment as string | null; return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---' }
  const join = (s: string[]) => s.join('|')
  const sameRow = (a: PMNode[], b: PMNode[]) => a.length === b.length && a.every((c, i) => c.eq(b[i]))
  const cols = (g: PMNode[][]) => g[0]?.length ?? 0
  const done = (out: string[]) => out.join('\n') + trailing
  if (o.length === n.length && cols(o) === cols(n)) {
    const out = segs.map(s => [...s])
    for (let r = 0; r < o.length; r++) {
      for (let c = 0; c < o[r].length; c++) {
        if (o[r][c].eq(n[r][c])) continue
        const s = out[lineOfRow(r)]
        const i = c + lead(s)
        if (i >= s.length) return null
        s[i] = cellSeg(n[r][c])
      }
    }
    return done(out.map(join))
  }
  if (Math.abs(o.length - n.length) === 1 && cols(o) === cols(n)) {
    const add = n.length > o.length
    const [longer, shorter] = add ? [n, o] : [o, n]
    let i = 0
    while (i < shorter.length && sameRow(shorter[i], longer[i])) i++
    for (let j = i; j < shorter.length; j++) if (!sameRow(shorter[j], longer[j + 1])) return null
    if (i === 0) return null
    const out = [...lines]
    if (add) out.splice(lineOfRow(i), 0, '|' + n[i].map(cellSeg).join('|') + '|')
    else out.splice(lineOfRow(i), 1)
    return done(out)
  }
  if (o.length === n.length && Math.abs(cols(o) - cols(n)) === 1) {
    const add = cols(n) > cols(o)
    const [wider, narrower] = add ? [n, o] : [o, n]
    let k = 0
    while (k < cols(narrower) && narrower.every((row, r) => row[k].eq(wider[r][k]))) k++
    for (let r = 0; r < narrower.length; r++) for (let c = k; c < cols(narrower); c++) if (!narrower[r][c].eq(wider[r][c + 1])) return null
    const out = segs.map((s, li) => {
      const t = [...s]
      const at = k + lead(t)
      if (!add) { t.splice(at, 1); return join(t) }
      const r = li === 0 ? 0 : li - 1
      t.splice(at, 0, li === 1 ? delimFor(n[0][k]) : cellSeg(n[r][k]))
      return join(t)
    })
    return done(out)
  }
  return null
}

/**
 * The editor writes a reference link (`[見積もり一覧][mitsumori]`, its address on a `[mitsumori]: …`
 * line elsewhere) as an inline one. When the rewritten blocks had it as a reference, put it back.
 */
function keepReferenceLinks(region: string, written: string, body: string): string {
  let out = written
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const m of region.matchAll(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = m[1]
    const ref = (m[2] || m[1]).toLowerCase()
    const def = new RegExp(`^\\[${esc(ref)}\\]:\\s*(\\S+)`, 'im').exec(body)
    if (!def) continue
    out = out.replace(new RegExp(`\\[${esc(label)}\\]\\(${esc(def[1])}(?:\\s+"[^"]*")?\\)`), m[0])
  }
  return out
}
