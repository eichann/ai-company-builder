// The `origin` remote of a company (or private folder) repository.
//
// Never `git remote remove` + `git remote add` to change origin's URL:
// `remote remove` deletes the whole [remote "origin"] section, and in a
// partial clone (./first-setup.ts) that section is what makes origin a
// promisor remote (remote.origin.promisor / partialclonefilter). Without it
// git can no longer fetch the blobs the member did not download, so
// downloading a department later failed with "unable to read sha1 file of
// 営業部/…" — the setup path ran again when a company was reopened and
// silently turned every partial clone into a broken one (2026-10-22). It
// also deletes refs/remotes/origin/* and branch.*.remote. `git remote
// set-url` changes the URL and nothing else.
//
// ensurePromisorConfig repairs repositories that already lost the config.

import fs from 'fs'
import type { SimpleGit } from 'simple-git'
import type { SyncLogger } from './types'

async function configValue(git: SimpleGit, args: string[]): Promise<string> {
  return (await git.raw(['config', ...args]).catch(() => '')).trim()
}

/**
 * Point `name` (origin) at `url`: add it when missing, `remote set-url` when
 * the URL differs, nothing when it matches. Every other remote.<name>.* key
 * (promisor, partialclonefilter, fetch refspecs) is left as it is.
 */
export async function setRemoteUrl(git: SimpleGit, url: string, name = 'origin'): Promise<'added' | 'updated' | 'unchanged'> {
  const current = await configValue(git, ['--get', `remote.${name}.url`])
  if (current === url) return 'unchanged'
  if (current) {
    await git.raw(['remote', 'set-url', name, url])
    return 'updated'
  }
  try {
    await git.addRemote(name, url)
  } catch (error) {
    // A section without a URL (only promisor keys left, say): `remote add`
    // refuses it as existing. Fill in the URL and the default refspec.
    if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error
    await git.raw(['config', `remote.${name}.url`, url])
    if (!(await configValue(git, ['--get-all', `remote.${name}.fetch`]))) {
      await git.raw(['config', '--add', `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`])
    }
  }
  return 'added'
}

/**
 * What git:setupCompanyRemote does to origin, on a fresh folder and on every
 * reopen of an existing clone: point it at the company's URL, and repair a
 * partial clone that lost its promisor config.
 */
export async function configureOrigin(git: SimpleGit, url: string, log: SyncLogger = console): Promise<'added' | 'updated' | 'unchanged'> {
  const change = await setRemoteUrl(git, url)
  await ensurePromisorConfig(git, log).catch(e => log.warn('Git setup: promisor config check failed:', e))
  return change
}

/** True when the object store holds packs fetched from a promisor remote (a partial clone). */
export async function hasPromisorPacks(git: SimpleGit): Promise<boolean> {
  let packDir: string
  try {
    packDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-path', 'objects/pack'])).trim()
  } catch {
    return false
  }
  try {
    return fs.readdirSync(packDir).some(f => f.endsWith('.promisor') && f.startsWith('pack-'))
  } catch {
    return false
  }
}

/**
 * A partial clone whose promisor config was lost (an older app version ran
 * `remote remove` + `remote add` on origin): put back exactly what
 * `git fetch --filter=blob:none origin` writes — remote.origin.promisor=true
 * and remote.origin.partialclonefilter=blob:none (git 2.53 writes no
 * extensions.partialClone; core.repositoryformatversion=1 survives the
 * removal). Only for a repository that has promisor packs and an origin URL;
 * a full clone is never touched. Returns true when something was restored.
 */
export async function ensurePromisorConfig(git: SimpleGit, log: SyncLogger = console): Promise<boolean> {
  const promisor = await configValue(git, ['--type=bool', '--get', 'remote.origin.promisor'])
  const filter = await configValue(git, ['--get', 'remote.origin.partialclonefilter'])
  if (promisor === 'true' && filter) return false
  if (!(await configValue(git, ['--get', 'remote.origin.url']))) return false
  if (!(await hasPromisorPacks(git))) return false
  const restored: string[] = []
  if (promisor !== 'true') {
    await git.raw(['config', 'remote.origin.promisor', 'true'])
    restored.push('remote.origin.promisor=true')
  }
  if (!filter) {
    await git.raw(['config', 'remote.origin.partialclonefilter', 'blob:none'])
    restored.push('remote.origin.partialclonefilter=blob:none')
  }
  log.warn(`Git: partial clone had lost its promisor config, restored ${restored.join(', ')}`)
  return true
}
