import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeLineDiff, type DiffLine } from '../src/lib/line-diff'

/** The old full-table LCS (what MarkdownReview used): the reference for small inputs. */
function naiveLcsLength(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function check(oldText: string, newText: string, diff: DiffLine[]) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  // Applying the diff gives back both sides.
  assert.deepEqual(diff.filter(d => d.type !== 'add').map(d => d.text), oldLines)
  assert.deepEqual(diff.filter(d => d.type !== 'del').map(d => d.text), newLines)
  // Minimal: as many unchanged lines as the longest common subsequence.
  assert.equal(diff.filter(d => d.type === 'same').length, naiveLcsLength(oldLines, newLines))
  // Within a changed run, deletions come first.
  for (let i = 1; i < diff.length; i++) {
    assert.ok(!(diff[i - 1].type === 'add' && diff[i].type === 'del'), 'del after add in one run')
  }
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test('small random inputs: valid and minimal (against the naive LCS)', () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const r = rng(seed)
    const alphabet = 1 + Math.floor(r() * 5)
    const make = () => Array.from({ length: Math.floor(r() * 14) }, () => String.fromCharCode(97 + Math.floor(r() * alphabet))).join('\n')
    const oldText = make()
    // Half the time, derive the new text by edits of the old one.
    let newText: string
    if (r() < 0.5) {
      const lines = oldText.split('\n')
      for (let e = 0; e < 1 + Math.floor(r() * 3); e++) {
        const at = Math.floor(r() * (lines.length + 1))
        if (r() < 0.5 && lines.length > 0) lines.splice(Math.min(at, lines.length - 1), 1)
        else lines.splice(at, 0, String.fromCharCode(97 + Math.floor(r() * 6)))
      }
      newText = lines.join('\n')
    } else {
      newText = make()
    }
    const diff = computeLineDiff(oldText, newText)
    assert.ok(diff, `seed ${seed}`)
    try {
      check(oldText, newText, diff)
    } catch (err) {
      throw new Error(`seed ${seed}: ${JSON.stringify(oldText)} → ${JSON.stringify(newText)}: ${(err as Error).message}`)
    }
  }
})

test('edge cases', () => {
  for (const [o, n] of [['', ''], ['', 'a'], ['a', ''], ['a\nb\nc', 'a\nb\nc'], ['a\nb', 'b\na'], ['x\n', 'x\n\n'], ['a\r\nb', 'a\nb']]) {
    const diff = computeLineDiff(o, n)
    assert.ok(diff)
    check(o, n, diff)
  }
  assert.deepEqual(computeLineDiff('a\nb\nc', 'a\nX\nc'), [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'X' },
    { type: 'same', text: 'c' },
  ])
})

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ` + 'x'.repeat(i % 50))

test('5,000-line documents (scattered edits, all lines replaced, every other line rewritten): diffed within the default budget', () => {
  const t = performance.now()

  // Scattered edits: both sides come back.
  const base = lines(5000, 'doc')
  const edited = base.slice()
  const r = rng(42)
  for (let e = 0; e < 200; e++) {
    const at = Math.floor(r() * edited.length)
    if (r() < 0.5) edited.splice(at, 1)
    else edited.splice(at, 0, `inserted ${e}`)
  }
  const scattered = computeLineDiff(base.join('\n'), edited.join('\n'))
  assert.ok(scattered)
  assert.deepEqual(scattered.filter(d => d.type !== 'add').map(d => d.text), base)
  assert.deepEqual(scattered.filter(d => d.type !== 'del').map(d => d.text), edited)

  // Every line replaced: the worst distance, still not given up.
  const replaced = computeLineDiff(lines(5000, 'old').join('\n'), lines(5000, 'new').join('\n'))
  assert.ok(replaced)
  assert.equal(replaced.filter(d => d.type === 'del').length, 5000)
  assert.equal(replaced.filter(d => d.type === 'add').length, 5000)

  // Every other line rewritten: interleaved, still not given up.
  const b = base.map((l, i) => (i % 2 ? `${l} (edited)` : l))
  const interleaved = computeLineDiff(base.join('\n'), b.join('\n'))
  assert.ok(interleaved)
  assert.equal(interleaved.filter(d => d.type === 'same').length, 2500)

  const ms = performance.now() - t
  assert.ok(ms < 4000, `took ${ms.toFixed(0)} ms`)
})

test('pathological size: gives up (null) instead of hanging', () => {
  // Interleaved common lines force a large D with no shortcut.
  const a = Array.from({ length: 40000 }, (_, i) => (i % 2 ? 'same' : `a${i}`)).join('\n')
  const b = Array.from({ length: 40000 }, (_, i) => (i % 3 ? 'same' : `b${i}`)).join('\n')
  const t = performance.now()
  const diff = computeLineDiff(a, b, 2_000_000)
  assert.equal(diff, null)
  assert.ok(performance.now() - t < 2000)
})
