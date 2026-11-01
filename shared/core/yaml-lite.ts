/**
 * A strict subset of YAML for the frontmatter of the company's type
 * definitions (`.acb/types/<name>.md`) and record files (light ontology,
 * stage 4-1). One copy for the server's indexer, the push checker and the
 * app, with no package behind it (shared/core is dependency-free).
 *
 * Accepted: block mappings (`key: value`, `key:` + an indented block), block
 * sequences (`- item`, `- key: value` starting a mapping), flow mappings and
 * sequences on one line (`{ a: b, c: [x, y] }`), plain / 'single' / "double"
 * quoted scalars, `#` comments. Plain scalars: `true` / `false`, `null` / `~`,
 * decimal integers and decimals become booleans, null and numbers; everything
 * else (dates included) stays a string.
 *
 * Refused with an error (never guessed): anchors, aliases, tags, block
 * scalars (`|`, `>`), multi-line plain scalars, flow collections over several
 * lines, complex keys, merge keys, duplicate keys, tabs in indentation and
 * keys that would reach an object's prototype. What a file author meant must
 * be what every reader sees, and a definition that steers the state engine
 * stays readable without YAML's corners.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

export type YamlResult = { ok: true; value: YamlValue } | { ok: false; error: string; line: number }

class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(message)
  }
}

interface Line {
  indent: number
  text: string
  /** 1-based line number in the parsed text. */
  no: number
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** The line without its comment (a `#` at the start or after whitespace, outside quotes), trailing space removed. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") {
        if (raw[i + 1] === "'") i++
        else quote = null
      }
    } else if (ch === '"' || ch === "'") {
      // A quote only opens a quoted scalar where one can start.
      const before = raw.slice(0, i).trimEnd()
      if (before === '' || /[:\-[{,]$/.test(before)) quote = ch
    } else if (ch === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i).trimEnd()
    }
  }
  return raw.trimEnd()
}

function prepare(text: string): Line[] {
  const lines: Line[] = []
  const raw = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  raw.forEach((r, idx) => {
    const no = idx + 1
    const content = stripComment(r)
    if (content.trim() === '') return
    const lead = /^[ \t]*/.exec(content)![0]
    if (lead.includes('\t')) throw new YamlError('インデントにタブは使えません（空白を使ってください）', no)
    const body = content.slice(lead.length)
    if (body === '---' || body === '...') throw new YamlError('区切りの行（--- / ...）はここでは使えません', no)
    lines.push({ indent: lead.length, text: body, no })
  })
  return lines
}

const isSeqItem = (text: string) => text === '-' || text.startsWith('- ')

function checkKey(key: string, line: number): string {
  if (key === '') throw new YamlError('項目名が空です', line)
  if (FORBIDDEN_KEYS.has(key)) throw new YamlError(`「${key}」は項目名に使えません`, line)
  if (key === '<<') throw new YamlError('「<<」（まとめて取り込む書き方）は使えません', line)
  return key
}

