// Which paths the renderer may hand to the main process (fs:*, local-file://,
// git:*, backup:*, skills:*, tools:*): only paths inside a registered company
// root — and, since a teammate can commit a symbolic link, only paths whose
// REAL location (links resolved) stays inside that same root. A lexical check
// alone let a link `営業/メモ.md -> ~/.zshrc` be read and overwritten through
// the editor, and served by local-file://.
//
// Kept free of Electron so it can be tested directly
// (tests/ipc-fs.test.ts goes through main.ts; this file has no state of its
// own beyond the root set).

import fs from 'node:fs'
import path from 'node:path'

/** Lexically outside every root (wording kept: the renderer and tests know it). */
export const OUTSIDE_ROOTS_MESSAGE = 'Access denied: path is outside allowed directories'
/** Inside a root by name, but a link takes it somewhere else. */
export const LINK_ESCAPE_MESSAGE = 'このファイル（またはフォルダ）は会社フォルダの外を指すリンク（シンボリックリンク）のため、アプリでは開いたり変更したりできません。'

const MAX_LINK_HOPS = 40

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/**
 * The real location of `p`: every link resolved, including a dangling link
 * at the end or along the way (writing through one creates its target). For
 * a path that does not exist yet, the deepest existing ancestor is resolved
 * and the missing components are appended as typed — they cannot be links.
 * Throws on anything else (permission denied, a link loop).
 */
export function realLocation(p: string, hops = 0): string {
  try {
    return fs.realpathSync.native(p)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  const parent = path.dirname(p)
  if (parent === p) return p
  let stat: fs.Stats | null = null
  try { stat = fs.lstatSync(p) } catch { stat = null }
  if (stat?.isSymbolicLink()) {
    if (hops >= MAX_LINK_HOPS) throw Object.assign(new Error(`Too many levels of symbolic links: ${p}`), { code: 'ELOOP' })
    // A relative target is relative to the link's own (real) folder.
    return realLocation(path.resolve(realLocation(parent, hops + 1), fs.readlinkSync(p)), hops + 1)
  }
  return path.join(realLocation(parent, hops), path.basename(p))
}

function inside(child: string, root: string): boolean {
  const c = child.normalize('NFC')
  const r = root.normalize('NFC')
  if (c === r) return true
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

export interface ValidateOptions {
  /**
   * false: judge the entry itself, not what a link there points to — for
   * operations that act on the entry (delete, rename / move source), so a
   * link inside the company can still be removed or renamed.
   */
  followFinal?: boolean
}

export class AllowedRoots implements Iterable<string> {
  private readonly roots = new Set<string>()
  /** Real path of each root, once it exists (a root may be registered before its folder is created). */
  private readonly realRoots = new Map<string, string>()

  add(dirPath: string): void {
    const resolved = path.resolve(dirPath)
    this.roots.add(resolved)
    this.realRoots.delete(resolved)
  }

  [Symbol.iterator](): Iterator<string> {
    return this.roots[Symbol.iterator]()
  }

  private realRoot(root: string): string {
    const cached = this.realRoots.get(root)
    if (cached) return cached
    try {
      const real = fs.realpathSync.native(root)
      this.realRoots.set(root, real)
      return real
    } catch {
      return realLocation(root)
    }
  }

  /** The roots `resolved` is inside by name (several when roots nest). */
  private lexicalRoots(resolved: string): string[] {
    const out: string[] = []
    for (const root of this.roots) {
      if (resolved === root || resolved.startsWith(root + path.sep)) out.push(root)
    }
    return out
  }

  /**
   * `inputPath` resolved (as typed — results keep the member's spelling), if
   * it is inside a registered root both by name and by its real location;
   * throws otherwise.
   */
  validate(inputPath: string, options: ValidateOptions = {}): string {
    if (typeof inputPath !== 'string' || inputPath === '') throw new Error(OUTSIDE_ROOTS_MESSAGE)
    const resolved = path.resolve(inputPath)
    const roots = this.lexicalRoots(resolved)
    if (roots.length === 0) throw new Error(OUTSIDE_ROOTS_MESSAGE)
    const followFinal = options.followFinal !== false || roots.includes(resolved)
    let real: string
    try {
      real = followFinal ? realLocation(resolved) : path.join(realLocation(path.dirname(resolved)), path.basename(resolved))
    } catch {
      throw new Error(LINK_ESCAPE_MESSAGE)
    }
    for (const root of roots) {
      let realRoot: string
      try { realRoot = this.realRoot(root) } catch { continue }
      if (inside(real, realRoot)) return resolved
    }
    console.warn('[fs] Refused a path whose real location is outside the company folder')
    throw new Error(LINK_ESCAPE_MESSAGE)
  }

  /** The registered root `resolved` lies in (the innermost), or null. */
  rootOf(inputPath: string): string | null {
    const roots = this.lexicalRoots(path.resolve(inputPath))
    return roots.sort((a, b) => b.length - a.length)[0] ?? null
  }
}
