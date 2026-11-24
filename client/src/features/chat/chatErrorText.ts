/**
 * The chat's red error bar text. The chat server refuses a turn with a JSON body
 * (`{ error, code }`, e.g. the emergency stop's AI_STOPPED), and the chat transport hands that
 * body over verbatim as the error's message. A member must read the sentence the server wrote,
 * not braces and codes: when the message is such a body, the bar shows its `error` alone (it is
 * already a whole Japanese sentence); anything else keeps the generic prefix.
 */
export function chatErrorText(message: string, generic: (error: string) => string): string {
  const refused = refusalSentence(message)
  return refused ?? generic(message)
}

function refusalSentence(message: string): string | null {
  const trimmed = message.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const body: unknown = JSON.parse(trimmed)
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      const sentence = (body as { error: string }).error.trim()
      return sentence || null
    }
  } catch { /* not JSON: shown as it is */ }
  return null
}
