/**
 * The one place the server hashes fixed content (design 節目4 §4-3,
 * `.claude/rules/approvals.md`): `sha256:` + the hex digest of the canonical
 * text's UTF-8 bytes. The canonical text is made by the caller
 * (`shared/core/fixed-content.ts` `canonicalJson` for an approval payload; the
 * mail's own canonical form for an outbound mail). The app echoes the hash it
 * was shown; for a browser plan it also hashes the claim's fixed content the
 * same way to check it is what the person approved (agent-browser.md
 * "Executing a plan"), never to make a hash the server trusts.
 */
import { createHash } from 'crypto'

export function hashCanonical(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}
