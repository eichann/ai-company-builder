/**
 * Page cards in a reply (chat-ui-and-history.md "Page cards in a reply", step ② of 「図とページで返す」): which
 * link of a reply is a page the member can look at in the HTML viewer. Pure.
 *
 * The reply's text is the AI's, which may have read a planted instruction, so a link is a card only when it
 * names one `.html` / `.htm` file inside the company folder — an absolute path under the company root, or a
 * path relative to it — below a folder (never the top level: the viewer refuses it), with no `.` / `..` /
 * empty segment, no scheme (`https:`, `file:`, `javascript:` stay what they are), no query or fragment.
 * The card only runs the viewer's own open (`editor.viewDocument`, or `file.open` from a consultation's
 * window); main checks everything again on `docView:open` (doc-frame.md). Nothing of the page is read or
 * loaded in the app's page.
 */
import { isHtmlDocumentName } from '../../../shared/doc-frame'
import { isPersonalPath } from '../../../../shared/core/records'
import { isPathWithin, normalizePathSeparators } from '../../shared/lib/path'

export interface PageCard {
  /** The file's absolute path (what the viewer is asked to open). */
  path: string
  /** The file name, shown under the title. */
  name: string
  /** Inside a `.personal/` folder: on this computer only, never shared. */
  personal: boolean
}

/** A link longer than this is not a path anyone writes (and is not worth decoding). */
const MAX_HREF = 2000

function decoded(href: string): string | null {
  try { return decodeURIComponent(href) } catch { return null }
}

/** Control characters, and the invisible and direction marks that could make the shown file name lie (`x\u202Elmth.html`). */
function hasHiddenCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff) return true
  }
  return false
}

/** The page card a link of a reply stands for, or null (an ordinary link). */
export function pageCardOf(href: unknown, rootPath: string | null | undefined): PageCard | null {
  if (typeof href !== 'string' || !rootPath || href.length === 0 || href.length > MAX_HREF) return null
  // A scheme (`https:`, `file:`, `javascript:`, `acb-doc:` …), a query or a fragment: not a file of the folder.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /[?#]/.test(href)) return null
  const text = decoded(href.trim())
  if (text === null || hasHiddenCharacter(text)) return null
  const root = normalizePathSeparators(rootPath).replace(/\/+$/, '')
  if (!root) return null
  const written = normalizePathSeparators(text)
  const path = written.startsWith('/') ? written : `${root}/${written}`
  if (path === root || !isPathWithin(path, root)) return null
  const rest = path.slice(root.length + 1).split('/')
  if (rest.length < 2 || rest.some(s => s === '' || s === '.' || s === '..')) return null
  const name = rest[rest.length - 1]
  if (name.startsWith('.') || !isHtmlDocumentName(name)) return null
  return { path, name, personal: isPersonalPath(rest.join('/')) }
}
