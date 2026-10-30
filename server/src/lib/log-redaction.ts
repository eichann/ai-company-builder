/**
 * The request log (hono/logger) prints each request line with its query. The
 * key broker's relay accepts a token as `?key=` (the form some Gemini clients
 * use), so on /api/broker/… the query is never printed (key-broker.md).
 */
export function redactBrokerQuery(line: string): string {
  return line.replace(/(\/api\/broker\/[^\s?]*)\?\S*/g, '$1?…')
}
