/**
 * Google Drive videos an HTML document embeds (doc-frame.md "The band of blocked internet parts (A3)",
 * owner decision 2026-11-26 "plan A"). The document view loads nothing from the internet, so such a
 * video cannot play inside it; the band lists them and the member opens each in their own browser
 * (Drive's own player and login). Nothing is loaded into the view.
 *
 * Pure: read from the HTML as written (static `src` of `<video>`, `<source>`, `<iframe>` only; what a
 * script builds is not seen, on purpose), each address judged by the core's one Drive link rule
 * (`driveFileIdFromLink`), narrowed to `drive.google.com`. Main keeps the ids; the renderer gets
 * counts only, and the address opened is built from the id alone (`driveVideoViewUrl`).
 */
import { driveFileIdFromLink, isDriveId } from '../../shared/core/google-drive'

/** The band lists at most this many videos (the rest is counted: 「ほかにもあります」). */
export const DOC_DRIVE_VIDEOS_MAX = 10

/** The only host a video is read from (Docs / Sheets / Slides are not videos). */
const DRIVE_HOST = 'drive.google.com'
/**
 * Exactly `https://drive.google.com` and then its path: the narrowing to Drive's own host (the core's
 * rule also takes `docs.google.com`), and cheap — most `src` are not Drive, and a page of thousands of
 * `<source>` must not cost a URL parse each. Spellings a browser would also take (`\`, a tab inside) are
 * not listed: under-listing only.
 */
const DRIVE_PREFIX = /^\s*https:\/\/drive\.google\.com[/?#]/i

/** The tags whose `src` is a video (an `<iframe>` is Drive's 「埋め込む」 player: `/file/d/<id>/preview`). */
const VIDEO_TAGS = new Set(['video', 'source', 'iframe'])

/**
 * Elements whose content is not the page's markup (raw text, or inert until a script uses it): a
 * `<video>` written inside them is not a video of the page. The same idea as the review's reading
 * (`htmlReview.ts`), kept small here. `plaintext` has no end: the rest of the file is its text.
 */
const SKIPPED_CONTENT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'])

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

/** The entities an address may be written with (`&amp;` above all); anything else stays as written. */
const NAMED: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }

function decodeUrlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});?/g, (whole, body: string) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? whole
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    // Only ASCII: a Drive address needs nothing else, and a lone surrogate never reaches the URL parser.
    return code > 0 && code < 0x80 ? String.fromCharCode(code) : whole
  })
}

/** The Drive file id of a video's address: `https`, exactly `drive.google.com`, the core's file-link rule. */
function driveVideoIdOf(raw: string): string | null {
  const url = decodeUrlEntities(raw)
  return DRIVE_PREFIX.test(url) ? driveFileIdFromLink(url) : null
}

/** Where the case-insensitive end tag `</name` starts at or after `from` (linear), or -1. */
function endTagAt(html: string, name: string, from: number): number {
  for (let at = html.indexOf('</', from); at >= 0; at = html.indexOf('</', at + 2)) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) {
      const after = html.charCodeAt(at + 2 + name.length)
      if (Number.isNaN(after) || isSpace(after) || after === 0x3e || after === 0x2f) return at
    }
  }
  return -1
}

/**
 * The Drive videos `html` embeds: their file ids, distinct, in the order first written, at most
 * `DOC_DRIVE_VIDEOS_MAX`, and how many different ones in all (`total`). One linear pass: each `<`
 * is looked at once, a tag's attributes are read forward, skipped content is jumped over.
 */
export function driveVideoIdsOf(html: string): { ids: string[]; total: number } {
  const seen = new Set<string>()
  const ids: string[] = []
  if (typeof html !== 'string') return { ids, total: 0 }
  const n = html.length
  let at = html.indexOf('<')
  while (at >= 0 && at < n) {
    if (html.startsWith('<!--', at)) {
      // `<!-->` and `<!--->` end at once (HTML's abrupt comment end); otherwise at the next `-->`.
      if (html.startsWith('>', at + 4) || html.startsWith('->', at + 4)) {
        at = html.indexOf('<', at + 4)
        continue
      }
      const end = html.indexOf('-->', at + 4)
      if (end < 0) break
      at = html.indexOf('<', end + 3)
      continue
    }
    let p = at + 1
    if (!isLetter(html.charCodeAt(p))) {
      at = html.indexOf('<', p)
      continue
    }
    while (p < n && !isSpace(html.charCodeAt(p)) && html[p] !== '/' && html[p] !== '>') p++
    const tag = html.slice(at + 1, p).toLowerCase()
    // Attributes, read forward to the tag's end (a `>` inside a quoted value does not end it).
    let src: string | null = null
    let closed = false
    while (p < n) {
      const c = html.charCodeAt(p)
      if (isSpace(c) || c === 0x2f) { p++; continue }
      if (c === 0x3e) { p++; closed = true; break }
      const nameStart = p
      p++ // the first character may be `=` (HTML reads it as part of the name)
      while (p < n && !isSpace(html.charCodeAt(p)) && html[p] !== '/' && html[p] !== '>' && html[p] !== '=') p++
      const name = html.slice(nameStart, p).toLowerCase()
      let q = p
      while (q < n && isSpace(html.charCodeAt(q))) q++
      let value = ''
      if (html[q] === '=') {
        q++
        while (q < n && isSpace(html.charCodeAt(q))) q++
        const quote = html[q]
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, q + 1)
          if (end < 0) { p = n; break }
          value = html.slice(q + 1, end)
          p = end + 1
        } else {
          const start = q
          while (q < n && !isSpace(html.charCodeAt(q)) && html[q] !== '>') q++
          value = html.slice(start, q)
          p = q
        }
      }
      // The first `src` counts (a repeated attribute is ignored by the parser).
      if (name === 'src' && src === null) src = value
    }
    if (!closed) break
    if (src !== null && VIDEO_TAGS.has(tag)) {
      const id = driveVideoIdOf(src)
      if (id && !seen.has(id)) {
        seen.add(id)
        if (ids.length < DOC_DRIVE_VIDEOS_MAX) ids.push(id)
      }
    }
    if (SKIPPED_CONTENT.has(tag)) {
      const end = endTagAt(html, tag, p)
      if (end < 0) break
      p = end + 2
    }
    at = html.indexOf('<', p)
  }
  return { ids, total: seen.size }
}

/**
 * The address the member's browser opens for a video: built by main from the id alone (Drive's own
 * page and player, its own login), never the page's address as written (its query, its fragment).
 */
export function driveVideoViewUrl(id: string): string | null {
  return isDriveId(id) ? `https://${DRIVE_HOST}/file/d/${id}/view` : null
}
