// The YAML frontmatter at the top of a SKILL.md (`---` … `---`). The AI
// (Claude Code, Codex) reads it as YAML to decide when to use the skill, so
// what the app writes must be valid YAML whatever the member typed: a
// description with a line break, `---`, `: ` or `#` once broke the block and
// the AI no longer saw the skill correctly. Pure; no YAML package: only the
// top-level `key: value` entries skills use are read and written.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * A YAML double-quoted scalar for `value`: always one line, every character
 * kept (line breaks as \n), so nothing typed can end the block or start a key.
 */
export function yamlQuoted(value: string): string {
  let out = '"'
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else if (code === 0x2028 || code === 0x2029 || code === 0x85) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ', N: '\u0085', _: ' ', L: ' ', P: ' ' }

function unquoteDouble(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16))
    return ESCAPES[e] ?? e
  })
}

/** A plain or quoted scalar on one line (comments after a plain value dropped, as YAML does). */
function scalar(raw: string): string {
  const v = raw.trim()
  if (v.startsWith('"')) {
    let end = 1
    while (end < v.length && v[end] !== '"') end += v[end] === '\\' ? 2 : 1
    return unquoteDouble(v.slice(1, end))
  }
  if (v.startsWith("'")) {
    const close = v.lastIndexOf("'")
    return (close > 0 ? v.slice(1, close) : v.slice(1)).replace(/''/g, "'")
  }
  return v.replace(/\s+#.*$/, '')
}

/** The top-level entries of the frontmatter, as strings; `{}` when there is none. */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return {}
  const lines = match[1].split(/\r?\n/)
  const result: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i].match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/)
    if (!entry) continue
    const [, key, rest = ''] = entry
    const block = rest.match(/^([|>])([+-]?)\s*(?:#.*)?$/)
    if (block) {
      // A block scalar: the following more-indented (or empty) lines.
      const body: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) body.push(lines[++i])
      const indent = Math.min(...body.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length), Infinity)
      const text = body.map(l => l.slice(Number.isFinite(indent) ? indent : 0))
      while (text.length && text[text.length - 1].trim() === '') text.pop()
      const joined = block[1] === '|'
        ? text.join('\n')
        : text.reduce((acc, l, n) => (l.trim() === '' ? `${acc}\n` : `${acc}${n === 0 || acc.endsWith('\n') ? '' : ' '}${l}`), '')
      result[key] = block[2] === '-' ? joined : `${joined}\n`
      continue
    }
    // A plain value continued on more-indented lines (YAML folds them with spaces).
    let value = rest
    if (!/^["']/.test(rest.trim())) {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*#/.test(lines[i + 1])) value += ` ${lines[++i].trim()}`
    }
    result[key] = scalar(value)
  }
  return result
}

/**
 * `content` with the frontmatter entry `key` set to `value` (quoted; a block
 * or continued value is replaced whole), added at the end when missing.
 * Content without frontmatter gets one.
 */
export function setFrontmatterField(content: string, key: string, value: string): string {
  const line = `${key}: ${yamlQuoted(value)}`
  const match = content.match(FRONTMATTER_RE)
  if (!match) return `---\n${line}\n---\n\n${content}`
  const lines = match[1].split(/\r?\n/)
  const at = lines.findIndex(l => l.startsWith(`${key}:`))
  if (at < 0) {
    lines.push(line)
  } else {
    let end = at + 1
    while (end < lines.length && (/^\s+\S/.test(lines[end]) || (lines[end].trim() === '' && /^\s/.test(lines[end + 1] ?? '')))) end++
    lines.splice(at, end - at, line)
  }
  return `---\n${lines.join('\n')}\n---\n${content.slice(match[0].length)}`
}
