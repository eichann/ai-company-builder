// Is a git process working in this folder right now? The last check before a
// lock is removed or a stopped operation is cleaned up: the AI's or the member's
// own git, or a git the app left behind, are things the app knows nothing about.
// A git inside a nested repository (a private folder's clone, say) works on that
// repository, so it does not count. Not seen by this: a git started from elsewhere
// with GIT_DIR, and a folder name lsof escapes (a backslash, tab or line break).
// The lock's age and `otherGitRunning` still apply there.

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'

export type LiveGit = 'yes' | 'no' | 'unknown'

/** `cwd` lies in a repository of its own below `root`. */
function inNestedRepo(cwd: string, root: string): boolean {
  for (let dir = cwd; dir !== root && dir.startsWith(`${root}${path.sep}`); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true
  }
  return false
}

/** lsof's answer. Exit 1 only means it found nothing; a computer without lsof cannot be asked, and that must not stop sync for good. */
export function readLsofAnswer(error: (Error & { code?: number | string | null; killed?: boolean }) | null, stdout: string, root: string): LiveGit {
  const cwds = stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1).normalize('NFC'))
  if (cwds.some(cwd => (cwd === root || cwd.startsWith(`${root}${path.sep}`)) && !inNestedRepo(cwd, root))) return 'yes'
  if (!error || error.code === 1 || error.code === 'ENOENT') return 'no'
  return 'unknown'
}

export function gitRunningIn(repoPath: string): Promise<LiveGit> {
  if (process.platform === 'win32') return Promise.resolve('no')
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof'
  let root: string
  try { root = fs.realpathSync(repoPath).normalize('NFC') } catch { return Promise.resolve('unknown') }
  return new Promise(resolve => {
    // -c git also matches git-remote-https and friends.
    execFile(lsof, ['-a', '-c', 'git', '-d', 'cwd', '-Fn'], { timeout: 3000, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }, (error, stdout) => {
      resolve(readLsofAnswer(error, String(stdout), root))
    })
  })
}
