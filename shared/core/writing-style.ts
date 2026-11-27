/**
 * 「返事の下書きを、わたしの書き方に合わせる」 (owner decision 2026-11-28): the shape of a member's
 * writing-style summary (書き方のまとめ) and the rules every side applies to it. The core knows no tool:
 * a summary is kept per **connector id** (opaque: whatever connector supplied the member's sent messages)
 * × **audience** (身内 `inside` / よそ `outside`), at most one per pair.
 *
 * - The summary is made on the member's PC from their own newest sent messages (the connector hands
 *   them through the server, which keeps nothing), kept only on that PC, and handed to the member's own AI
 *   when it drafts a reply. It never holds a message's text: only the fields below.
 * - A pair with fewer than `WRITING_STYLE_MIN_SAMPLES` messages is not made; the other audience of the
 *   same connector stands in for it (`chooseWritingStyle`). Another connector never does (a chat's
 *   rhythm is not a mail's).
 * - Personal details (addresses, phone numbers, URLs, a person's name with an honorific) are dropped
 *   from every field (`writingStyleProblems` reads nothing as an instruction; `parseWritingStyle` drops
 *   what looks personal rather than refusing the whole summary).
 *
 * Pure: imports only shared/core (shared-core.md).
 */
import { findInstructionLikeText } from './instruction-like'

export type WritingAudience = 'inside' | 'outside'
export const WRITING_AUDIENCES: readonly WritingAudience[] = ['inside', 'outside']

/** How many of the member's newest sent messages per connector are read. */
export const WRITING_SAMPLES_MAX = 20
/** A summary for one audience is made only from at least this many of its messages. */
export const WRITING_STYLE_MIN_SAMPLES = 5
/** Each message's text handed to the summarizing AI is cut here. */
export const WRITING_SAMPLE_TEXT_MAX = 2000
/** A summary older than this is made again (owner: 「月1回ほど作り直す」). */
export const WRITING_STYLE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000

/** One sent message as a connector hands it (the text only of what the member wrote; quoted parts removed). */
export interface WritingSample {
  text: string
  /** When it was sent (ISO 8601), null when unknown. */
  at: string | null
  /** Whom it went to: everyone inside the company (身内) or anyone outside (よそ). */
  audience: WritingAudience
}

export const WRITING_LENGTHS = ['short', 'medium', 'long'] as const
export const WRITING_POLITENESS = ['casual', 'polite', 'formal'] as const
export const WRITING_EMOJI = ['none', 'sometimes', 'often'] as const
export type WritingLength = typeof WRITING_LENGTHS[number]
export type WritingPoliteness = typeof WRITING_POLITENESS[number]
export type WritingEmoji = typeof WRITING_EMOJI[number]

/** The summary: the same shape for every tool. */
export interface WritingStyle {
  /** How the member usually opens (「お疲れさまです。」), '' when none. */
  greeting: string
  /** How the member usually closes (「よろしくお願いします。」), '' when none. */
  closing: string
  sentenceLength: WritingLength
  politeness: WritingPoliteness
  /** Phrases the member uses often (≤ `WRITING_PHRASES_MAX`). */
  phrases: string[]
  emoji: WritingEmoji
  /** Other habits in one or two sentences (line breaks, bullet lists, …), '' when none. */
  notes: string
}

export const WRITING_LINE_MAX = 60
export const WRITING_PHRASE_MAX = 40
export const WRITING_PHRASES_MAX = 8
export const WRITING_NOTES_MAX = 200

/** A kept summary on this PC. */
export interface KeptWritingStyle {
  style: WritingStyle
  /** When it was made from messages (ISO 8601). */
  madeAt: string
  /** How many messages it was made from. */
  sampleCount: number
  /** The member changed it by hand since. */
  edited: boolean
}

/** Every kept summary of one member in one company: connector id → audience → summary. */
export type WritingStyleSet = Record<string, Partial<Record<WritingAudience, KeptWritingStyle>>>

