// Which services a reply hit "no key" for: the key broker's relay ends that answer
// with `[ACB_NO_KEY:<service>]` (shared/core/key-broker.ts `brokerNoKeyMessage`),
// and a tool's output or the AI's text carries it. Only the service name is taken
// from what was printed — never anything around it.
import { findBrokerNoKeyServices } from '../../../../shared/core/key-broker'

/** At most this much of one part is searched (the marker sits in a short error answer). */
const PART_LIMIT = 256 * 1024

type Part = { type: string; text?: unknown; output?: unknown; errorText?: unknown }

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value) } catch { return '' }
}

/** Services named by "no key" answers in a message's parts, first seen first, each once. */
export function brokerKeyNeedsOf(parts: readonly Part[]): string[] {
  const out: string[] = []
  for (const part of parts) {
    const isTool = part.type === 'dynamic-tool' || part.type.startsWith('tool-')
    if (part.type !== 'text' && !isTool) continue
    const texts = isTool ? [textOf(part.output), textOf(part.errorText)] : [textOf(part.text)]
    for (const text of texts) {
      for (const service of findBrokerNoKeyServices(text.slice(0, PART_LIMIT))) if (!out.includes(service)) out.push(service)
    }
  }
  return out
}
