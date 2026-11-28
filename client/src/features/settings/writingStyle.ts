// 「返事の下書きを、わたしの書き方に合わせる」 on 「仕事の道具をつなぐ」 (writing-style.md): what the check says, how the
// member's summaries read, and the member's own correction of one field — checked here with the same rule the main
// process applies (`parseWritingStyle`), so a field that would be dropped is refused with words instead of vanishing.
// Pure: the screen and its tests use it. No tool is named here: the tools' names are the labels the server answered.
import {
  parseWritingStyle, WRITING_EMOJI, WRITING_LENGTHS, WRITING_POLITENESS, WRITING_STYLE_WORDS, WRITING_SAMPLES_MAX,
  type WritingAudience, type WritingStyle,
} from '../../../../shared/core/writing-style'
import type { WritingStyleEntry, WritingStyleStatus } from '../../../shared/writing-style'

export const WRITING_CHECK_LABEL = '返事の下書きを、わたしの書き方に合わせる'

/** The check's one line under it: what is read, what is made, where it stays. */
export function writingCheckHint(status: WritingStyleStatus): string {
  const labels = [...new Set(status.sources.map(s => s.label))]
  const from = labels.length > 0 ? `${labels.join('・')}で送ったメッセージ` : '送ったメッセージ'
  return `${from}の直近${WRITING_SAMPLES_MAX}件から、あいさつ・締め・よく使う言い回しなどの書き方を AI がまとめ、返事の下書きに使います。まとめはこの PC だけに置き、ほかの人には渡しません。`
}

/** Shown when the check is on but nothing can be read yet (the member has not allowed reading what arrives). */
export const WRITING_NOT_READABLE_TEXT = '送ったメッセージを読む許可がまだありません。設定の「AI に任せること」で「受信を読む」をオンにして、上の道具をつなぐと、まとめを作ります。'

/** The check is offered when at least one tool of the company could hand the member's sent messages. */
export const writingCheckOffered = (status: WritingStyleStatus | null): status is WritingStyleStatus =>
  status !== null && status.sources.length > 0

export type WritingTextField = 'greeting' | 'closing' | 'phrases' | 'notes'
export type WritingChoiceField = 'sentenceLength' | 'politeness' | 'emoji'

export const WRITING_FIELD_LABEL: Record<WritingTextField | WritingChoiceField, string> = {
  greeting: '書き出し', closing: '締め', sentenceLength: '文の長さ', politeness: '言い方', emoji: '絵文字', phrases: 'よく使う言い回し', notes: 'そのほか',
}

export const WRITING_CHOICES: { [F in WritingChoiceField]: { value: WritingStyle[F]; label: string }[] } = {
  sentenceLength: WRITING_LENGTHS.map(v => ({ value: v, label: WRITING_STYLE_WORDS.sentenceLength[v] })),
  politeness: WRITING_POLITENESS.map(v => ({ value: v, label: WRITING_STYLE_WORDS.politeness[v] })),
  emoji: WRITING_EMOJI.map(v => ({ value: v, label: WRITING_STYLE_WORDS.emoji[v] })),
}

/** The phrases shown and typed as one line, 「／」 between them. */
const PHRASE_SEPARATOR = '／'

/** A text field as the member reads it and edits it. */
export function writingFieldText(style: WritingStyle, field: WritingTextField): string {
  return field === 'phrases' ? style.phrases.join(PHRASE_SEPARATOR) : style[field]
}

export const WRITING_DROPPED_TEXT = '名前・連絡先・住所やお金の話、指示のような文は、まとめに入れられません。'

/**
 * The summary with one text field changed as the member typed it, checked like the AI's answer: `problem` when the
 * rule would drop (part of) what they typed — nothing is sent then.
 */
export function withWritingText(style: WritingStyle, field: WritingTextField, typed: string): { style: WritingStyle } | { problem: string } {
  const text = typed.trim()
  const raw = field === 'phrases'
    ? { ...style, phrases: text === '' ? [] : text.split(/[／/、,]/).map(p => p.trim()).filter(p => p !== '') }
    : { ...style, [field]: text }
  const checked = parseWritingStyle(raw)
  if (!checked) return { problem: WRITING_DROPPED_TEXT }
  const asked = field === 'phrases' ? raw.phrases as string[] : [text]
  const kept = field === 'phrases' ? checked.phrases : [checked[field]].filter(s => s !== '')
  if (kept.length < asked.filter(s => s !== '').length) return { problem: WRITING_DROPPED_TEXT }
  return { style: checked }
}

export function withWritingChoice<F extends WritingChoiceField>(style: WritingStyle, field: F, value: WritingStyle[F]): WritingStyle | null {
  return parseWritingStyle({ ...style, [field]: value })
}

export interface WritingEntryView {
  key: string
  connectorId: string
  audience: WritingAudience
  /** 「<the label>・社内の人あて」 */
  title: string
  /** 「12件から作りました」, 「あなたが直しました」 */
  meta: string
  style: WritingStyle
}

export function writingEntriesView(entries: readonly WritingStyleEntry[]): WritingEntryView[] {
  return entries.map(e => ({
    key: `${e.connectorId}:${e.audience}`,
    connectorId: e.connectorId,
    audience: e.audience,
    title: `${e.label}・${WRITING_STYLE_WORDS.audience[e.audience]}`,
    meta: e.kept.edited ? 'あなたが直したまとめです' : `送ったメッセージ ${e.kept.sampleCount} 件から作りました`,
    style: e.kept.style,
  }))
}

/** What the section says under the check (null: nothing). */
export function writingStatusLine(status: WritingStyleStatus): string | null {
  if (!status.enabled) return null
  if (status.building) return '書き方をまとめています…（少しかかります）'
  if (!status.available) return WRITING_NOT_READABLE_TEXT
  if (status.note) return status.note
  return status.styles.length === 0 ? '送ったメッセージが少ないため、まだまとめがありません。' : null
}