function plainScalar(s: string, line: number): YamlValue {
  if (/^[&*!|>%@`]/.test(s)) throw new YamlError(`この書き方は使えません: ${s.slice(0, 20)}`, line)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?(0|[1-9]\d{0,14})$/.test(s)) return Number(s)
  if (/^-?(0|[1-9]\d{0,14})\.\d{1,15}$/.test(s)) return Number(s)
  return s
}

/** A quoted scalar starting at `pos`; returns the value and the index after the closing quote. */
function quoted(s: string, pos: number, line: number): [string, number] {
  const q = s[pos]
  let out = ''
  for (let i = pos + 1; i < s.length; i++) {
    const ch = s[i]
    if (q === "'") {
      if (ch === "'") {
        if (s[i + 1] === "'") { out += "'"; i++; continue }
        return [out, i + 1]
      }
      out += ch
      continue
    }
    if (ch === '"') return [out, i + 1]
    if (ch !== '\\') { out += ch; continue }
    const e = s[++i]
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ' }
    if (e !== undefined && e in simple) { out += simple[e]; continue }
    if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16))
      i += 4
      continue
    }
    throw new YamlError('引用符の中のエスケープを読めません', line)
  }
  throw new YamlError('引用符が閉じられていません（1行の中で閉じてください）', line)
}

/** A flow collection or scalar inside `{…}` / `[…]`, starting at `pos`. */
function flowValue(s: string, pos: number, line: number, depth: number): [YamlValue, number] {
  if (depth > 20) throw new YamlError('入れ子が深すぎます', line)
  let i = pos
  while (s[i] === ' ') i++
  const ch = s[i]
  if (ch === '{') {
    const obj: Record<string, YamlValue> = {}
    i++
    for (;;) {
      while (s[i] === ' ') i++
      if (s[i] === '}') return [obj, i + 1]
      let key: string
      if (s[i] === '"' || s[i] === "'") {
        ;[key, i] = quoted(s, i, line)
      } else {
        const m = /^[^:,{}[\]]+/.exec(s.slice(i))
        if (!m) throw new YamlError('{ } の中の書き方を読めません', line)
        key = m[0].trim()
        i += m[0].length
      }
      checkKey(key, line)
      while (s[i] === ' ') i++
      if (s[i] !== ':') throw new YamlError(`「${key}」のあとに「:」がありません`, line)
      i++
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`項目「${key}」が2回書かれています`, line)
      let value: YamlValue
      ;[value, i] = flowValue(s, i, line, depth + 1)
      obj[key] = value
      while (s[i] === ' ') i++
      if (s[i] === ',') { i++; continue }
      if (s[i] === '}') return [obj, i + 1]
      throw new YamlError('{ } が閉じられていません（1行の中で閉じてください）', line)
    }
  }
  if (ch === '[') {
    const arr: YamlValue[] = []
    i++
    for (;;) {
      while (s[i] === ' ') i++
      if (s[i] === ']') return [arr, i + 1]
      let value: YamlValue
      ;[value, i] = flowValue(s, i, line, depth + 1)
      arr.push(value)
      while (s[i] === ' ') i++
      if (s[i] === ',') { i++; continue }
      if (s[i] === ']') return [arr, i + 1]
      throw new YamlError('[ ] が閉じられていません（1行の中で閉じてください）', line)
    }
  }
  if (ch === '"' || ch === "'") return quoted(s, i, line)
  const m = /^[^,{}[\]]*/.exec(s.slice(i))!
  const text = m[0].trim()
  if (text === '') throw new YamlError('値が空です', line)
  return [plainScalar(text, line), i + m[0].length]
}

/** The value written after `key:` or `- ` on one line. */
function inlineValue(s: string, line: number): YamlValue {
  if (s.startsWith('{') || s.startsWith('[') || s.startsWith('"') || s.startsWith("'")) {
    const [value, end] = flowValue(s, 0, line, 0)
    if (s.slice(end).trim() !== '') throw new YamlError('値のあとに余分な文字があります', line)
    return value
  }
  return plainScalar(s, line)
}

/** `key: rest` at the start of a line: [key, rest] or null when the line is not a mapping entry. */
function mappingEntry(text: string, line: number): [string, string] | null {
  if (text.startsWith('? ') || text === '?') throw new YamlError('「?」で始まる項目名は使えません', line)
  if (text.startsWith('"') || text.startsWith("'")) {
    const [key, end] = quoted(text, 0, line)
    const rest = text.slice(end)
    if (rest === ':' || rest.startsWith(': ')) return [key, rest.slice(1).trim()]
    return null
  }
  if (/^[{["']/.test(text)) return null
  const m = /^([^:]*?):(?: (.*)|$)/.exec(text)
  if (!m) return null
  return [m[1].trim(), (m[2] ?? '').trim()]
}

class Parser {
  constructor(private lines: Line[]) {}

  node(i: number, indent: number): [YamlValue, number] {
    return isSeqItem(this.lines[i].text) ? this.seq(i, indent) : this.map(i, indent)
  }

  private seq(i: number, indent: number): [YamlValue[], number] {
    const items: YamlValue[] = []
    while (i < this.lines.length && this.lines[i].indent === indent && isSeqItem(this.lines[i].text)) {
      const { text, no } = this.lines[i]
      const rest = text.slice(1).trimStart()
      if (rest === '') {
        const next = this.lines[i + 1]
        if (!next || next.indent <= indent) { items.push(null); i++; continue }
        const [value, after] = this.node(i + 1, next.indent)
        items.push(value)
        i = after
      } else if (mappingEntry(rest, no) !== null) {
        // "- key: value": a mapping whose entries line up with "key".
        const inner = indent + (text.length - rest.length)
        this.lines[i] = { indent: inner, text: rest, no }
        const [value, after] = this.map(i, inner)
        items.push(value)
        i = after
      } else {
        items.push(inlineValue(rest, no))
        i++
      }
      if (i < this.lines.length && this.lines[i].indent > indent) {
        throw new YamlError('インデントがそろっていません', this.lines[i].no)
      }
    }
    return [items, i]
  }

  private map(i: number, indent: number): [Record<string, YamlValue>, number] {
    const obj: Record<string, YamlValue> = {}
    while (i < this.lines.length && this.lines[i].indent === indent) {
      const { text, no } = this.lines[i]
      if (isSeqItem(text)) throw new YamlError('項目と「- 」の並びが混ざっています', no)
      const entry = mappingEntry(text, no)
      if (!entry) throw new YamlError(`「項目名: 値」の形で書いてください: ${text.slice(0, 30)}`, no)
      const key = checkKey(entry[0], no)
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`項目「${key}」が2回書かれています`, no)
      const rest = entry[1]
      i++
      if (rest !== '') {
        obj[key] = inlineValue(rest, no)
      } else {
        const next = this.lines[i]
        if (next && next.indent > indent) {
          ;[obj[key], i] = this.node(i, next.indent)
        } else if (next && next.indent === indent && isSeqItem(next.text)) {
          ;[obj[key], i] = this.seq(i, indent)
        } else {
          obj[key] = null
        }
      }
      if (i < this.lines.length && this.lines[i].indent > indent) {
        throw new YamlError('インデントがそろっていません（複数行にわたる値は書けません）', this.lines[i].no)
      }
    }
    return [obj, i]
  }
}

/** Parse YAML (the subset above). An empty text is an empty mapping. */
export function parseYamlLite(text: string, firstLine = 1): YamlResult {
  try {
    const lines = prepare(text)
    if (lines.length === 0) return { ok: true, value: {} }
    if (lines[0].indent !== 0) throw new YamlError('最初の行はインデントせずに書いてください', lines[0].no)
    const [value, end] = new Parser(lines).node(0, 0)
    if (end < lines.length) throw new YamlError('インデントがそろっていません', lines[end].no)
    return { ok: true, value }
  } catch (err) {
    if (err instanceof YamlError) return { ok: false, error: err.message, line: err.line + firstLine - 1 }
    throw err
  }
}

export interface Frontmatter {
  /** The YAML between the opening and closing `---`. */
  yaml: string
  /** The text after the closing `---`. */
  body: string
  /** 1-based line number of the first YAML line in the file. */
  yamlFirstLine: number
}

/**
 * The frontmatter of a Markdown file: it starts on the first line with `---`
 * and ends at the next line that is exactly `---` (or `...`). null when the
 * file has none (or it is never closed).
 */
export function splitFrontmatter(text: string): Frontmatter | null {
  const t = text.replace(/^﻿/, '')
  const lines = t.split(/\r\n|\r|\n/)
  if (lines[0]?.trimEnd() !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trimEnd()
    if (l === '---' || l === '...') {
      return { yaml: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n'), yamlFirstLine: 2 }
    }
  }
  return null
}

export function isYamlMap(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
