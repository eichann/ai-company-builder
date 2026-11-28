// The 「/」 list's choices (files-and-editor.md "The 「/」 list, line starts and the table bar"):
// what a line can become, how the member finds it by typing, and the Markdown it is written as
// (the hint). Pure, so the screen and the editor behind the door read the one list.

/** What a line can become. Each is a Markdown block, so the file keeps it. */
export type InPlaceBlock = 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code' | 'divider' | 'table'

export interface BlockChoice {
  block: InPlaceBlock
  label: string
  /** The line start that makes the same block (shown beside the name). */
  hint: string
  /** Words that find it (matched from their start), besides its name. */
  words: readonly string[]
}

export const BLOCK_CHOICES: readonly BlockChoice[] = [
  { block: 'heading1', label: '見出し1', hint: '# ', words: ['見出し', 'みだし', 'h1', 'heading'] },
  { block: 'heading2', label: '見出し2', hint: '## ', words: ['見出し', 'みだし', 'h2', 'heading'] },
  { block: 'heading3', label: '見出し3', hint: '### ', words: ['見出し', 'みだし', 'h3', 'heading'] },
  { block: 'bullet', label: '箇条書き', hint: '- ', words: ['箇条書き', 'かじょうがき', 'リスト', 'list', 'bullet'] },
  { block: 'ordered', label: '番号つきの箇条書き', hint: '1. ', words: ['番号', 'ばんごう', 'リスト', 'list', 'number'] },
  { block: 'task', label: 'チェックリスト', hint: '[] ', words: ['チェック', 'ちぇっく', 'やること', 'todo', 'task', 'check'] },
  { block: 'quote', label: '引用', hint: '> ', words: ['引用', 'いんよう', 'quote'] },
  { block: 'code', label: 'コード', hint: '```', words: ['コード', 'こーど', 'code'] },
  { block: 'divider', label: '区切り線', hint: '---', words: ['区切り', 'くぎり', '線', 'せん', 'divider', 'hr'] },
  { block: 'table', label: '表', hint: '3×3', words: ['表', 'ひょう', 'テーブル', 'table'] },
]

/** The choices a query finds, in the list's order (an empty query: all of them). */
export function matchBlockChoices(query: string): InPlaceBlock[] {
  const q = query.trim().toLowerCase()
  return BLOCK_CHOICES
    .filter(c => !q || c.label.toLowerCase().includes(q) || c.words.some(w => w.toLowerCase().startsWith(q)))
    .map(c => c.block)
}
