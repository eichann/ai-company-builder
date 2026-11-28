// The small door to editing a Markdown document in place (files-and-editor.md "Editing a document
// in place"): a document goes in, the file's new text comes out after each change. Which editor
// draws it (Milkdown today) and how only the changed part is written back (markdownSplice.ts) stay
// behind this door, so the parts can be replaced without the screen changing. The editor is
// loaded only when a document is first shown this way (it is ~440 KB; dist/vendor/).
import type { InPlaceRefusal } from './markdownSplice'
import type { InPlaceBlock } from './blockChoices'

export type { InPlaceRefusal, InPlaceBlock }

export interface InPlaceOptions {
  /** The document's folder: relative image addresses are read from there. */
  folder: string
  /** The file's whole new text after a change the editor could write back. */
  onChange(text: string): void
  /** A change that could not be written back faithfully was taken back on screen (nothing written). */
  onChangeTakenBack(): void
  /** The words selected (what the selection bubble shows), or none / the focus left the document. */
  onSelection(selection: InPlaceSelection | null): void
  /** The 「/」 list to show (a line holding 「/」 and what was typed after it), or none. */
  onBlockMenu(menu: InPlaceBlockMenu | null): void
  /** The table holding the caret (its bar's place and what it can do), or none. */
  onTable(table: InPlaceTable | null): void
  /**
   * A file pasted or dropped into the document, kept beside it: the address to write (`images/…`),
   * or null when it was not kept (the screen says why). The editor then puts the image in.
   */
  storeImage(file: File): Promise<string | null>
}

export interface InPlaceBlockMenu {
  /** What was typed after 「/」. */
  query: string
  /** The blocks it finds, in the list's order (never empty). */
  choices: InPlaceBlock[]
  /** The caret on screen (viewport pixels). */
  box: { left: number; top: number; bottom: number }
}

/** The table bar's operations. */
export type TableEdit = 'addRow' | 'addColumn' | 'deleteRow' | 'deleteColumn'

export interface InPlaceTable {
  /** The table's top right corner on screen (viewport pixels). */
  box: { top: number; right: number }
  /** Which operations apply where the caret is (no deleting the header row, the last column or the last row). */
  can: Record<TableEdit, boolean>
}

/** The decorations the bubble offers: each one a Markdown mark, so the file keeps it. */
export type InPlaceMark = 'strong' | 'emphasis' | 'strike' | 'code'
/** 0 = body text, 1–3 = heading 1–3. */
export type TextSize = 0 | 1 | 2 | 3

export interface InPlaceSelection {
  /** The selected words as shown. */
  text: string
  /** Where they are on screen (viewport pixels). */
  box: { left: number; top: number; bottom: number }
  /** Which decorations every selected character carries. */
  marks: Record<InPlaceMark, boolean>
  /** The link's address at the selection, or none. */
  link: string | null
  /** The selected line's size, or null across blocks / in another kind of block. */
  size: TextSize | null
}

export interface InPlaceSurface {
  destroy(): void
  focus(): void
  /** The focus is in the document (its shortcuts apply only then). */
  hasFocus(): boolean
  toggleMark(mark: InPlaceMark): void
  /** A link on the selection (`href`) or none (`null`); the selection last shown when the focus left (a box for the address). */
  setLink(href: string | null): void
  setSize(size: TextSize): void
  /** The 「/」 list's choice: the 「/…」 line becomes that block. */
  turnInto(block: InPlaceBlock): void
  /** Esc on the 「/」 list: it closes, the 「/」 stays as typed. */
  closeBlockMenu(): void
  editTable(edit: TableEdit): void
  /** The passage holding the selection last shown, or null (nothing selected, a change not written yet). */
  selectedPassage(): InPlacePassage | null
  /** The passage holding file offsets `start`..`end` of the text shown (a comment's quote), or null. */
  passageAt(start: number, end: number): InPlacePassage | null
  /** Shows `element` in the document's flow right under the passage (not part of the text); null takes it away. */
  showBelow(passage: InPlacePassage, element: HTMLElement | null): void
  /** What adopting `markdown` in place of the passage would change, written through the write-back. */
  previewFix(passage: InPlacePassage, markdown: string): InPlaceFixPreview
  /** Puts `markdown` in place of the passage, written like typing (the changed lines only); refused as previewFix. */
  adoptFix(passage: InPlacePassage, markdown: string): InPlaceFixPreview
}

/**
 * 「AI に直してもらう」's passage: the top-level blocks holding the selection or a comment's quote, as
 * the file holds them, and a little text around them (files-and-editor.md "Asking the AI to fix a passage").
 */
export interface InPlacePassage {
  /** The blocks' Markdown, byte for byte as in the file. */
  markdown: string
  /** Up to 600 characters before / after, cut at a line (never the `---` block). */
  before: string
  after: string
  /** Where it is and the file's text when it was taken: a later change makes it stale. */
  readonly at: { readonly nodeFrom: number; readonly nodeTo: number; readonly text: string }
}

/** What adopting a fix would write: the file's lines it replaces and adds. */
export type InPlaceFixPreview =
  | { ok: true; removed: string[]; added: string[] }
  /**
   * `changed`: the document changed since the passage was taken; `unwritable`: the fix cannot be written faithfully;
   * `html`: the fix brings raw HTML the passage did not have.
   */
  | { ok: false; reason: 'changed' | 'unwritable' | 'html' }

export type InPlaceOpening = { ok: true; surface: InPlaceSurface } | { ok: false; reason: InPlaceRefusal }

export interface InPlaceEngine {
  /** Shows `text` editable in `host`. A refusal leaves `host` empty and the file untouched. */
  open(host: HTMLElement, text: string, options: InPlaceOptions): Promise<InPlaceOpening>
}

let engine: Promise<InPlaceEngine> | null = null

/** The editor, loaded once; a failed load is tried again next time. */
export function loadInPlaceEngine(): Promise<InPlaceEngine> {
  engine ??= import('./milkdownSurface').then(m => m.milkdownEngine).catch(e => { engine = null; throw e })
  return engine
}

/** What the member is told when a document stays in the reading view. */
export const IN_PLACE_REFUSAL_TEXT: Record<InPlaceRefusal, string> = {
  unsupported: 'この文書には、ここでは直せない書き方（脚注など）があります。直すときは［もとの書き方で直す］を使ってください。',
  lossy: 'この文書には、ここで直すと崩れてしまう書き方があります。直すときは［もとの書き方で直す］を使ってください。',
  unreadable: 'この文書は、ここでは直せません。直すときは［もとの書き方で直す］を使ってください。',
  unavailable: '文章をその場で直す部品を読み込めませんでした。直すときは［もとの書き方で直す］を使ってください。',
}
