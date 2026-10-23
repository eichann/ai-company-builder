// Line diff for the Markdown review's "changes since review" view.
//
// The view used a full LCS table: (m+1)·(n+1) cells, so two 5,000-line
// versions allocated 25M numbers (hundreds of MB as nested arrays) and froze
// or crashed the renderer. This is Myers' O((N+M)·D) algorithm in linear
// space (the middle-snake bisection, as in diff-match-patch), after trimming
// the common prefix and suffix; lines are compared as integer ids. Work is
// capped: past `maxSteps` it gives up and returns null ("too large to show"),
// which only happens when two big versions share almost nothing.

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

/** Default work budget (inner-loop steps). ~0.1–0.3 s at worst. */
export const DEFAULT_MAX_DIFF_STEPS = 30_000_000

class TooLarge extends Error {}

type Op = 0 | 1 | 2 // same, del, add

/**
 * The line diff of `oldText` → `newText` (split on '\n'), deletions before
 * insertions within each changed run; null when it would take more than
 * `maxSteps` steps.
 */
export function computeLineDiff(oldText: string, newText: string, maxSteps = DEFAULT_MAX_DIFF_STEPS): DiffLine[] | null {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const ids = new Map<string, number>()
  const toIds = (lines: string[]) => {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i])
      if (id === undefined) { id = ids.size; ids.set(lines[i], id) }
      out[i] = id
    }
    return out
  }
  const a = toIds(oldLines)
  const b = toIds(newLines)

  // ops[i] for each output line, built in order.
  const ops: Op[] = []
  let steps = 0
  const charge = (n: number) => {
    steps += n
    if (steps > maxSteps) throw new TooLarge()
  }

  const emit = (op: Op, count: number) => { for (let i = 0; i < count; i++) ops.push(op) }

  function diffRange(aLo: number, aHi: number, bLo: number, bHi: number): void {
    // Common prefix / suffix.
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { aLo++; bLo++; ops.push(0) }
    let suffix = 0
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; suffix++ }
    charge(1)
    if (aLo === aHi) emit(2, bHi - bLo)
    else if (bLo === bHi) emit(1, aHi - aLo)
    else if (noCommonLine(aLo, aHi, bLo, bHi)) { emit(1, aHi - aLo); emit(2, bHi - bLo) }
    else bisect(aLo, aHi, bLo, bHi)
    emit(0, suffix)
  }

  // A rewritten block shares no line with its old version: the bisection
  // would walk every diagonal (O(N·M)) to find that out.
  function noCommonLine(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
    if ((aHi - aLo) * (bHi - bLo) < 10_000) return false
    const inB = new Set<number>()
    for (let j = bLo; j < bHi; j++) inB.add(b[j])
    charge(aHi - aLo + bHi - bLo)
    for (let i = aLo; i < aHi; i++) if (inB.has(a[i])) return false
    return true
  }

  // Find the middle snake and split there (diff-match-patch's diff_bisect,
  // on index ranges).
  function bisect(aLo: number, aHi: number, bLo: number, bHi: number): void {
    const len1 = aHi - aLo
    const len2 = bHi - bLo
    const maxD = Math.ceil((len1 + len2) / 2)
    const vOffset = maxD
    const vLength = 2 * maxD + 2
    const v1 = new Int32Array(vLength).fill(-1)
    const v2 = new Int32Array(vLength).fill(-1)
    v1[vOffset + 1] = 0
    v2[vOffset + 1] = 0
    const delta = len1 - len2
    const front = (delta & 1) !== 0
    let k1start = 0, k1end = 0, k2start = 0, k2end = 0
    for (let d = 0; d < maxD; d++) {
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const k1Offset = vOffset + k1
        let x1 = (k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1])) ? v1[k1Offset + 1] : v1[k1Offset - 1] + 1
        let y1 = x1 - k1
        const sx = x1
        while (x1 < len1 && y1 < len2 && a[aLo + x1] === b[bLo + y1]) { x1++; y1++ }
        charge(1 + x1 - sx)
        v1[k1Offset] = x1
        if (x1 > len1) k1end += 2
        else if (y1 > len2) k1start += 2
        else if (front) {
          const k2Offset = vOffset + delta - k1
          if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1) {
            if (x1 >= len1 - v2[k2Offset]) return split(aLo, aHi, bLo, bHi, x1, y1)
          }
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const k2Offset = vOffset + k2
        let x2 = (k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1])) ? v2[k2Offset + 1] : v2[k2Offset - 1] + 1
        let y2 = x2 - k2
        const sx = x2
        while (x2 < len1 && y2 < len2 && a[aHi - x2 - 1] === b[bHi - y2 - 1]) { x2++; y2++ }
        charge(1 + x2 - sx)
        v2[k2Offset] = x2
        if (x2 > len1) k2end += 2
        else if (y2 > len2) k2start += 2
        else if (!front) {
          const k1Offset = vOffset + delta - k2
          if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
            const x1 = v1[k1Offset]
            const y1 = vOffset + x1 - k1Offset
            if (x1 >= len1 - x2) return split(aLo, aHi, bLo, bHi, x1, y1)
          }
        }
      }
    }
    // No common line at all.
    emit(1, len1)
    emit(2, len2)
  }

  function split(aLo: number, aHi: number, bLo: number, bHi: number, x: number, y: number): void {
    diffRange(aLo, aLo + x, bLo, bLo + y)
    diffRange(aLo + x, aHi, bLo + y, bHi)
  }

  try {
    diffRange(0, a.length, 0, b.length)
  } catch (err) {
    if (err instanceof TooLarge) return null
    throw err
  }

  // Materialise, putting deletions before insertions within each changed run.
  const result: DiffLine[] = []
  let i = 0, j = 0, k = 0
  while (k < ops.length) {
    if (ops[k] === 0) {
      result.push({ type: 'same', text: oldLines[i] })
      i++; j++; k++
      continue
    }
    let dels = 0, adds = 0
    while (k < ops.length && ops[k] !== 0) { if (ops[k] === 1) dels++; else adds++; k++ }
    for (let n = 0; n < dels; n++) result.push({ type: 'del', text: oldLines[i++] })
    for (let n = 0; n < adds; n++) result.push({ type: 'add', text: newLines[j++] })
  }
  return result
}
