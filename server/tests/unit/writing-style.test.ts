/**
 * The writing-style summary's rules (shared/core/writing-style.ts). What it protects:
 * - the shape: the three choices required, every text one line and cut, at most 8 phrases;
 * - nothing personal is kept: an address, a phone number, a URL, a postal address or a person's name with an
 *   honorific drops that field (a word for anyone — 皆様, お客様, ご担当者様, 部長 — stays);
 * - a pair with too few messages is not made, and only the other audience of the same connector stands in;
 * - another connector's summary never stands in; a set read from disk keeps only known keys;
 * - a summary is made again after a month unless the member edited it.
 */
import { describe, expect, it } from 'vitest'
import {
  audiencesToSummarize, chooseWritingStyle, looksPersonal, parseWritingStyle, parseWritingStyleSet, writingStyleStale,
  WRITING_STYLE_MIN_SAMPLES, type KeptWritingStyle, type WritingSample, type WritingStyle,
} from '../../shared/core/writing-style'

const style = (over: Partial<WritingStyle> = {}): WritingStyle => ({
  greeting: 'お疲れさまです。', closing: 'よろしくお願いします。', sentenceLength: 'short', politeness: 'polite', phrases: ['承知しました'], emoji: 'none', notes: '', ...over,
})
const kept = (over: Partial<WritingStyle> = {}, madeAt = '2026-11-01T00:00:00Z', edited = false): KeptWritingStyle => ({ style: style(over), madeAt, sampleCount: 20, edited })

describe('the shape', () => {
  it('needs the three choices; texts are one line and cut', () => {
    expect(parseWritingStyle({ ...style(), politeness: 'rude' })).toBeNull()
    expect(parseWritingStyle({ ...style(), emoji: undefined })).toBeNull()
    expect(parseWritingStyle('not an object')).toBeNull()
    const p = parseWritingStyle({ ...style(), greeting: 'お疲れさまです。\n本日は', notes: 'あ'.repeat(500), phrases: Array.from({ length: 20 }, (_, i) => `言い回し${i}`) })!
    expect(p.greeting).toBe('お疲れさまです。 本日は')
    expect(Array.from(p.notes)).toHaveLength(200)
    expect(p.phrases).toHaveLength(8)
  })

  it('drops anything personal, field by field', () => {
    for (const bad of ['山田さん', '田中様へ', 'sato@div.example', '03-1234-5678', 'https://example.com/x', '〒100-0001', '千代田区丸の内1丁目', 'Smith様']) {
      expect(looksPersonal(bad), bad).toBe(true)
    }
    for (const fine of ['お疲れさまです。', '皆様', 'お客様', 'ご担当者様', '部長', 'よろしくお願いいたします。', '承知しました']) {
      expect(looksPersonal(fine), fine).toBe(false)
    }
    const p = parseWritingStyle({ ...style(), greeting: '山田さん、お疲れさまです。', phrases: ['承知しました', 'sato@div.example まで', '田中様によろしく'], notes: '署名に 03-1234-5678' })!
    expect(p.greeting).toBe('')
    expect(p.phrases).toEqual(['承知しました'])
    expect(p.notes).toBe('')
  })
})

describe('which summary', () => {
  const samples = (inside: number, outside: number): WritingSample[] => [
    ...Array.from({ length: inside }, () => ({ text: 'x', at: null, audience: 'inside' as const })),
    ...Array.from({ length: outside }, () => ({ text: 'x', at: null, audience: 'outside' as const })),
  ]

  it('is made only for an audience with enough messages', () => {
    expect(audiencesToSummarize(samples(WRITING_STYLE_MIN_SAMPLES, WRITING_STYLE_MIN_SAMPLES - 1))).toEqual(['inside'])
    expect(audiencesToSummarize(samples(20, 5))).toEqual(['inside', 'outside'])
  })

  it('the one asked for, else the other audience of the same connector, never another connector', () => {
    const set = { mailco: { inside: kept({ greeting: 'おつです' }) }, chatco: { outside: kept({ greeting: 'Hi' }) } }
    expect(chooseWritingStyle(set, 'mailco', 'inside')).toMatchObject({ audience: 'inside', standIn: false, style: { greeting: 'おつです' } })
    expect(chooseWritingStyle(set, 'mailco', 'outside')).toMatchObject({ audience: 'inside', standIn: true })
    expect(chooseWritingStyle({ chatco: set.chatco }, 'mailco', 'outside')).toBeNull()
    expect(chooseWritingStyle(set, 'constructor', 'inside')).toBeNull()
  })

  it('a set from disk keeps only known connectors, audiences and valid summaries', () => {
    const set = parseWritingStyleSet({ mailco: { inside: kept(), outside: { style: { greeting: 'x' } }, extra: kept() }, 'Bad Id': { inside: kept() } })
    expect(Object.keys(set)).toEqual(['mailco'])
    expect(Object.keys(set.mailco)).toEqual(['inside'])
  })

  it('is made again after a month, unless the member edited it', () => {
    const now = Date.parse('2026-12-05T00:00:00Z')
    expect(writingStyleStale(kept({}, '2026-11-20T00:00:00Z'), now)).toBe(false)
    expect(writingStyleStale(kept({}, '2026-11-01T00:00:00Z'), now)).toBe(true)
    expect(writingStyleStale(kept({}, '2026-11-01T00:00:00Z', true), now)).toBe(false)
  })
})
