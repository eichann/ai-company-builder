/**
 * Per-member record of which desktop-app build they last used and when they
 * last talked to / fetched from / pushed to a company (table client_activity).
 *
 * Two consumers:
 * - the admin panel ("last successful sync" per member — a member's sync can
 *   fail silently for weeks without anyone noticing);
 * - the permission system, which must know every active member runs a build
 *   new enough to understand an operation before allowing it
 *   (activeMembersBuildCheck).
 *
 * Sources of a record:
 * - API requests under a company (/api/companies/:id/..., /api/git/repos/:id)
 *   that carry X-ACB-Client-Version: build, platform, last_seen_at. API
 *   requests WITHOUT the header (old apps, the admin panel in a browser) record
 *   nothing, so an owner using the admin panel never blanks their app build.
 * - Every authorized git-http request: build, platform, last_seen_at. Here a
 *   missing header is recorded as unknown (NULL): only git clients reach that
 *   route, and a client that does not identify itself must not keep a build
 *   recorded earlier by another of that user's devices.
 *   + upload-pack (advertisement or negotiation) that the CGI completed:
 *     last_fetch_at.
 *   + receive-pack whose report-status accepted every ref: last_push_at.
 *
 * Writes are throttled per (kind, user, company) to one per THROTTLE_MS unless
 * the reported build/platform changed, so a sync storm costs at most a few
 * SQLite writes per member per minute.
 *
 * This module holds the pure parts (headers, the receive-pack result); the
 * recording, the throttle and the build check are services/client-activity.ts,
 * the table is adapters/sqlite/client-activity.ts.
 */
export const CLIENT_VERSION_HEADER = 'X-ACB-Client-Version'
export const CLIENT_PLATFORM_HEADER = 'X-ACB-Client-Platform'

/**
 * Header values are client-controlled: keep them short and printable. Returns
 * null for absent/empty values.
 */
export function sanitizeClientHeader(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  const cleaned = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max)
  return cleaned || null
}

export function clientIdentityFromHeaders(header: (name: string) => string | undefined): { version: string | null; platform: string | null } {
  return {
    version: sanitizeClientHeader(header(CLIENT_VERSION_HEADER), 128),
    platform: sanitizeClientHeader(header(CLIENT_PLATFORM_HEADER), 64),
  }
}

// ----------------------------------------------------------------------------
// receive-pack result
// ----------------------------------------------------------------------------

/** Split a pkt-line stream into payloads (flush/delim packets skipped). */
function pktLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let pos = 0
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('latin1')
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
    const len = parseInt(hex, 16)
    if (len < 4) { pos += 4; continue } // 0000 flush, 0001 delim, 0002 response-end
    if (pos + len > buf.length) break
    out.push(buf.subarray(pos + 4, pos + len))
    pos += len
  }
  return out
}

/**
 * Did a receive-pack response report every ref as accepted?
 *
 * The body is git's report-status: `unpack ok`, then `ok <ref>` or
 * `ng <ref> <reason>` per ref — wrapped in side-band channel 1 when the client
 * negotiated side-band(-64k), which git always does. A pre-receive rejection
 * (secret scan, protected config, ...) or a non-fast-forward shows up as `ng`;
 * a failed unpack as `unpack <error>`. Returns false when no report is found
 * (e.g. a client that did not ask for report-status): unproven is not success.
 */
export function receivePackSucceeded(body: Buffer): boolean {
  const outer = pktLines(body)
  const lines: string[] = []
  const band1: Buffer[] = []
  for (const p of outer) {
    if (p.length > 0 && p[0] === 1) band1.push(p.subarray(1))
    else if (p.length > 0 && p[0] > 3) lines.push(p.toString('utf8'))
  }
  if (band1.length > 0) {
    for (const p of pktLines(Buffer.concat(band1))) lines.push(p.toString('utf8'))
  }
  let unpackOk = false
  let ok = 0
  let ng = 0
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '')
    if (line.startsWith('unpack ')) unpackOk = line === 'unpack ok'
    else if (line.startsWith('ok ')) ok++
    else if (line.startsWith('ng ')) ng++
  }
  return unpackOk && ok > 0 && ng === 0
}
