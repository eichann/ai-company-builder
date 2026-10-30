import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, type ChatHistoryStore } from '../chat-history-store'
import type { ChatSession } from '../../shared/chat-history'
import type { HandoffCompletion, HandoffView, HandoffRecovery } from '../../shared/handoff'
import { HandoffStore, fingerprint, matches, type Cursor, type HandoffState } from './store'
import { handoffInputText, validateHandoff, type HandoffInput, type HandoffMetrics, type HandoffRequest } from './contract'
import { agentCan, isAgentId, type AgentId } from '../../shared/agents/registry'

/** Writes the memo with the agent that held the conversation (agents/registry.ts writeAgentHandoff). */
type Writer = (provider: AgentId, request: Pick<HandoffRequest, 'input' | 'signal' | 'save'>) => Promise<HandoffMetrics>
interface Options {
  idleMs: number; cooldownMs: number; turns: number; characters: number; jobsPerHour: number; now: () => number
  /** False while an administrator has stopped the AI (agent-stop.md): no memo is written, the job waits quietly. */
  aiAllowed: () => boolean
}
const defaults: Options = { idleMs: 20_000, cooldownMs: 600_000, turns: 16, characters: 12_000, jobsPerHour: 4, now: Date.now, aiAllowed: () => true }
/** How long a job waits before checking again whether the AI is still stopped. */
const STOPPED_RETRY_MS = 60_000
const keyOf = (company: string, id: string) => JSON.stringify([company, id])
const atEnd = (a: Cursor, b: Cursor) => a.index === b.index && a.offset === b.offset

/** Continuous, bounded prefix. No thinking, image data, tool records or full history clone. */
export function handoffChunk(session: ChatSession, state: HandoffState): { input: HandoffInput; cursor: Cursor } {
  if (!state.checkpoint) throw new Error('正常終了した会話がまだありません')
  const end = state.checkpoint.cursor
  const cursor = { ...(state.memo?.cursor ?? { index: 0, offset: 0 }) }
  const input: HandoffInput = { previousMemo: state.memo?.markdown, messages: [] }
  // Byte cap plus conservative character estimate; the SDK's own instructions are additional.
  const fits = () => { try { return handoffInputText(input).length <= 14_000 } catch { return false } }
  while (cursor.index < end.index) {
    const message = session.messages[cursor.index]
    const rest = message.content.slice(cursor.offset)
    input.messages.push({ role: message.role, content: rest })
    if (fits()) { cursor.index++; cursor.offset = 0; continue }
    let low = 0; let high = rest.length
    const last = input.messages[input.messages.length - 1]
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      last.content = rest.slice(0, mid)
      if (fits()) low = mid; else high = mid - 1
    }
    if (low > 0 && /[\uD800-\uDBFF]/u.test(rest[low - 1])) low--
    if (low) { last.content = rest.slice(0, low); cursor.offset += low }
    else input.messages.pop()
    break
  }
  if (!input.messages.length) throw new Error('メモが大きすぎて追加の会話を整理できません')
  return { input, cursor }
}

export class HandoffService {
  private queue = new Map<string, { company: string; id: string }>()
  private busy = new Set<string>()
  private recovering = new Set<string>()
  private running?: { key: string; controller: AbortController }
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private options: Options
  constructor(private history: ChatHistoryStore, readonly store: HandoffStore, private writer: Writer,
    private changed: (company: string, id: string) => void, options: Partial<Options> = {}) { this.options = { ...defaults, ...options } }