const CONNECTOR_ID = /^[a-z][a-z0-9_-]{0,39}$/
/** Names an object already has (`constructor`…): never a key of a set, which is a plain object. */
const RESERVED_IDS = new Set(['constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof'])
export const isWritingConnectorId = (v: unknown): v is string => typeof v === 'string' && CONNECTOR_ID.test(v) && !RESERVED_IDS.has(v)
export const isWritingAudience = (v: unknown): v is WritingAudience => v === 'inside' || v === 'outside'

// Personal details a summary must never carry (owner: 相手の名前・住所などを入れない).
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const URL_RE = /(?:https?:\/\/|www\.)\S+/i
const PHONE = /(?:\+?\d[\d\s()-]{8,}\d)/
const POSTAL = /〒\s*\d|\b\d{3}-\d{4}\b/
const ADDRESS = /[都道府県市区町村]\S{0,8}\d+(?:丁目|番地?|号)/
// A name with an honorific: 「山田さん」「田中様」「Smith様」. Words for anyone (皆様, お客様, ご担当者様…) stay.
const HONORIFIC = /([\p{Script=Han}\p{Script=Katakana}ー々A-Za-z]{1,12})(さん|様|さま|殿|氏|くん|君|ちゃん|部長|課長|社長|係長|室長|専務|常務|先生)/gu
// The captured word has no hiragana, so 「お客様」 is seen as 「客」+様 and 「ご担当者様」 as 「担当者」+様.
const GENERIC_ADDRESSEES = ['皆', '客', '各位', '担当者', '担当', '先方', '得意', '関係者', '御中', '社長', '部長', '課長', '先生', '苦労', '世話', '仕', '同', '模', '異', '有', '一', '左', '右', '貴社', '御社', '当社', '弊社']

/** Whether a short text carries something personal (an address, a number, a person's name). */
export function looksPersonal(text: string): boolean {
  if (EMAIL.test(text) || URL_RE.test(text) || PHONE.test(text) || POSTAL.test(text) || ADDRESS.test(text)) return true
  for (const m of text.matchAll(HONORIFIC)) {
    const word = m[1]
    // A title alone (「部長」) is no one's name; 「山田部長」 is.
    if (!GENERIC_ADDRESSEES.includes(word)) return true
  }
  return false
}

/** Money and secrets are what a message said, never how the member writes. */
const NOT_A_HABIT = /振込|振り込|口座|送金|支払|請求|パスワード|暗証|カード番号/

/** One line: NFC, control and line-separator characters out, trimmed, cut. */
function line(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const s = v.normalize('NFC').replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(s).slice(0, max).join('')
}

/**
 * A text field kept only when it carries nothing personal and reads as no instruction (the summary is made from
 * messages that may hold someone else's words, and it is handed to the drafting AI: `findInstructionLikeText`).
 */
function safe(v: unknown, max: number): string {
  const s = line(v, max)
  return s && !looksPersonal(s) && !NOT_A_HABIT.test(s) && findInstructionLikeText(s).length === 0 ? s : ''
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list as readonly unknown[]).includes(v) ? v as T : fallback

/**
 * A summary from untrusted JSON (the AI's answer, a file on disk, the member's edit). Null when it is not
 * an object with the three choices; anything personal is dropped field by field, never kept.
 */
export function parseWritingStyle(raw: unknown): WritingStyle | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!(WRITING_LENGTHS as readonly unknown[]).includes(r.sentenceLength)) return null
  if (!(WRITING_POLITENESS as readonly unknown[]).includes(r.politeness)) return null
  if (!(WRITING_EMOJI as readonly unknown[]).includes(r.emoji)) return null
  const phrases: string[] = []
  for (const p of Array.isArray(r.phrases) ? r.phrases : []) {
    const s = safe(p, WRITING_PHRASE_MAX)
    if (s && !phrases.includes(s)) phrases.push(s)
    if (phrases.length >= WRITING_PHRASES_MAX) break
  }
  return {
    greeting: safe(r.greeting, WRITING_LINE_MAX),
    closing: safe(r.closing, WRITING_LINE_MAX),
    sentenceLength: oneOf(WRITING_LENGTHS, r.sentenceLength, 'medium'),
    politeness: oneOf(WRITING_POLITENESS, r.politeness, 'polite'),
    phrases,
    emoji: oneOf(WRITING_EMOJI, r.emoji, 'none'),
    notes: safe(r.notes, WRITING_NOTES_MAX),
  }
}

