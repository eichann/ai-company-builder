// Splits a reply into top-level markdown blocks that render the same alone as
// together, so MarkdownMessage can memoise each one: while a reply streams,
// only the last (growing) block is parsed again — not the whole reply every
// throttle tick (a 60 KB reply took ~230 ms per parse).
//
// A split happens only at a blank line outside a fenced code block whose next
// line starts a new top-level block on its own: at column 0 and not a list
// item (a list item there would turn a tight list into two lists). Indented
// lines (list continuations, indented code) never start a block. A reply with
// link reference or footnote definitions — which apply to the whole document —
// is kept in one block.

export interface MarkdownBlock {
  text: string
  /** The block ends inside a fenced code block that is not closed yet (still streaming). */
  openFence: boolean
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(\s|$)/
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m

export function splitMarkdownBlocks(content: string): MarkdownBlock[] {
  if (DEFINITION.test(content)) return [{ text: content, openFence: hasOpenFence(content) }]
  const lines = content.split('\n')
  const blocks: MarkdownBlock[] = []
  let current: string[] = []
  let fence: { char: string; length: number } | null = null
  let blankRun = false
  let hasText = false

  for (const line of lines) {
    if (fence) {
      current.push(line)
      const match = FENCE.exec(line)
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null
      continue
    }
    if (!line.trim()) {
      current.push(line)
      blankRun = true
      continue
    }
    if (blankRun && hasText && !/^\s/.test(line) && !LIST_ITEM.test(line)) {
      // Drop the separating blank lines: each block is rendered on its own.
      while (current.length && !current[current.length - 1].trim()) current.pop()
      blocks.push({ text: current.join('\n'), openFence: false })
      current = []
    }
    blankRun = false
    hasText = true
    current.push(line)
    const open = FENCE.exec(line)
    // A backtick fence's info string cannot contain a backtick (that is inline code).
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = { char: open[1][0], length: open[1].length }
  }
  if (current.length || !blocks.length) blocks.push({ text: current.join('\n'), openFence: fence !== null })
  return blocks
}

function hasOpenFence(content: string): boolean {
  let fence: { char: string; length: number } | null = null
  for (const line of content.split('\n')) {
    const match = FENCE.exec(line)
    if (!match) continue
    if (fence) {
      if (match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null
    } else if (!(match[1][0] === '`' && match[2].includes('`'))) {
      fence = { char: match[1][0], length: match[1].length }
    }
  }
  return fence !== null
}

/** Streaming UI throttle: a long reply re-renders less often (its tail parse grows with it). */
export function streamThrottleMs(textLength: number): number {
  return textLength > 8_000 ? 150 : 50
}
