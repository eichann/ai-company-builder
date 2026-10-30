/**
 * Loads the key broker's key-encryption key (KEK) from the file named by
 * BROKER_KEK_FILE, once, at startup. Refuses (broker off, reason logged — never
 * the value) when the file is missing, unreadable, not 32 bytes of base64,
 * readable by group/others, or inside DATA_DIR (a database backup would then
 * carry the key next to what it protects).
 *
 * An empty file or a character device (compose mounts /dev/null when no KEK
 * is configured) means "not configured", like an unset variable.
 */
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { relative, resolve, isAbsolute } from 'path'
import type { BrokerStatusReason } from '../ports/key-broker'

export type KekLoad = { ok: true; kek: Buffer } | { ok: false; reason: BrokerStatusReason; detail: string }

const MAX_FILE_BYTES = 4096

function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Decode the file's text: base64 (standard or url-safe) of exactly 32 bytes, surrounding whitespace ignored. */
export function decodeKek(text: string): Buffer | null {
  const value = text.trim()
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return null
  const key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return key.length === 32 ? key : null
}

export function loadKekFile(path: string | null, dataDir: string): KekLoad {
  if (!path) return { ok: false, reason: 'not-configured', detail: 'BROKER_KEK_FILE is not set' }
  if (inside(dataDir, path)) {
    return { ok: false, reason: 'kek-insecure', detail: 'BROKER_KEK_FILE is inside DATA_DIR; database backups would contain it. Move it outside DATA_DIR' }
  }
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error'
    return { ok: false, reason: 'kek-unreadable', detail: `BROKER_KEK_FILE cannot be opened (${code})` }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) {
      if (st.isCharacterDevice()) return { ok: false, reason: 'not-configured', detail: 'BROKER_KEK_FILE is an empty mount (no KEK configured)' }
      return { ok: false, reason: 'kek-invalid', detail: 'BROKER_KEK_FILE is not a regular file' }
    }
    if (st.size === 0) return { ok: false, reason: 'not-configured', detail: 'BROKER_KEK_FILE is empty (no KEK configured)' }
    if ((st.mode & 0o077) !== 0) {
      return { ok: false, reason: 'kek-insecure', detail: `BROKER_KEK_FILE is readable by group or others (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it` }
    }
    if (st.size > MAX_FILE_BYTES) return { ok: false, reason: 'kek-invalid', detail: 'BROKER_KEK_FILE is not a key file (too large)' }
    const buf = Buffer.alloc(st.size)
    readSync(fd, buf, 0, st.size, 0)
    const kek = decodeKek(buf.toString('utf8'))
    buf.fill(0)
    if (!kek) return { ok: false, reason: 'kek-invalid', detail: 'BROKER_KEK_FILE must hold 32 random bytes as base64 (see src/cli/generate-broker-kek.ts)' }
    return { ok: true, kek }
  } finally {
    closeSync(fd)
  }
}
