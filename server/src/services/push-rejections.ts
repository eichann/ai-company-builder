/**
 * Pushes the pre-receive hook rejected, recorded so the admin panel can show
 * "this member's sync is being refused, and why" (GET /push-rejections).
 * Parsing is lib/push-rejections.ts; rows go through PushRejectionRepository.
 */
import type { PushRejectionRepository } from '../ports/push-rejections'
import { parseHookRejections, sidebandMessages } from '../lib/push-rejections'

export function createPushRejectionRecorder(deps: { pushRejections: PushRejectionRepository }) {
  const { pushRejections } = deps

  return {
    /**
     * Called with a finished receive-pack's captured response. Defers parsing
     * and the write past the current tick so the push response is never held
     * up, and never throws: it must not break the push it observes.
     */
    observe(companyId: string, userId: string, body: Buffer | null): void {
      if (!body) return
      setImmediate(() => {
        try {
          const rejections = parseHookRejections(sidebandMessages(body))
          if (rejections.length === 0) return
          try {
            pushRejections.record(companyId, userId, rejections)
          } catch (err) {
            console.error('[push-rejections] Failed to record rejection:', err)
          }
        } catch (err) {
          console.error('[push-rejections] Failed to parse rejection:', err)
        }
      })
    },
  }
}
