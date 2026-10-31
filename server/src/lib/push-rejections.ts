/**
 * Record pushes the pre-receive hook rejected (table push_rejections), so the
 * admin panel can show "this member's sync is being refused, and why" without
 * anyone reading server logs.
 *
 * Source: the receive-pack response git-http already captures for
 * client-activity (bounded, see MAX_OBSERVED_BODY_BYTES in routes/git-http.ts).
 * The hook's stderr reaches the client on side-band channel 2; the hook
 * (templates/pre-receive-hook.sh → lib/push-check/report.ts) prints one section per check:
 *
 *     ========================================
 *     [PROTECTED_CONFIG] <title>
 *     ========================================
 *     <explanation>
 *       - <path>
 *       - <path> (<pattern name>)          (SECRET_DETECTED only)
 *     <explanation>
 *     ========================================
 *
 * The client parses the same layout (client/electron/protected-config.ts):
 * the "- " lines between the marker and the second separator after it are the
 * paths. Every `[UPPER_CASE]` marker line is recorded, so a check added to the
 * hook later is recorded without a server change.
 *
 * This module only parses (pure). Recording runs after the response has been
 * handed back (setImmediate) and never throws: services/push-rejections.ts,
 * storing through PushRejectionRepository (adapters/sqlite/push-rejections.ts).
 */

export const MAX_PATHS_PER_REJECTION = 50
export const MAX_PATH_LENGTH = 512
const MAX_SECTIONS = 16

const MARKER_RE = /^\[([A-Z][A-Z0-9_]{1,63})\]/

export interface HookRejection {
  marker: string
  paths: string[]
}

/** Payloads of a pkt-line stream (flush/delim packets skipped). */
function pktLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let pos = 0
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('latin1')
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
    const len = parseInt(hex, 16)
    if (len < 4) { pos += 4; continue }
    if (pos + len > buf.length) break
    out.push(buf.subarray(pos + 4, pos + len))
    pos += len
  }
  return out
}

/** The hook/progress text of a receive-pack response (side-band channel 2). */
export function sidebandMessages(body: Buffer): string {
  const band2: Buffer[] = []
  for (const p of pktLines(body)) {
    if (p.length > 0 && p[0] === 2) band2.push(p.subarray(1))
  }
  return Buffer.concat(band2).toString('utf8')
}

/** Parse the hook's rejection sections out of its output (with or without "remote: " prefixes). */
export function parseHookRejections(output: string): HookRejection[] {
  const lines = output.split(/\r?\n|\r/).map(l => l.replace(/^remote:\s?/, '').trim())
  const result: HookRejection[] = []
  for (let i = 0; i < lines.length && result.length < MAX_SECTIONS; i++) {
    const m = MARKER_RE.exec(lines[i])
    if (!m) continue
    const marker = m[1]
    const paths: string[] = []
    let separators = 0
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (/^=+$/.test(line)) {
        if (++separators === 2) break
        continue
      }
      if (MARKER_RE.test(line)) break
      if (!line.startsWith('- ')) continue
      let p = line.slice(2).trim()
      // SECRET_DETECTED appends the matched pattern: "- path (Pattern Name)".
      if (marker === 'SECRET_DETECTED') p = p.replace(/ \([^()]*\)$/, '')
      p = p.slice(0, MAX_PATH_LENGTH)
      if (p && !paths.includes(p) && paths.length < MAX_PATHS_PER_REJECTION) paths.push(p)
    }
    const existing = result.find(r => r.marker === marker)
    if (existing) {
      for (const p of paths) if (!existing.paths.includes(p) && existing.paths.length < MAX_PATHS_PER_REJECTION) existing.paths.push(p)
    } else {
      result.push({ marker, paths })
    }
  }
  return result
}