/** A kept summary from untrusted JSON (the file on disk); null when unusable. */
export function parseKeptWritingStyle(raw: unknown): KeptWritingStyle | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const style = parseWritingStyle(r.style)
  if (!style || typeof r.madeAt !== 'string' || !Number.isFinite(Date.parse(r.madeAt))) return null
  const count = typeof r.sampleCount === 'number' && Number.isInteger(r.sampleCount) && r.sampleCount >= 0 ? r.sampleCount : 0
  return { style, madeAt: r.madeAt, sampleCount: count, edited: r.edited === true }
}

/** Every kept summary of a set from untrusted JSON; unknown connectors, audiences and bad entries left out. */
export function parseWritingStyleSet(raw: unknown): WritingStyleSet {
  const out: WritingStyleSet = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [connectorId, byAudience] of Object.entries(raw as Record<string, unknown>)) {
    if (!isWritingConnectorId(connectorId) || !byAudience || typeof byAudience !== 'object') continue
    for (const audience of WRITING_AUDIENCES) {
      const kept = parseKeptWritingStyle((byAudience as Record<string, unknown>)[audience])
      if (kept) (out[connectorId] ??= {})[audience] = kept
    }
  }
  return out
}

/** Which audiences get a summary from these samples: only those with enough messages of their own. */
export function audiencesToSummarize(samples: readonly WritingSample[]): WritingAudience[] {
  return WRITING_AUDIENCES.filter(a => samples.filter(s => s.audience === a).length >= WRITING_STYLE_MIN_SAMPLES)
}

/**
 * The summary to hand the AI for a reply through `connectorId` to `audience`: that one, else the other
 * audience of the same connector standing in for it (`standIn: true`), else none. Another connector's
 * summary never stands in.
 */
export function chooseWritingStyle(set: WritingStyleSet, connectorId: string, audience: WritingAudience):
{ style: WritingStyle; audience: WritingAudience; standIn: boolean } | null {
  const byAudience = Object.prototype.hasOwnProperty.call(set, connectorId) ? set[connectorId] : undefined
  if (!byAudience) return null
  const own = byAudience[audience]
  if (own) return { style: own.style, audience, standIn: false }
  const other: WritingAudience = audience === 'inside' ? 'outside' : 'inside'
  const near = byAudience[other]
  return near ? { style: near.style, audience: other, standIn: true } : null
}

/** Whether a kept summary should be made again (older than a month, unless the member edited it). */
export function writingStyleStale(kept: KeptWritingStyle, nowMs: number): boolean {
  if (kept.edited) return false
  const made = Date.parse(kept.madeAt)
  return !Number.isFinite(made) || nowMs - made >= WRITING_STYLE_REFRESH_MS
}

/** The plain words of each choice (the settings screen and the AI read the same ones). */
export const WRITING_STYLE_WORDS = {
  audience: { inside: '社内の人あて', outside: '社外の人あて' } as Record<WritingAudience, string>,
  sentenceLength: { short: '短め', medium: 'ふつう', long: '長め' } as Record<WritingLength, string>,
  politeness: { casual: 'くだけた言い方', polite: 'です・ます', formal: 'ていねい（敬語が多め）' } as Record<WritingPoliteness, string>,
  emoji: { none: '使わない', sometimes: 'ときどき使う', often: 'よく使う' } as Record<WritingEmoji, string>,
} as const
