import crypto from 'node:crypto'
import type { AgentInteraction, AgentInteractionRequest, AgentInteractionResponse } from '../shared/agent-interaction'
import { CHOICE_TIMEOUT_MS, normalizeChoiceAnswers, validChoiceAnswers } from '../shared/choice-prompt'

// Requests are owned by one renderer and one conversation; no answers are persisted.
// Choice prompts (the AI asks the member to pick) wait longer than the other
// interactions: the member may need to think or look something up first.
export class AgentInteractions {
  private pending = new Map<string, { owner: number; request: AgentInteractionRequest; finish: (value: AgentInteractionResponse) => void }>()
  constructor(private emit: (owner: number, event: 'request' | 'closed', request: AgentInteractionRequest) => void, private timeoutMs = 5 * 60_000, private choiceTimeoutMs = CHOICE_TIMEOUT_MS) {}
  request(owner: number, appSessionId: string, interaction: AgentInteraction, signal: AbortSignal): Promise<AgentInteractionResponse> {
    if (signal.aborted) return Promise.resolve({ cancelled: true, reason: 'aborted' })
    const request = { ...interaction, id: crypto.randomUUID(), appSessionId }
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: AgentInteractionResponse) => {
        if (!this.pending.delete(request.id)) return
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        this.emit(owner, 'closed', request); resolve(value)
      }
      function abort() { finish({ cancelled: true, reason: 'aborted' }) }
      timer = setTimeout(() => finish({ cancelled: true, reason: 'timeout' }), interaction.kind === 'choices' ? this.choiceTimeoutMs : this.timeoutMs)
      this.pending.set(request.id, { owner, request, finish })
      signal.addEventListener('abort', abort, { once: true })
      this.emit(owner, 'request', request)
    })
  }
  list(owner: number) { return [...this.pending.values()].filter(p => p.owner === owner).map(p => p.request) }
  closeOwner(owner: number) { for (const p of this.pending.values()) if (p.owner === owner) p.finish({ cancelled: true, reason: 'aborted' }) }
  respond(owner: number, id: string, response: AgentInteractionResponse): boolean {
    const p = this.pending.get(id)
    if (!p || p.owner !== owner || !response || typeof response !== 'object') return false
    if ('cancelled' in response && response.cancelled === true) { p.finish({ cancelled: true }); return true }
    if (p.request.kind === 'permissions') {
      if (!('approved' in response) || typeof response.approved !== 'boolean' || (response.approved && !p.request.supported)) return false
      p.finish({ approved: response.approved }); return true
    }
    if (p.request.kind === 'choices') {
      if (!('choices' in response) || !validChoiceAnswers(p.request.questions, response.choices)) return false
      p.finish({ choices: normalizeChoiceAnswers(response.choices) }); return true
    }
    if (!('answers' in response) || !response.answers || typeof response.answers !== 'object') return false
    const answers: Record<string, string> = Object.create(null)
    for (const q of p.request.questions) {
      const answer = response.answers[q.id]
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 10000) return false
      if (q.options?.length && !q.isOther && !q.options.some(o => o.label === answer)) return false
      answers[q.id] = answer
    }
    p.finish({ answers }); return true
  }
}
