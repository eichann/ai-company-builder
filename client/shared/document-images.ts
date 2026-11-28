/**
 * Where a document's images go (files-and-editor.md "Images in a document", owner decision
 * 2026-11-28): the folder `images/` beside the document, a name from the date and time, written into
 * the document as `![](images/<name>)`. The one rule: main's `editor:saveImage` (an image pasted or
 * dropped into a document edited in place) names and places the file with it, the screen checks a
 * file against it before reading it, and the AI's standing instructions are written from it, so an
 * image a member pastes and one the AI makes land in the same place in the same shape. Beside the
 * document, an image is seen by whoever sees the document (a private folder's image stays private).
 */
import { DROP_WORDS, MAX_DROP_FILE_SIZE } from './file-drop'

export const DOCUMENT_IMAGE_FOLDER = 'images'

/**
 * The kinds taken in, decided by the bytes, never by the name or the type a caller says. No SVG: it
 * can carry script and links, and a file in a company folder is opened by other programs too.
 */
export type DocumentImageKind = 'png' | 'jpg' | 'gif' | 'webp'

const TYPE_KIND: Record<string, DocumentImageKind> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
}

/** As large as a Finder drop may be (`MAX_DROP_FILE_SIZE`, 20 MB): far under what sync shares (100 MB). */
export const MAX_DOCUMENT_IMAGE_SIZE = MAX_DROP_FILE_SIZE

export const DOCUMENT_IMAGE_WORDS = {
  type: '入れられるのは PNG・JPEG・GIF・WebP の画像だけです',
  size: `画像が${DROP_WORDS.size}`,
  folder: '文書の横の「images」が画像を置けるフォルダではないため、入れられません',
} as const

/** The kind of image these bytes are (their first bytes), or null. */
export function documentImageKind(bytes: Uint8Array): DocumentImageKind | null {
  const starts = (sig: number[], at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (starts([0xff, 0xd8, 0xff])) return 'jpg'
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'gif'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'webp'
  return null
}

/** Why main refuses these bytes, or null (size first: a huge file is never read further). */
export function documentImageRefusal(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_DOCUMENT_IMAGE_SIZE) return DOCUMENT_IMAGE_WORDS.size
  return documentImageKind(bytes) ? null : DOCUMENT_IMAGE_WORDS.type
}

/** The screen's check before it reads a pasted or dropped file (main checks the bytes again). */
export function documentImageFileRefusal(file: { type: string; size: number }): string | null {
  if (!TYPE_KIND[file.type.toLowerCase()]) return DOCUMENT_IMAGE_WORDS.type
  return file.size > MAX_DOCUMENT_IMAGE_SIZE ? DOCUMENT_IMAGE_WORDS.size : null
}

const two = (n: number) => String(n).padStart(2, '0')

/**
 * The file's name: the computer's local date and time to the second (`20261129-143005.png`); a
 * name already taken that second gets `-2`, `-3`, … (`attempt` 1, 2, …).
 */
export function documentImageName(at: Date, kind: DocumentImageKind, attempt = 0): string {
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  return `${stamp}${attempt > 0 ? `-${attempt + 1}` : ''}.${kind}`
}

/** The address written into the document, relative to it. */
export function documentImageAddress(name: string): string {
  return `${DOCUMENT_IMAGE_FOLDER}/${name}`
}

/** The line the document gets. */
export function documentImageMarkdown(name: string): string {
  return `![](${documentImageAddress(name)})`
}

/** The AI's one line (its standing instructions), written from the same rule. */
export function documentImageInstruction(): string {
  const example = documentImageName(new Date(2026, 10, 29, 14, 30, 5), 'png')
  return `【文書の画像】Markdown の文書に画像を入れるときは、文書と同じフォルダの「${DOCUMENT_IMAGE_FOLDER}/」に「${example}」のような日時の名前で置き、文書には ${documentImageMarkdown(example)} の形で書いてください。`
}

/** What `editor:saveImage` answers: the address to write into the document, or why not (a sentence for the member). */
export type DocumentImageResult = { success: true; address: string } | { success: false; error: string }
