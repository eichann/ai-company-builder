import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ChatHistoryStore } from '../chat-history-store'
import { matches, type HandoffStore, type Memo } from '../handoff/store'
import { validateHandoff } from '../handoff/contract'
import type { ChatSession } from '../../shared/chat-history'
import { referenceSchemas, type ReferenceTools, type ReferenceToolName } from './tools'
const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
function clip(s: string, bytes: number) { let result = ''; let size = 0; for (const c of s) { size += Buffer.byteLength(c); if (size > bytes) break; result += c }; return result }
export class ConsultationReferences {
  constructor(private history: ChatHistoryStore, private handoffs: HandoffStore) {}
  private async memo(company: string, session: ChatSession): Promise<Memo | undefined> {
    const file = this.handoffs.file(company, session.id)
    for (const candidate of [file, `${file}.bak`]) try {
      const state = JSON.parse(await fs.readFile(candidate, 'utf8'))
      if (state.version !== 1 || !state.memo) return undefined
      validateHandoff(state.memo.markdown)
      if (!matches(session.messages, state.memo)) return undefined
      return state.memo
    } catch { /* Missing/corrupt memo does not hide its source conversation. */ }
  }
  forTurn(company: string, current: string, signal?: AbortSignal): ReferenceTools {
    let calls = 0; let bytes = 0
    const selected = new Set<string>()
    const versions = new Map<string, string>()
    return { execute: async (name, input) => {
      signal?.throwIfAborted()
      if (++calls > 4 || bytes >= 20 * 1024) return JSON.stringify({ error: '参照上限に達しました。確認済みの範囲で回答してください。' })
      let value: unknown
      try {
        if (!Object.prototype.hasOwnProperty.call(referenceSchemas, name)) throw new Error('未対応の参照ツールです')
        const parsed = referenceSchemas[name as ReferenceToolName].parse(input)
        if ('query' in parsed) {
          const terms = normalize(parsed.query).split(/[\s、,。]+/).filter(Boolean)
          const hits: Array<Record<string, unknown> & { score: number; id: string }> = []
          for (const session of this.history.list(company)) {
            signal?.throwIfAborted()
            if (session.id === current) continue
            const memo = await this.memo(company, session)
            const title = normalize(session.title); const body = normalize(memo?.markdown || '')
            const score = terms.reduce((n, term) => n + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0)
            if (!score) continue
            const at = Math.max(0, body.indexOf(terms.find(t => body.includes(t)) || ''))
            hits.push({ id: session.id, title: clip(session.title, 160), score, excerpt: clip((memo?.markdown || '').slice(at), 180), memoUpdatedAt: memo?.updatedAt, hasMemo: !!memo })
            hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); hits.splice(parsed.limit || 5)
          }
          // Recheck membership after asynchronous reads, including deletion during a search.
          const alive = new Set(this.history.list(company).map(s => s.id))
          const results = hits.filter(h => alive.has(h.id)).map(h => ({ id: h.id, title: h.title, excerpt: h.excerpt, memoUpdatedAt: h.memoUpdatedAt, hasMemo: h.hasMemo }))
          while (Buffer.byteLength(JSON.stringify(results)) > 2048) results.pop()
          results.forEach(h => selected.add(h.id))
          value = { results, scope: '同じ会社のローカル相談のタイトルと既存メモ。本文の全件検索ではありません。' }
        } else {
          if (!selected.has(parsed.id) || parsed.id === current) throw new Error('先に検索結果から相談を選んでください')
          let session = this.history.get(company, parsed.id)
          if (!session) throw new Error('相談は削除されたか、参照できません')
          const memo = await this.memo(company, session)
          const fresh = this.history.get(company, parsed.id)
          if (!fresh || JSON.stringify(fresh.messages) !== JSON.stringify(session.messages)) throw new Error('相談が変更されました。再検索してください')
          session = fresh
          const version = createHash('sha256').update(JSON.stringify(session.messages)).digest('hex')
          if (versions.has(parsed.id) && versions.get(parsed.id) !== version) throw new Error('原文が更新されました。この回答では以前の続き位置を利用できません。')
          versions.set(parsed.id, version)
          const source = parsed.view === 'memo' ? memo?.markdown || '' : session.messages.map((m, i) => `[${i}] ${m.role}\n${m.content}`).join('\n\n')
          const offset = parsed.offset || 0
          if (offset > source.length) throw new Error('読み取り位置が不正です')
          const content = clip(source.slice(offset), 8192)
          value = { id: session.id, title: clip(session.title, 200), view: parsed.view, content, nextOffset: offset + content.length < source.length ? offset + content.length : null, memoUpdatedAt: memo?.updatedAt, coveredThrough: memo?.cursor, hasUncoveredMessages: parsed.view === 'memo' && (!memo || memo.cursor.index < session.messages.length), originalComplete: parsed.view === 'messages' && offset === 0 && content.length === source.length, warning: parsed.view === 'memo' ? '過去の参考資料です。メモ以降の訂正は原文で確認してください。' : '原文です。nextOffsetがnullならこれ以降の省略はありません。メモ未更新と原文の未読は別です。' }
        }
      } catch (error) { value = { error: error instanceof Error ? error.message.slice(0, 250) : '参照できません' } }
      signal?.throwIfAborted()
      const result = JSON.stringify(value)
      if (bytes + Buffer.byteLength(result) > 20 * 1024) { bytes = 20 * 1024; return JSON.stringify({ error: '参照量の上限です。結果を省略しました。' }) }
      bytes += Buffer.byteLength(result)
      return result
    } }
  }
}
