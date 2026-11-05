// diskKey has to say what a Mac's disk does: under-folding lets a look-alike land
// on a protected path, over-folding refuses a member's ordinary names and stops
// their sync. The table holds everywhere; on macOS every cased character is
// compared with the real file system (the reason this file is on the macOS list).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diskKey, lookalikeKey } from '../../shared/core/paths'

const SAME: Array<[string, string]> = [
  ['ſ', 's'], ['K', 'k'], ['ß', 'ss'], ['ẞ', 'ss'], ['ﬁ', 'fi'], ['ﬆ', 'st'], ['Ａ', 'ａ'], ['É', 'é'], ['Ⅰ', 'ⅰ'], ['Ⓐ', 'ⓐ'], ['ς', 'σ'], ['µ', 'μ'],
]
const APART: Array<[string, string]> = [
  ['ı', 'i'], ['⭐️', '⭐'], ['葛\u{E0100}城', '葛城'], ['a\u200Bb', 'ab'], ['a\u00ADb', 'ab'], ['（1）', '(1)'], ['ｶ', 'カ'], ['～', '〜'],
]

test('diskKey folds what a disk folds and keeps apart what it keeps apart', () => {
  for (const [a, b] of SAME) assert.equal(diskKey(a), diskKey(b), `${a} / ${b}`)
  for (const [a, b] of APART) assert.notEqual(diskKey(a), diskKey(b), `${a} / ${b}`)
})

test('lookalikeKey is wider, for protected names only', () => {
  for (const name of ['.ｃｌａｕｄｅ', '.cl\u200Daude', '.clauﬀ'.replace('ﬀ', 'de')]) assert.equal(lookalikeKey(name), '.claude')
})

test('on this Mac: every cased character lands where diskKey says', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-disk-key-'))
  try {
    const wrong: string[] = []
    for (let cp = 0x80; cp <= 0x1FFFF; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue
      const c = String.fromCodePoint(cp)
      const key = diskKey(c)
      if (key.includes('/')) continue
      const file = path.join(dir, `x${c}`)
      // APFS refuses code points Unicode leaves unassigned: no file, nothing to compare.
      try { fs.writeFileSync(file, '') } catch { continue }
      // Said to fold: the disk must agree. Case partners: diskKey must agree with the disk.
      if (key !== c.normalize('NFC') && !fs.existsSync(path.join(dir, `x${key}`))) wrong.push(`U+${cp.toString(16)} ${c} -> ${key}`)
      for (const other of [c.toUpperCase(), c.toLowerCase()]) {
        if (other !== c && fs.existsSync(path.join(dir, `x${other}`)) !== (diskKey(other) === key)) wrong.push(`U+${cp.toString(16)} ${c} / ${other}`)
      }
      fs.rmSync(file)
    }
    assert.deepEqual(wrong, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
