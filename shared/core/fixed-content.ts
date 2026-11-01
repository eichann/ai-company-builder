/**
 * Fixed content (design 節目4 §4-3, 「印で中身を固定する」): what a person
 * approves or sends is turned into ONE canonical string, and the server hashes
 * it (`sha256:<hex>`). The screen shows a version together with its hash and
 * sends that hash back when the person presses the button; the server acts
 * only when the hash of what it holds now is the same. The hash shows that the
 * approved content and the content acted on are the same — it says nothing
 * about what happens after the send.
 *
 * Canonical form: JSON with object keys sorted, strings in NFC, no
 * `undefined`, no non-finite numbers. Nothing is trimmed or collapsed: a
 * difference in spaces is a different content (design §4-3, 「最初は甘くしない」).
 * Hashing itself is the server's (Node's crypto); the app never computes a
 * hash, it only echoes the one it was shown.
 */

/** `sha256:` + 64 lowercase hex digits. */
export const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/

/** The canonical JSON text of a value; throws on what has no canonical form (undefined, NaN, functions…). */
export function canonicalJson(value: unknown): string {
  return walk(value, 0)
}

function walk(v: unknown, depth: number): string {
  if (depth > 32) throw new Error('canonicalJson: too deep')
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'))
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(x => walk(x, depth + 1)).join(',')}]`
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) throw new Error('canonicalJson: not a plain object')
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.some(([, x]) => x === undefined)) throw new Error('canonicalJson: undefined value')
    const keys = entries.map(([k]) => k.normalize('NFC'))
    if (new Set(keys).size !== keys.length) throw new Error('canonicalJson: keys equal after NFC')
    return `{${entries
      .map(([k, x]) => [k.normalize('NFC'), x] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${walk(x, depth + 1)}`)
      .join(',')}}`
  }
  throw new Error(`canonicalJson: unsupported ${typeof v}`)
}
