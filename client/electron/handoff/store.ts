import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWrite, type ChatHistoryStore } from '../chat-history-store'
import type { ChatSession } from '../../shared/chat-history'
import type { AuthMode } from '../../shared/agent'
import type { HandoffMetrics } from './contract'
import { validateHandoff } from './contract'
export interface Cursor { index: number; offset: number }
export interface Checkpoint { cursor: Cursor; hash: string; provider: AuthMode; messageId: string }
export interface Memo { cursor: Cursor; hash: string; markdown: string; updatedAt: string; provider: AuthMode; turns: number; metrics: Pick<HandoffMetrics, 'totalMs' | 'inputTokens' | 'outputTokens'> }
export interface HandoffState { version: 1; turns: number; checkpoint?: Checkpoint; memo?: Memo; lastAttempt?: number; catchUp?: boolean; error?: string }
export const emptyState = (): HandoffState => ({ version: 1, turns: 0 })
export function validateId(id: string) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('相談の識別子が不正です') }
export function fingerprint(messages: ChatSession['messages'], cursor: Cursor) {
  if (!Number.isSafeInteger(cursor.index) || cursor.index < 0 || cursor.index > messages.length || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || (cursor.offset && (!messages[cursor.index] || cursor.offset > messages[cursor.index].content.length))) throw new Error('引き継ぎ範囲が不正です')
  const hash = createHash('sha256')
  for (let index = 0; index < cursor.index; index++) {
    const m = messages[index]
    hash.update(JSON.stringify([m.id, m.role, m.content, m.referenceFiles ?? []]))
  }
  if (cursor.offset) { const m = messages[cursor.index]; hash.update(JSON.stringify([m.id, m.role, m.content.slice(0, cursor.offset)])) }
  return hash.digest('hex')
}
export function matches(messages: ChatSession['messages'], record: { cursor: Cursor; hash: string }) {
  try { return fingerprint(messages, record.cursor) === record.hash } catch { return false }
}
export class HandoffStore {
  constructor(readonly directory: string, private history: ChatHistoryStore) {}
  file(company: string, id: string) { validateId(company); validateId(id); return path.join(this.directory, company, `${id}.json`) }
  read(company: string, id: string): HandoffState {
    const file = this.file(company, id)
    const session = this.history.get(company, id)
    if (!session) { this.remove(company, id); return emptyState() }
    if (!fs.existsSync(file)) return emptyState()
    for (const candidate of [file, `${file}.bak`]) {
      try {
        const state = JSON.parse(fs.readFileSync(candidate, 'utf8')) as HandoffState
        if (state.version !== 1 || !Number.isSafeInteger(state.turns) || state.turns < 0) throw new Error('schema')
        if (state.memo) validateHandoff(state.memo.markdown)
        if (state.memo && !matches(session.messages, state.memo)) { this.write(company, id, emptyState(), true); return emptyState() }
        if (state.checkpoint && !matches(session.messages, state.checkpoint)) {
          // Edits after the memo invalidate the completed tail, not the valid memo.
          const clean: HandoffState = { version: 1, turns: state.memo?.turns ?? 0, memo: state.memo }
          this.write(company, id, clean, true); return clean
        }
        return state
      } catch { /* try recovery copy; no raw data in logs */ }
    }
    throw new Error('引き継ぎメモを読み取れません。履歴は残っています。')
  }
  write(company: string, id: string, state: HandoffState, sanitize = false) {
    const session = this.history.get(company, id)
    if (!session) throw new Error('削除済みの相談には保存できません')
    const file = this.file(company, id)
    const body = JSON.stringify(state)
    if (sanitize) atomicWrite(`${file}.bak`, body)
    else if (fs.existsSync(file)) atomicWrite(`${file}.bak`, fs.readFileSync(file, 'utf8'))
    atomicWrite(file, body)
  }
  remove(company: string, id: string) {
    const file = this.file(company, id)
    fs.rmSync(file, { force: true }); fs.rmSync(`${file}.bak`, { force: true })
    if (fs.existsSync(path.dirname(file))) for (const name of fs.readdirSync(path.dirname(file))) {
      if ((name.startsWith(`${id}.json.`) || name.startsWith(`${id}.json.bak.`)) && name.endsWith('.tmp')) fs.rmSync(path.join(path.dirname(file), name), { force: true })
    }
  }
  cleanupDeleted() {
    if (!fs.existsSync(this.directory)) return
    for (const company of fs.readdirSync(this.directory)) {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(company) || !fs.statSync(path.join(this.directory, company)).isDirectory()) continue
      const sessions = new Map(this.history.list(company).map(session => [session.id, session]))
      for (const name of fs.readdirSync(path.join(this.directory, company))) {
        const id = name.match(/^([a-zA-Z0-9_-]{1,200})\.json(?:\.bak)?(?:\..*\.tmp)?$/)?.[1]
        if (!id) continue
        // A corrupt history must never be interpreted as a deleted conversation.
        const session = sessions.get(id)
        if (!session) this.remove(company, id)
      }
    }
  }
}