  recordRecovery(company: string, id: string, recovery: HandoffRecovery) {
    if (!this.history.get(company, id)) return
    const state = this.store.read(company, id)
    if (recovery.status === 'recovering') this.recovering.add(keyOf(company, id)); else this.recovering.delete(keyOf(company, id))
    state.recovery = recovery
    this.store.write(company, id, state)
    this.changed(company, id)
  }
  complete(company: string, id: string, receipt: HandoffCompletion) {
    const session = this.history.get(company, id)
    if (!session) return
    if (!isAgentId(receipt.provider)) throw new Error('不正なAI接続です')
    const index = session.messages.findIndex(m => m.id === receipt.messageId)
    if (index < 0 || session.messages[index].role !== 'assistant' || session.messages[index].content !== receipt.content) throw new Error('応答の保存が完了していません')
    const state = this.store.read(company, id)
    const cursor = { index: index + 1, offset: 0 }
    if (state.checkpoint && state.checkpoint.cursor.index >= cursor.index) return
    state.turns++
    state.checkpoint = { cursor, hash: fingerprint(session.messages, cursor), messageId: receipt.messageId, provider: receipt.provider }
    state.error = undefined
    this.store.write(company, id, state)
    this.touch(company, id)
    this.changed(company, id)
  }
  touch(company: string, id: string) {
    const session = this.history.get(company, id)
    if (!session) { this.store.remove(company, id); return }
    const state = this.store.read(company, id)
    if (state.checkpoint && agentCan(state.checkpoint.provider, 'handoff') && !state.error && this.due(session, state)) {
      this.queue.set(keyOf(company, id), { company, id }); this.wake()
    }
  }
  requestUpdate(company: string, id: string) {
    const view = this.view(company, id)
    if (!view.canUpdate) throw new Error(view.message)
    const session = this.history.get(company, id)!
    const state = this.store.read(company, id)
    // Explicit manual update also works for old conversations with no post-install completion receipt.
    if (!state.checkpoint) {
      const provider = session.agentSession?.providerId ?? (session.claudeSessionId ? 'claude-code' : undefined)
      if (!provider || !agentCan(provider, 'handoff') || !session.messages.length) throw new Error('この相談のAI接続を確認できません。')
      const cursor = { index: session.messages.length, offset: 0 }
      state.checkpoint = { cursor, hash: fingerprint(session.messages, cursor), provider, messageId: session.messages.at(-1)!.id }
      this.store.write(company, id, state)
    }
    this.queue.set(keyOf(company, id), { company, id })
    this.changed(company, id); this.wake()
  }
  setBusy(token: string, active: boolean) {
    if (active) { this.busy.add(token); this.running?.controller.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined }
    else { this.busy.delete(token); this.wake() }
  }
  invalidate(company: string, id: string) {
    const key = keyOf(company, id)
    this.queue.delete(key)
    this.recovering.delete(key)
    if (this.running?.key === key) this.running.controller.abort()
    this.store.remove(company, id)
    this.changed(company, id)
  }
  view(company: string, id: string): HandoffView {
    const session = this.history.get(company, id)
    if (!session) return { status: 'waiting', message: '相談の応答が保存されると、メモを作成できます。', canUpdate: false, pendingTurns: 0 }
    const state = this.store.read(company, id)
    const checkpoint = state.checkpoint
    const key = keyOf(company, id)
    const provider = checkpoint?.provider ?? session.agentSession?.providerId ?? (session.claudeSessionId ? 'claude-code' : undefined)
    const supported = !provider || agentCan(provider, 'handoff')
    const pending = checkpoint ? (!state.memo || !atEnd(checkpoint.cursor, state.memo.cursor)) : !!provider && !!session.messages.length
    const status = !supported ? 'unsupported' : this.running?.key === key ? 'running' : this.queue.has(key) ? 'queued' : state.error ? 'error' : state.memo ? 'saved' : 'waiting'
    const message = status === 'unsupported' ? 'APIキー方式のメモ自動保存は未対応です。' : status === 'running' ? '引き継ぎメモを整理中…' : status === 'queued' ? '会話が落ち着いてから更新します。利用量の上限に達した場合は待機します。' : state.error || (state.memo ? 'メモを保存しています。AIセッションが見つからない場合の引き継ぎに使います。' : '会話が長くなると自動保存します。短い会話は「メモを更新」でも確認できます。')
    return { status, message, recovery: state.recovery?.status === 'recovering' && !this.recovering.has(key) ? { ...state.recovery, status: 'error' } : state.recovery, markdown: state.memo?.markdown, updatedAt: state.memo?.updatedAt, provider: state.memo?.provider ?? checkpoint?.provider, metrics: state.memo?.metrics, pendingTurns: Math.max(0, state.turns - (state.memo?.turns ?? 0)), canUpdate: pending && supported && status !== 'running' && status !== 'queued' }
  }
  private due(session: ChatSession, state: HandoffState) {
    if (!state.checkpoint || (state.memo && atEnd(state.memo.cursor, state.checkpoint.cursor))) return false
    if (state.turns - (state.memo?.turns ?? 0) >= this.options.turns) return true
    const start = state.memo?.cursor ?? { index: 0, offset: 0 }
    let characters = -start.offset
    for (let i = start.index; i < state.checkpoint.cursor.index; i++) characters += session.messages[i].content.length
    return characters >= this.options.characters || !!state.catchUp
  }
  private wake(delay = this.options.idleMs) {
    if (this.disposed || this.timer || this.running || this.busy.size || !this.queue.size) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.runNext() }, delay)
    this.timer.unref?.()
  }
  private budget() {
    const file = path.join(this.store.directory, 'attempts.json')
    const attempts: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
    if (!Array.isArray(attempts) || attempts.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('利用量の記録を確認できないため、自動保存を停止しました')
    return (attempts as number[]).filter(n => n > this.options.now() - 3600_000).sort((a, b) => a - b)
  }
  private async runNext() {
    if (this.disposed || this.busy.size || this.running) return
    let wait = Infinity
    for (const [key, scope] of this.queue) {
      const { company, id } = scope
      try {
        const session = this.history.get(company, id)
        if (!session) { this.invalidate(company, id); continue }
        const state = this.store.read(company, id)
        if (!state.checkpoint || !agentCan(state.checkpoint.provider, 'handoff') || (state.memo && atEnd(state.memo.cursor, state.checkpoint.cursor))) { this.queue.delete(key); this.changed(company, id); continue }
        if (!this.options.aiAllowed()) { wait = Math.min(wait, STOPPED_RETRY_MS); continue }
        const attempts = this.budget()
        const eligible = Math.max((state.lastAttempt ?? -Infinity) + this.options.cooldownMs, attempts.length >= this.options.jobsPerHour ? attempts[0] + 3600_000 : 0)
        if (eligible > this.options.now()) { wait = Math.min(wait, eligible - this.options.now()); continue }
        const { input, cursor } = handoffChunk(session, state)
        const hash = fingerprint(session.messages, cursor)
        const controller = new AbortController()
        this.running = { key, controller }
        this.queue.delete(key)
        state.lastAttempt = this.options.now(); state.error = undefined
        this.store.write(company, id, state)
        atomicWrite(path.join(this.store.directory, 'attempts.json'), JSON.stringify([...attempts, this.options.now()]))
        this.changed(company, id)
        let markdown: string | undefined
        try {
          const metrics = await this.writer(state.checkpoint.provider, { input, signal: controller.signal, save: value => {
            controller.signal.throwIfAborted()
            if (markdown !== undefined) throw new Error('二重保存を拒否しました')
            // Stage the tool result; publish only after successful provider completion.
            markdown = validateHandoff(value)
          } })
          controller.signal.throwIfAborted()
          const currentSession = this.history.get(company, id)
          if (!currentSession || !matches(currentSession.messages, { cursor, hash })) throw new Error('整理中に相談が変更されました。次の応答後に更新します。')
          if (!markdown) throw new Error('保存ツールが呼ばれませんでした')
          const current = this.store.read(company, id)
          const complete = atEnd(cursor, state.checkpoint.cursor)
          current.memo = { cursor, hash, markdown, updatedAt: new Date(this.options.now()).toISOString(), provider: state.checkpoint.provider, turns: complete ? state.turns : (state.memo?.turns ?? 0), metrics: { totalMs: metrics.totalMs, inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens } }
          current.catchUp = !complete
          current.error = undefined
          this.store.write(company, id, current)
          if (this.due(currentSession, current)) this.queue.set(key, scope)
        } catch (error) {
          const stillActive = this.history.get(company, id)
          if (stillActive) {
            const current = this.store.read(company, id)
            current.error = controller.signal.aborted ? undefined : this.describeError(error)
            this.store.write(company, id, current)
            if (controller.signal.aborted && !this.disposed) this.queue.set(key, scope)
          }
        } finally { this.running = undefined; this.changed(company, id); this.wake() }
        return
      } catch (error) {
        this.queue.delete(key)
        this.running = undefined
        try { const state = this.store.read(company, id); state.error = this.describeError(error); this.store.write(company, id, state) } catch { /* source unavailable; do not overwrite */ }
        this.changed(company, id)
      }
    }
    if (Number.isFinite(wait)) this.wake(Math.max(this.options.idleMs, wait))
  }
  private describeError(error: unknown) {
    const text = error instanceof Error ? error.message : ''
    if (/experimental|dynamicTools|not supported|unknown field/i.test(text)) return 'このCodexではメモ保存ツールを利用できません。Codex CLIを更新してください。通常の相談は続けられます。'
    if (/login|認証|ログイン|401/i.test(text)) return 'AIへのログインを確認してください。履歴と以前のメモは保持しています。'
    if (/上限|大きすぎ|8 KiB/.test(text)) return text
    return 'メモを更新できませんでした。履歴と以前のメモは保持しています。「メモを更新」で再試行できます。'
  }
  dispose() { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.running?.controller.abort(); this.queue.clear() }
}
