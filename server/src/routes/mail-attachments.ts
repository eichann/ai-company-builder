/**
 * What the outbound mail routes of both doors (the person's session, outbound-mail.ts; their AI's
 * record token, records-ai.ts) share for PDF attachments (outbound-mail.md "Attachments"). No
 * routes here.
 */
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ATTACHMENT_BODY_MAX } from '../services/outbound-mail'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

/** An attachment upload: at most one 10 MB PDF as base64, plus its name and version. */
export const attachmentBodyLimit = bodyLimit({
  maxSize: ATTACHMENT_BODY_MAX,
  onError: c => c.json({ error: '付けられるファイルは 10 MB までです。', code: 'ATTACHMENT_INVALID' }, 413),
})

/** A file's bytes as the person's app downloads them: never shown inline, never cached. */
export function attachmentAnswer(c: Context, result: Outcome<{ name: string; bytes: Uint8Array }>) {
  if (!result.ok) return refusal(c, result)
  return new Response(Buffer.from(result.value.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(result.value.bytes.byteLength),
      'Content-Disposition': `attachment; filename="file.pdf"; filename*=UTF-8''${encodeURIComponent(result.value.name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
