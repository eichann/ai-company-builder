/**
 * The app's plugin trust record on disk (`.claude/rules/plugin-trust.md` "P2"):
 * `<userData>/trust/record.json` and, in its own small file, `<userData>/trust/halt.json` —
 * outside every company folder and apart from the package store (`<userData>/plugins/`, whose
 * sweep never reaches here: nothing in this folder is ever removed for being unlisted).
 *
 * - **Reading never treats unreadable as empty**: a record that exists but cannot be read is
 *   handed on as text that does not parse (`startTrust` then starts from the app's root with
 *   `problem` set: unknown, not empty); a halt file that exists but cannot be read, or is empty,
 *   is handed on as a non-empty unreadable text (`startTrust`: a halt at the app's root version).
 *   Only a missing file (ENOENT) is "none".
 * - **Atomic writes**: each file is written to a fresh `.tmp` beside it, flushed (`fsync`), then
 *   renamed over the old one; the folder is flushed after. An interrupted write leaves the previous
 *   file whole; a leftover `.tmp` is never read and is swept at the next load.
 * - **Order**: a halt is written before the record (a crash in between keeps the halt); the halt
 *   file is removed only when the state is not halted (an app carrying a root newer than the halt).
 * - A record the start could not use is kept aside once as `record.unusable.json` (replacing the
 *   previous one) before anything new is written over it, for diagnosis.
 */
import nodeFs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { StoredTrust } from '../../../../shared/core/plugin-trust'

export const TRUST_RECORD_FILE = 'record.json'
export const TRUST_HALT_FILE = 'halt.json'
export const TRUST_UNUSABLE_FILE = 'record.unusable.json'
/** What an existing halt file that cannot be read becomes: never empty, never JSON (a halt at the app's version). */
export const UNREADABLE_HALT = '<the halt file exists but could not be read>'
/** What an existing record that cannot be read becomes: not JSON (the start notes the problem). */
export const UNREADABLE_RECORD = '<the record exists but could not be read>'

/** The few file operations used (tests replace one to interrupt a write). */
export type TrustFs = Pick<typeof nodeFs,
  'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'openSync' | 'fsyncSync' | 'closeSync' | 'rmSync' | 'readdirSync' | 'copyFileSync'>

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

export function createTrustFiles(dir: () => string, fs: TrustFs = nodeFs) {
  const file = (name: string) => path.join(dir(), name)

  function readOne(name: string, unreadable: string): string | null {
    try {
      const text = fs.readFileSync(file(name), 'utf8')
      return text.trim() === '' ? unreadable : text
    } catch (err) {
      return isMissing(err) ? null : unreadable
    }
  }

  function syncDir(): void {
    try {
      const fd = fs.openSync(dir(), 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } catch { /* not every platform can flush a folder */ }
  }

  function writeAtomic(name: string, text: string): void {
    const tmp = file(`${name}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, text, 'utf8')
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, file(name))
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* swept at the next load */ }
      throw err
    }
    syncDir()
  }

  return {
    /** What was stored: null for a file that does not exist; unreadable files as unreadable text (never null). */
    read(): StoredTrust {
      // A leftover .tmp is an interrupted write: never read; swept here.
      try {
        for (const n of fs.readdirSync(dir())) if (n.endsWith('.tmp')) fs.rmSync(file(n), { force: true })
      } catch { /* no folder yet */ }
      return { record: readOne(TRUST_RECORD_FILE, UNREADABLE_RECORD), halt: readOne(TRUST_HALT_FILE, UNREADABLE_HALT) }
    },
    /** Keep the record the start could not use (diagnosis), before anything is written over it. */
    keepUnusable(): void {
      try { fs.copyFileSync(file(TRUST_RECORD_FILE), file(TRUST_UNUSABLE_FILE)) } catch { /* nothing to keep */ }
    },
    /** Write what `serializeTrustState` gave: the halt first, then the record. */
    write(stored: { record: string; halt: string | null }): void {
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
      if (stored.halt !== null) writeAtomic(TRUST_HALT_FILE, stored.halt)
      writeAtomic(TRUST_RECORD_FILE, stored.record)
      if (stored.halt === null) {
        fs.rmSync(file(TRUST_HALT_FILE), { force: true })
        syncDir()
      }
    },
  }
}

export type TrustFiles = ReturnType<typeof createTrustFiles>
