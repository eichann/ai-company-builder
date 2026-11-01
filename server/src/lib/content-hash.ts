/**
 * The one place the server hashes fixed content (design 節目4 §4-3,
 * `.claude/rules/approvals.md`): `sha256:` + the hex digest of the canonical
 * text's UTF-8 bytes. The canonical text is made by the caller
 * (`shared/core/fixed-content.ts` `canonicalJson` for an approval payload; the
 * mail's own canonical form for an outbound mail). The app never hashes; it
 * echoes the hash it was shown.
 */
import { createHash } from 'crypto'

export function hashCanonical(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}
