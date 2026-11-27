/**
 * A Skill's draft made from a member's own 「ブラウザ操作」 recordings (agent-browser.md "A Skill's draft from a recording",
 * PR 2 of 4; owner decisions D1, D2, D5, D9 of the design memo 「記録からSkillの下書き」). **The server is the authority**:
 *
 * - **Whose**: a draft is its author's alone — listed, read, changed and deleted only by the member who made it, while a
 *   member this time (made at or after their current membership). Anyone else, owners and admins included, another
 *   company's id and a draft past its 30 days get the same 404 as one that never existed (D9). Every repository method
 *   takes the author: there is no way to name another person's draft.
 * - **What the AI may read** (I1, D1): the draft and the recordings it was made from — only the author's own recordings,
 *   sent while a member this time and still kept, in the stored kept form (no value). A recording someone else sent (an
 *   owner's AI included) never reaches an answer here: the owner / admin's reading of every recording stays the admin
 *   console's (`GET /browser-recordings`), which no AI tool calls.
 * - **The frame never widens** (I2, I6): `base_declaration` is what `browserSkillDraftFrom` made from recordings the server
 *   stored itself (fixed by trigger); a change of `declaration` is taken only when `browserSkillDraftCoveredProblem` says
 *   it is no wider (no DELETE, no path beginning with a placeholder, one budget per recorded target).
 * - **Made when a recording is sent** (`makeOnSend`, inside the recording's own transaction, in a savepoint: a failure
 *   keeps the recording without a draft) when it holds a write the rule keeps; or again from 1–5 of the author's own
 *   recordings of one domain (`create`), **replacing** one of the author's drafts when asked (`replaces`): the work split
 *   over two recordings becomes one draft without adding one.
 * - **At most 10 per person** (D5); each goes 30 days after its last change (`delete_at`; every read leaves it out, the
 *   server clock deletes it). Not in a company archive.
 * - **Every change is a compare-and-set on the version** (`expectedVersion`): the AI and the screen changing it at the same
 *   time — the later one gets 409 and reads again.
 */
import type { BrowserRecordingContent } from '../../shared/core/browser-recording'
import { browserSkillDraftCoveredProblem, browserSkillDraftFrom, BROWSER_SKILL_DRAFT_LIMITS, BROWSER_SKILL_DRAFT_WORDS, type BrowserSkillDraft, type BrowserSkillDraftRefusal } from '../../shared/core/browser-skill-draft'
import { parseBrowserSkillDeclaration } from '../../shared/core/browser-skill'
import { isValidSkillName } from '../../shared/core/names'
import { canonicalJson } from '../../shared/core/fixed-content'
import type {
  BrowserSkillDraftDetail, BrowserSkillDraftNotes, BrowserSkillDraftsList, BrowserSkillDraftSource, BrowserSkillDraftSummary,
} from '../../shared/types/browser-skill-drafts'
import { hashCanonical } from '../lib/content-hash'
import type { BrowserSkillDraftRepository, BrowserSkillDraftRow } from '../ports/browser-skill-drafts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import type { Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserSkillDraftDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  transactions: Transactions
  memberships: Pick<MembershipRepository, 'joinedAt'>
}

export const BROWSER_SKILL_DRAFT_SERVER_LIMITS = Object.freeze({
  /** Drafts one member keeps in a company at once (D5). */
  perMember: 10,
  /** A draft goes this many days after its last change (D5). */
  days: 30,
  /** `SKILL.md` (UTF-8 bytes). */
  stepsBytes: 32 * 1024,
  /** Skill names (the name rule's own limit is the folder's; a draft's stays short). */
  name: 64,
})
const L = BROWSER_SKILL_DRAFT_SERVER_LIMITS

export const BROWSER_SKILL_DRAFT_SERVER_WORDS = Object.freeze({
  notFound: 'この下書きは見つかりません（消されたか、30日が過ぎました）。',
  badBody: '頼み方の形が正しくありません。',
  recordingNotFound: '指定した記録が見つかりません（あなたが送った記録で、30日以内のものだけを使えます）。',
  tooMany: `下書きは、ひとり${L.perMember}件までです。要らない下書きを消すよう AI に頼むか、30日たつと消えます。`,
  failed: '下書きは作れませんでした。あとで相談の AI に、この記録から下書きを作り直すよう頼めます。',
  changed: '下書きが、ほかの所で直されました。読み直してから、もう一度直してください。',
  badName: `名前は、半角の小文字・数字・「-」「_」で、${L.name}字までにしてください（先頭は小文字か数字）。`,
  nameTaken: '同じ名前の下書きが、もうあります。別の名前にしてください。',
  stepsTooLarge: '手順書（SKILL.md）が長すぎます（32KB まで）。',
  badDeclaration: 'browser.yaml の形が決まりに合っていません。',
  wider: 'browser.yaml は、記録から作った範囲より広げられません（狭める直しだけができます）。',
  nothing: '直すもの（name・declaration・steps のどれか）がありません。',
  noDraft: (refusal: BrowserSkillDraftRefusal) => `下書きは作りませんでした（${BROWSER_SKILL_DRAFT_WORDS.refusals[refusal]}）`,
  made: 'Skill の下書きができました。相談に戻って、AI に「記録を送った」と伝えてください。',
})
const W = BROWSER_SKILL_DRAFT_SERVER_WORDS

