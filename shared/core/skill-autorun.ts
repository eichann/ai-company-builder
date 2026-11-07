/**
 * The auto-run parts of a skill / subagent / command Markdown file: what
 * Claude Code runs on its own when the file is loaded — frontmatter `hooks`,
 * `mcpServers`, `lspServers`, `monitors` (any YAML spelling: quoted, flow,
 * escaped, anchored, nested), a body `!` + backtick where the `!` starts a
 * line or follows whitespace, or a ```` ```! ```` block. Whoever else may
 * edit the file, adding or changing such a part is owner/admin only.
 *
 * One copy for the push checker (`server/src/lib/push-check/rules.ts`
 * `autorunFindings`, which decodes git's blob as UTF-8 and asks this) and the
 * server's Skill shelf (`server/src/services/skill-shelf.ts`, a company without
 * the shared folder), so both refuse exactly the same files.
 *
 * Pure: imports nothing.
 */

const AUTORUN_KEYS = ['hooks', 'mcpServers', 'lspServers', 'monitors']
// A key spelled as a whole YAML scalar: at line start / after "? " "- " "{" ","
// "[" / after an anchor or tag, optionally quoted, then ":" or the end of the
// scalar (an anchored "&a hooks" can be reused as a key through "*a :").
const AUTORUN_KEY_RE = new RegExp(
  String.raw`(?:^[ \t]*|[?\-][ \t]+|[{,\[][ \t]*|[&!]\S*[ \t]+)["']?(${AUTORUN_KEYS.join('|')})["']?[ \t]*(?::|$|[,\]}#])`,
  'gim')

/** Reasons a skill/agent/command Markdown file (its UTF-8 text) would run something on load. */
export function autorunFindingsInText(source: string): string[] {
  let text = source
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const found = new Set<string>()
  // Frontmatter: Claude Code reads it only when the file starts with "---",
  // up to the next "---" (anywhere). Leading blank lines are accepted here too.
  const lf = text.replace(/\r\n?/g, '\n')
  const open = /^\s*---/.exec(lf)
  if (open) {
    const start = open.index + open[0].length
    const end = lf.indexOf('---', start)
    const fm = lf.slice(start, end < 0 ? undefined : end)
      .replace(/\\\n[ \t]*/g, '') // escaped line break inside a double-quoted key
      .replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (m, a, b, c) => {
        const cp = parseInt(a || b || c, 16)
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : m
      })
    for (const m of fm.matchAll(AUTORUN_KEY_RE)) {
      found.add(`frontmatter の ${AUTORUN_KEYS.find(k => k.toLowerCase() === m[1].toLowerCase())}`)
    }
  }
  // Body: Claude Code runs ```!…``` blocks and !`…` where "!" starts a line or
  // follows whitespace (/(?<=^|\s)!`[^`]+`/m), fenced code included. Any
  // opener counts, closed or not: arguments substituted at invocation time can
  // complete it.
  if (text.includes('```!')) found.add('```! ブロック')
  if (/(?<=^|\s)!`/m.test(text)) found.add('!`…` コマンド')
  return [...found]
}
