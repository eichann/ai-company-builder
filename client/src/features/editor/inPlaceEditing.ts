// The small door to editing a Markdown document in place (files-and-editor.md "Editing a document
// in place"): a document goes in, the file's new text comes out after each change. Which editor
// draws it (Milkdown today) and how only the changed part is written back (markdownSplice.ts) stay
// behind this door, so the parts can be replaced without the screen changing. The editor is
// loaded only when a document is first shown this way (it is ~440 KB; dist/vendor/).
import type { InPlaceRefusal } from './markdownSplice'

export type { InPlaceRefusal }

export interface InPlaceOptions {
  /** The document's folder: relative image addresses are read from there. */
  folder: string
  /** The file's whole new text after a change the editor could write back. */
  onChange(text: string): void
  /** A change that could not be written back faithfully was taken back on screen (nothing written). */
  onChangeTakenBack(): void
}

export interface InPlaceSurface {
  destroy(): void
  focus(): void
}

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
