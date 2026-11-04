/**
 * Reading a Doc's body from the Docs API (minutes.md "The text"): nothing the AI needs is dropped
 * (Gemini's notes hold tables and keep the transcript in a tab).
 */
import { describe, expect, it } from 'vitest'
import {
  GOOGLE_ALLOWED_SCOPES, GOOGLE_FEATURES, GOOGLE_NEVER_SCOPES, GOOGLE_SCOPE, googleFeatureOfScope, googleFeaturesOf, googleFeaturesToRenew, googleScopesFor,
} from '../../../shared/core/google'
import { docsBodyText } from '../../src/services/google-docs-text'
import { createGoogleMeetings } from '../../src/services/google-meetings'
import type { GoogleRequest, GoogleResult } from '../../src/services/google-client'

const p = (text: string, extra: object = {}) => ({ paragraph: { elements: [{ textRun: { content: text } }], ...extra } })
const cell = (text: string) => ({ content: [p(`${text}\n`)] })
const tab = (title: string, content: unknown[], childTabs: unknown[] = []) => ({ tabProperties: { title }, documentTab: { body: { content } }, childTabs })

describe('docsBodyText', () => {
  it('keeps headings, list items, smart chips and tables, in order', () => {
    const text = docsBodyText({ tabs: [tab('タブ 1', [
      { sectionBreak: {} },
      p('決めたこと\n', { paragraphStyle: { namedStyleType: 'HEADING_1' } }),
      p('見積もりを出す\n', { bullet: { listId: 'l' } }),
      { paragraph: { elements: [{ person: { personProperties: { name: '田中 誠' } } }, { textRun: { content: ' が担当\n' } }] } },
      { table: { tableRows: [{ tableCells: [cell('担当'), cell('期限')] }, { tableCells: [cell('佐藤'), cell('金曜')] }] } },
    ])] })
    expect(text).toBe('決めたこと\n・見積もりを出す\n田中 誠 が担当\n担当\t期限\n佐藤\t金曜\n')
  })

  it('reads every tab, child tabs too, each under its name; an empty tab adds nothing', () => {
    const text = docsBodyText({ tabs: [tab('メモ', [p('要点\n')], [tab('詳細', [p('補足\n')])]), tab('文字起こし', [p('発言\n')]), tab('空', [p('\n')])] })
    expect(text).toBe('【メモ】\n要点\n\n【詳細】\n補足\n\n【文字起こし】\n発言\n')
  })

  it('reads an answer without tabs, and gives nothing for anything else', () => {
    expect(docsBodyText({ body: { content: [p('本文\n')] } })).toBe('本文\n')
    expect(docsBodyText(null)).toBe('')
  })
})

describe('docText: which way a document is read', () => {
  const answer = (json: unknown): GoogleResult => ({ ok: true, status: 200, json, text: null } as GoogleResult)
  const body = (text: string) => ({ tabs: [tab('タブ 1', [p(text)])] })
  function reader(file: unknown, docs: GoogleResult = answer(body('本文\n'))) {
    const asked: string[] = []
    const meetings = createGoogleMeetings(async (_c, _u, req: GoogleRequest) => {
      asked.push(req.operation)
      if (req.operation === 'drive.files.get') return answer(file)
      if (req.operation === 'docs.documents.get') return docs
      return { ok: true, status: 200, json: null, text: '書き出し' } as GoogleResult
    })
    return { asked, read: (max?: number) => meetings.docText('co', 'u', 'doc1', max) }
  }

  it('respects the length asked for', async () => {
    const r = await reader({ copyRequiresWriterPermission: false }, answer(body(`${'あ'.repeat(500)}\n`))).read(100)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(100)
  })

  it('a writer of a copy-blocked document may read it: the block is for readers and commenters', async () => {
    const r = reader({ copyRequiresWriterPermission: true, capabilities: { canDownload: true } })
    expect((await r.read()).text).toContain('本文')
  })

  it('Drive not saying whether copying is blocked: never the Docs API on a guess, the export decides', async () => {
    const r = reader({})
    expect((await r.read()).text).toBe('書き出し')
    expect(r.asked).not.toContain('docs.documents.get')
  })

  it('a document with no text in the Docs API, one too big for an answer, or no scope: the export', async () => {
    for (const docs of [
      answer(body('\n')),
      { ok: false, kind: 'server-error', reason: 'answer-too-large' },
      { ok: false, kind: 'not-sent', reason: 'scope-not-granted' },
    ] as GoogleResult[]) expect((await reader({ copyRequiresWriterPermission: false }, docs).read()).text).toBe('書き出し')
  })

  it('Google asking to wait stops here rather than reading less: it is tried again later', async () => {
    const busy = { ok: false, kind: 'rate-limited', reason: 'rate-limited' } as GoogleResult
    await expect(reader({ copyRequiresWriterPermission: false }, busy).read()).rejects.toThrow()
  })
})

describe('documents.readonly in the 議事録 feature', () => {
  const OLD = [GOOGLE_SCOPE.calendarEventsReadonly, GOOGLE_SCOPE.meetReadonly, GOOGLE_SCOPE.driveMeetReadonly]

  it('a grant made before it keeps the feature, and only that grant is offered to allow again', () => {
    expect(googleFeaturesOf(OLD)).toEqual(['minutes'])
    expect(googleFeaturesToRenew(OLD)).toEqual(['minutes'])
    expect(googleFeaturesToRenew([...OLD, GOOGLE_SCOPE.documentsReadonly])).toEqual([])
    expect(googleFeaturesToRenew([GOOGLE_SCOPE.gmailSend])).toEqual([])
  })

  it('alone it gives no feature, and it is asked with 議事録 only: no other feature widens', () => {
    expect(googleFeaturesOf([GOOGLE_SCOPE.documentsReadonly])).toEqual([])
    expect(googleScopesFor(['minutes'])).toContain(GOOGLE_SCOPE.documentsReadonly)
    for (const f of GOOGLE_FEATURES.filter(x => x !== 'minutes')) expect(googleScopesFor([f])).not.toContain(GOOGLE_SCOPE.documentsReadonly)
    // The member's and the company's 議事録 switches reach it (google-client.ts scopeStop).
    expect(googleFeatureOfScope(GOOGLE_SCOPE.documentsReadonly)).toBe('minutes')
  })

  it('drive.readonly stays out', () => {
    expect(GOOGLE_NEVER_SCOPES).toContain('https://www.googleapis.com/auth/drive.readonly')
    expect(GOOGLE_ALLOWED_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly')
  })
})