const DAY_MS = 24 * 60 * 60 * 1000
const DRAFT_ID_RE = /^bd_[0-9a-f]{32}$/
const RECORDING_ID_RE = /^br_[0-9a-f]{32}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const iso = (ms: number) => new Date(ms).toISOString()
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** A draft's name: the Skill name rule, short. */
export const isDraftName = (v: unknown): v is string => typeof v === 'string' && v.length <= L.name && isValidSkillName(v)

/** The version: what the author can change, as one canonical text. */
export const draftVersion = (d: { name: string; declaration: string; steps: string }) =>
  hashCanonical(canonicalJson({ name: d.name, declaration: d.declaration, steps: d.steps }))

/** What `makeOnSend` answers: the draft's id, or none with the reason in plain Japanese. */
export type DraftOnSend = { draftId: string; note: string } | { draftId: null; note: string }

export function createBrowserSkillDraftService(deps: BrowserSkillDraftDeps) {
  const drafts = (companyId: string): BrowserSkillDraftRepository => deps.companyData.forCompany(companyId).browserSkillDrafts
  const missing = (): Refusal => refuse('not-found', W.notFound, { code: 'BROWSER_SKILL_DRAFT_NOT_FOUND' })
  const bad = (): Refusal => refuse('bad-request', W.badBody, { code: 'BROWSER_SKILL_DRAFT_BAD' })
  const now = () => iso(deps.clock.nowMs())
  /** The author's current membership began then (null: not a member). */
  const sinceOf = (member: Member) => deps.memberships.joinedAt(member.companyId, member.userId)

  /** The author's own recording, sent while a member this time, still kept (I1). Anyone else's is never read. */
  function ownRecording(member: Member, id: string, since: string, at: string): BrowserSkillDraftSource | null {
    if (!RECORDING_ID_RE.test(id)) return null
    const row = deps.companyData.forCompany(member.companyId).browserRecordings.byId(id, at)
    if (!row || row.userId !== member.userId || row.createdAt < since) return null
    try {
      return { id: row.id, createdAt: row.createdAt, content: JSON.parse(row.content) as BrowserRecordingContent }
    } catch {
      return null
    }
  }

  const notesOf = (d: BrowserSkillDraft): BrowserSkillDraftNotes => ({
    writes: d.writes.map(w => ({ write: w.write, marks: [...w.marks], idFields: [...w.idFields] })),
    leftOut: d.leftOut.map(l => ({ ...l })),
  })

  const summary = (r: BrowserSkillDraftRow): BrowserSkillDraftSummary => ({
    id: r.id, name: r.name, domain: r.domain, recordingIds: JSON.parse(r.recordingIds) as string[], version: r.version,
    triedVersion: r.triedVersion, createdAt: r.createdAt, updatedAt: r.updatedAt, deleteAt: r.deleteAt,
  })

  function detail(member: Member, r: BrowserSkillDraftRow, since: string, at: string): BrowserSkillDraftDetail {
    const s = summary(r)
    const sources = s.recordingIds.flatMap(id => ownRecording(member, id, since, at) ?? [])
    return {
      ...s, baseDeclaration: r.baseDeclaration, notes: JSON.parse(r.baseNotes) as BrowserSkillDraftNotes,
      declaration: r.declaration, steps: r.steps, sources,
    }
  }

  /**
   * A new draft from recordings already checked to be the author's own (in the order given), or why none is made. Called
   * inside a transaction (the count, the name and the insert together).
   */
  function insertFrom(member: Member, since: string, sources: ReadonlyArray<{ id: string; content: BrowserRecordingContent }>, name: string | null, atMs: number, replaces: string | null = null): Outcome<BrowserSkillDraftRow> {
    const at = iso(atMs)
    const made = browserSkillDraftFrom(sources.map(s => s.content))
    if (!made.ok) return refuse('conflict', W.noDraft(made.refusal), { code: 'BROWSER_SKILL_DRAFT_NONE', refusal: made.refusal })
    const repo = drafts(member.companyId)
    // The draft it replaces is gone once this one is in: it neither counts nor holds its name.
    if (repo.countOf(member.userId, at, since) - (replaces ? 1 : 0) >= L.perMember) return refuse('conflict', W.tooMany, { code: 'BROWSER_SKILL_DRAFT_LIMIT' })
    const id = `bd_${deps.ids.newToken().slice(0, 32)}`
    const draftName = name ?? `draft-${id.slice(3, 9)}`
    if (repo.nameTaken(member.userId, draftName, at, since, replaces)) return refuse('conflict', W.nameTaken, { code: 'BROWSER_SKILL_DRAFT_NAME_TAKEN' })
    const row: BrowserSkillDraftRow = {
      id, userId: member.userId, name: draftName, domain: made.draft.declaration.domain,
      recordingIds: JSON.stringify(sources.map(s => s.id)), baseDeclaration: made.draft.text, baseNotes: JSON.stringify(notesOf(made.draft)),
      declaration: made.draft.text, steps: '', version: draftVersion({ name: draftName, declaration: made.draft.text, steps: '' }), triedVersion: null,
      createdAt: at, updatedAt: at, deleteAt: iso(atMs + L.days * DAY_MS),
    }
    repo.insert(row)
    if (replaces) repo.delete(member.userId, replaces)
    return ok(row)
  }

  return {
    /**
     * Inside `POST /browser-recordings`' transaction, right after the recording is stored: a draft from it alone when it
     * holds a write the rule keeps and the author has room (never a refusal of the send: the recording is the company's
     * too — the admins read it — so it is kept either way, and the answer says why no draft was made).
     */
    makeOnSend(member: Member, recording: { id: string; content: BrowserRecordingContent; createdAtMs: number }): DraftOnSend {
      const since = sinceOf(member)
      if (since === null) return { draftId: null, note: W.notFound }
      const made = insertFrom(member, since, [{ id: recording.id, content: recording.content }], null, recording.createdAtMs)
      return made.ok ? { draftId: made.value.id, note: W.made } : { draftId: null, note: String(made.body.error) }
    },

    /** GET /browser-skill-drafts: the author's own drafts and own recordings still kept (to choose from for `create`). */
    list(member: Member): Outcome<BrowserSkillDraftsList> {
      const since = sinceOf(member)
      if (since === null) return ok({ drafts: [], recordings: [] })
      const at = now()
      const rows = deps.companyData.forCompany(member.companyId).browserRecordings.list(at, 200, { userId: member.userId, since })
      return ok({
        drafts: drafts(member.companyId).list(member.userId, at, since).map(summary),
        recordings: rows.map(r => ({ id: r.id, domain: r.domain, lines: r.lines, createdAt: r.createdAt })),
      })
    },

    /**
     * POST /browser-skill-drafts { recordingIds, name?, replaces? }: a new draft from 1–5 of the author's own recordings (in
     * the order sent); with `replaces` (one of the author's own drafts) that draft goes in the same transaction.
     */
    create(member: Member, body: unknown): Outcome<BrowserSkillDraftDetail> {
      if (!isMap(body) || !Object.keys(body).every(k => k === 'recordingIds' || k === 'name' || k === 'replaces')) return bad()
      if (body.replaces !== undefined && (typeof body.replaces !== 'string' || !DRAFT_ID_RE.test(body.replaces))) return bad()
      const ids = body.recordingIds
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > BROWSER_SKILL_DRAFT_LIMITS.recordings
        || !ids.every(id => typeof id === 'string') || new Set(ids).size !== ids.length) return bad()
      if (body.name !== undefined && !isDraftName(body.name)) return refuse('bad-request', W.badName, { code: 'BROWSER_SKILL_DRAFT_BAD_NAME' })
      const since = sinceOf(member)
      if (since === null) return refuse('not-found', W.recordingNotFound, { code: 'BROWSER_RECORDING_NOT_FOUND' })
      return deps.transactions.run((): Outcome<BrowserSkillDraftDetail> => {
        const atMs = deps.clock.nowMs()
        const at = iso(atMs)
        const sources: BrowserSkillDraftSource[] = []
        for (const id of ids as string[]) {
          const s = ownRecording(member, id, since, at)
          // Another person's recording is the same answer as one that does not exist (I1).
          if (!s) return refuse('not-found', W.recordingNotFound, { code: 'BROWSER_RECORDING_NOT_FOUND' })
          sources.push(s)
        }
        const replaces = (body.replaces as string | undefined) ?? null
        // Only one of the author's own drafts can be replaced; anyone else's is the same answer as none.
        if (replaces && !drafts(member.companyId).byId(member.userId, replaces, at, since)) return missing()
        const made = insertFrom(member, since, sources, (body.name as string | undefined) ?? null, atMs, replaces)
        if (!made.ok) return made
        return ok(detail(member, made.value, since, at))
      })
    },

    /** GET /browser-skill-drafts/:draftId: the author's own draft with its own recordings (kept form). */
    get(member: Member, draftId: string): Outcome<BrowserSkillDraftDetail> {
      if (!DRAFT_ID_RE.test(draftId)) return missing()
      const since = sinceOf(member)
      if (since === null) return missing()
      const at = now()
      const row = drafts(member.companyId).byId(member.userId, draftId, at, since)
      return row ? ok(detail(member, row, since, at)) : missing()
    },

    /**
     * PUT /browser-skill-drafts/:draftId { expectedVersion, name?, declaration?, steps? }: the author's change. A
     * declaration is taken only when it parses and is no wider than what the recordings gave (I2, I6). The version must be
     * the one the author read (409 with the current one otherwise).
     */
    save(member: Member, draftId: string, body: unknown): Outcome<BrowserSkillDraftDetail> {
      if (!DRAFT_ID_RE.test(draftId)) return missing()
      const since = sinceOf(member)
      if (since === null) return missing()
      const found = drafts(member.companyId).byId(member.userId, draftId, now(), since)
      if (!found) return missing()
      const allowed = ['expectedVersion', 'name', 'declaration', 'steps']
      if (!isMap(body) || !Object.keys(body).every(k => allowed.includes(k)) || typeof body.expectedVersion !== 'string' || !HASH_RE.test(body.expectedVersion)) return bad()
      if (body.name === undefined && body.declaration === undefined && body.steps === undefined) return refuse('bad-request', W.nothing, { code: 'BROWSER_SKILL_DRAFT_BAD' })
      if (body.name !== undefined && !isDraftName(body.name)) return refuse('bad-request', W.badName, { code: 'BROWSER_SKILL_DRAFT_BAD_NAME' })
      if (body.steps !== undefined && typeof body.steps !== 'string') return bad()
      if (typeof body.steps === 'string' && utf8Bytes(body.steps) > L.stepsBytes) return refuse('bad-request', W.stepsTooLarge, { code: 'BROWSER_SKILL_DRAFT_TOO_LARGE' })
      if (body.declaration !== undefined) {
        if (typeof body.declaration !== 'string') return bad()
        const parsed = parseBrowserSkillDeclaration(body.declaration)
        if (!parsed.ok) return refuse('bad-request', W.badDeclaration, { code: 'BROWSER_SKILL_DRAFT_BAD_DECLARATION', problem: parsed.problem })
        const base = parseBrowserSkillDeclaration(found.baseDeclaration)
        // The base always parses (the rule checked its own text before it was stored); if it ever does not, nothing is widened.
        const wider = base.ok ? browserSkillDraftCoveredProblem(parsed.declaration, base.declaration) : { problem: 'not-covered' as const, write: null }
        if (wider) return refuse('bad-request', W.wider, { code: 'BROWSER_SKILL_DRAFT_WIDER', problem: wider.problem, write: wider.write })
      }
      return deps.transactions.run((): Outcome<BrowserSkillDraftDetail> => {
        const atMs = deps.clock.nowMs()
        const at = iso(atMs)
        const repo = drafts(member.companyId)
        const row = repo.byId(member.userId, draftId, at, since)
        if (!row) return missing()
        if (row.version !== body.expectedVersion) return refuse('conflict', W.changed, { code: 'BROWSER_SKILL_DRAFT_CHANGED', version: row.version })
        const next = {
          name: (body.name as string | undefined) ?? row.name,
          declaration: (body.declaration as string | undefined) ?? row.declaration,
          steps: (body.steps as string | undefined) ?? row.steps,
        }
        if (next.name !== row.name && repo.nameTaken(member.userId, next.name, at, since, row.id)) return refuse('conflict', W.nameTaken, { code: 'BROWSER_SKILL_DRAFT_NAME_TAKEN' })
        const change = { ...next, version: draftVersion(next), updatedAt: at, deleteAt: iso(atMs + L.days * DAY_MS) }
        if (!repo.change(member.userId, row.id, row.version, change)) return refuse('conflict', W.changed, { code: 'BROWSER_SKILL_DRAFT_CHANGED', version: row.version })
        return ok(detail(member, { ...row, ...change }, since, at))
      })
    },

    /** DELETE /browser-skill-drafts/:draftId: the author only. */
    remove(member: Member, draftId: string): Outcome<{ deleted: true }> {
      if (!DRAFT_ID_RE.test(draftId)) return missing()
      const since = sinceOf(member)
      if (since === null) return missing()
      const repo = drafts(member.companyId)
      if (!repo.byId(member.userId, draftId, now(), since)) return missing()
      repo.delete(member.userId, draftId)
      return ok({ deleted: true })
    },

    /** The server clock: every draft of the company past its 30 days goes; how many. */
    expire(companyId: string): number {
      return drafts(companyId).deleteExpired(now())
    },
  }
}

export type BrowserSkillDraftService = ReturnType<typeof createBrowserSkillDraftService>

