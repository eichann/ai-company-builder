// git:preview — "what will the next sync share?", strictly read-only.
//
// It used to run `git add --sparse .` and read `git status`. That staged a
// file created inside a folder that is not downloaded on this computer, and
// sync's outside-checkout hold-back (./outside-checkout.ts) compares the disk
// with the index: a staged file read as unchanged and the next sync shared it
// with the whole company — over a teammate's file the member never had. The
// same staging hid new paths from the reserved-path hold-back. Preview now
// only reads `git status` (untracked files count as added); nothing in the
// index or on disk changes. See the guards table in CLAUDE.md.

import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import type { SimpleGit } from 'simple-git'

export interface PreviewChanges {
  added: string[]
  modified: string[]
  deleted: string[]
}

/**
 * Parse `git status --porcelain=v1 -z --no-renames`: `XY <path>\0` per
 * entry (no rename pairs with --no-renames). Untracked (`??`) and added in
 * the index (`A`) → added; deleted in the index or on disk → deleted;
 * anything else (modified, type change, unmerged) → modified.
 */
export function parsePorcelainStatus(raw: string): PreviewChanges {
  const out: PreviewChanges = { added: [], modified: [], deleted: [] }
  for (const entry of raw.split('\0')) {
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const file = entry.slice(3)
    if (x === '!') continue
    if (x === '?' || x === 'A') {
      // Added and then deleted on disk before anything was committed: nothing to share.
      if (y !== 'D') out.added.push(file)
    } else if (x === 'D' || y === 'D') {
      out.deleted.push(file)
    } else {
      out.modified.push(file)
    }
  }
  return out
}

/**
 * The changes the member has made, without staging anything. `-uall` lists
 * every new file (not just its folder), as `git add` would stage them;
 * `--no-renames` keeps a partial clone from downloading blobs to detect
 * renames; `--no-optional-locks` keeps status from even refreshing the index.
 */
export async function previewChanges(git: SimpleGit): Promise<PreviewChanges> {
  const raw = await git.raw(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  return parsePorcelainStatus(raw)
}

/**
 * Run `fn` with a git whose index is a throwaway copy of the real one
 * (GIT_INDEX_FILE), so the summary of "what sync would commit" can stage
 * everything — as sync will — without touching the member's index. The copy
 * is removed afterwards, also when `fn` fails.
 */
export async function withScratchIndex<T>(options: {
  git: SimpleGit
  repoPath: string
  makeGit: (env: Record<string, string>) => SimpleGit
  fn: (scratch: SimpleGit) => Promise<T>
}): Promise<T> {
  const { git, repoPath, makeGit, fn } = options
  const index = path.resolve(repoPath, (await git.raw(['rev-parse', '--git-path', 'index'])).trim())
  const scratch = path.join(path.dirname(index), `acb-preview-index-${randomBytes(6).toString('hex')}`)
  try {
    if (fs.existsSync(index)) fs.copyFileSync(index, scratch)
    return await fn(makeGit({ GIT_INDEX_FILE: scratch }))
  } finally {
    fs.rmSync(scratch, { force: true })
    fs.rmSync(`${scratch}.lock`, { force: true })
  }
}
