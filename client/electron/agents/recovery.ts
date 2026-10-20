import { wrapLanguageModel, type LanguageModel } from 'ai'
import type { AgentConnection } from './connection'

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
type StreamResult = Awaited<ReturnType<Model['doStream']>>
type Part = StreamResult['stream'] extends ReadableStream<infer T> ? T : never
export class MissingAgentSession extends Error {
  constructor(readonly sessionId: string) { super('保存されたAIセッションが見つかりません。'); this.name = 'MissingAgentSession' }
}
export interface RecoveryHooks {
  prepare(): { context: string; usedMemo: boolean }
  started(usedMemo: boolean): void
  session(id: string): void
  finished(): void
  failed(): void
}

/** Retry only a proven missing session, before ANY model output/tool activity, once. */
export function recoverSessionModel(connection: AgentConnection, request: Parameters<AgentConnection['createChatModel']>[0], hooks: RecoveryHooks): LanguageModel {
  const model = connection.createChatModel(request)
  if (!request.resumeId || typeof model === 'string' || model.specificationVersion !== 'v3') return model
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: 'v3',
    wrapStream: async ({ params, model: original }) => {
      const abort = new AbortController()
      const relayAbort = () => abort.abort(params.abortSignal?.reason)
      params.abortSignal?.addEventListener('abort', relayAbort, { once: true })
      if (params.abortSignal?.aborted) relayAbort()
      let reader: ReadableStreamDefaultReader<Part> | undefined
      let cancelled = false
      return { stream: new ReadableStream<Part>({
        async start(controller) {
          let retried = false
          let activity = false
          let started = false
          let sessionSeen = false
          let complete = false
          let factory = () => original.doStream({ ...params, abortSignal: abort.signal })
          try {
            for (;;) {
              try {
                abort.signal.throwIfAborted()
                const result = await factory()
                reader = result.stream.getReader()
                for (;;) {
                  const item = await reader.read()
                  if (item.done) break
                  const part = item.value
                  if (part.type === 'error') throw part.error
                  if (part.type === 'stream-start') {
                    if (!started) { controller.enqueue(part); started = true }
                    continue
                  }
                  // Metadata means the native session initialized; raw events may include tools.
                  activity = true
                  if (retried && part.type === 'response-metadata' && part.id) { hooks.session(part.id); sessionSeen = true }
                  if (retried && part.type === 'finish' && part.finishReason.unified === 'stop') {
                    if (!sessionSeen) throw new Error('新しいAIセッションの保存を確認できませんでした。')
                    hooks.finished(); complete = true
                  }
                  if (!cancelled) controller.enqueue(part)
                }
                if (retried && !complete) hooks.failed()
                break
              } catch (error) {
                await reader?.cancel().catch(() => {})
                reader = undefined
                if (cancelled || abort.signal.aborted || retried || activity || !connection.isMissingSession?.(error, request.resumeId!)) throw error
                retried = true
                const packet = hooks.prepare()
                abort.signal.throwIfAborted()
                hooks.started(packet.usedMemo)
                const fresh = connection.createChatModel({ ...request, resumeId: undefined })
                if (typeof fresh === 'string' || fresh.specificationVersion !== 'v3') throw new Error('このAI接続は引き継ぎに対応していません。')
                const prompt: typeof params.prompt = [
                  ...params.prompt.filter(m => m.role === 'system'),
                  { role: 'user', content: [{ type: 'text', text: packet.context }] },
                  ...params.prompt.filter(m => m.role !== 'system'),
                ]
                factory = () => fresh.doStream({ ...params, prompt, abortSignal: abort.signal })
              }
            }
          } catch (error) {
            if (retried) { try { hooks.failed() } catch { /* reporting must not hide the original error */ } }
            if (!cancelled) controller.enqueue({ type: 'error', error })
          } finally {
            params.abortSignal?.removeEventListener('abort', relayAbort)
            abort.abort()
            reader?.releaseLock()
            if (!cancelled) controller.close()
          }
        },
        async cancel() { cancelled = true; abort.abort(); await reader?.cancel().catch(() => {}) },
      }) }
    },
  } })
}
