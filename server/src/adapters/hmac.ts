/** HMAC-SHA256 and a constant-time comparison (ports/slack.ts `HmacSigner`), with Node's crypto. */
import { createHmac, timingSafeEqual } from 'crypto'
import type { HmacSigner } from '../ports/slack'

export const nodeHmacSigner: HmacSigner = {
  sha256Hex: (key, message) => createHmac('sha256', key).update(message, 'utf8').digest('hex'),
  same(a, b) {
    const x = Buffer.from(a, 'utf8')
    const y = Buffer.from(b, 'utf8')
    return x.length === y.length && timingSafeEqual(x, y)
  },
}
