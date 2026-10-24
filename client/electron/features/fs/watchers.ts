// One recursive watcher per open company folder (company-watcher.ts), kept
// open across department switches; a folder inside an already watched one
// is covered by it.

import path from 'path'
import chokidar from 'chokidar'
import { CompanyWatcher, coveringRoot, type FileChange, type RawEventType } from '../../company-watcher'

/**
 * Where recursive fs.watch is unavailable (Linux before Node 20): chokidar on
 * the company root, its events fed into the same classifier.
 */
function chokidarFallback(root: string, onRaw: (type: RawEventType, rel: string) => void, onError: (error: unknown) => void) {
  const watcher = chokidar.watch(root, {
    // Same directories as the recursive watcher; non-regular files (sockets
    // in temporary browser profiles) make fs.watch throw.
    ignored: (targetPath, stats) =>
      /(^|[\\/])(\.git|node_modules|\.workspace|\.backups)([\\/])/i.test(targetPath)
      || !!(stats && !stats.isFile() && !stats.isDirectory()),
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    followSymlinks: false,
    ignorePermissionErrors: true,
  })
  watcher.on('error', onError)
  const rel = (p: string) => path.relative(root, p)
  watcher.on('add', p => onRaw('rename', rel(p)))
  watcher.on('addDir', p => onRaw('rename', rel(p)))
  watcher.on('unlink', p => onRaw('rename', rel(p)))
  watcher.on('unlinkDir', p => onRaw('rename', rel(p)))
  watcher.on('change', p => onRaw('change', rel(p)))
  return { close: () => { void watcher.close() } }
}

export interface CompanyWatchers {
  /** Watch a (validated) company folder. Idempotent. */
  watch(root: string): void
  unwatch(root: string): void
  /** On quit: a native recursive watcher closes in well under a millisecond. */
  closeAll(): void
}

export function createCompanyWatchers(onChanges: (changes: FileChange[]) => void): CompanyWatchers {
  const companyWatchers: Map<string, CompanyWatcher> = new Map()
  return {
    watch(safePath) {
      if (coveringRoot(companyWatchers.keys(), safePath)) return
      // A parent opened after a child replaces the child's watcher.
      for (const [root, watcher] of companyWatchers) {
        if (root.startsWith(safePath + path.sep)) {
          watcher.close()
          companyWatchers.delete(root)
        }
      }
      const watcher = new CompanyWatcher({ root: safePath, onChanges, fallback: chokidarFallback })
      watcher.start()
      companyWatchers.set(safePath, watcher)
      console.log(`[fs-watch] watching ${safePath} (${watcher.mode ?? 'retrying'})`)
    },
    unwatch(safePath) {
      const watcher = companyWatchers.get(safePath)
      if (watcher) {
        watcher.close()
        companyWatchers.delete(safePath)
      }
    },
    closeAll() {
      companyWatchers.forEach((watcher) => watcher.close())
      companyWatchers.clear()
    },
  }
}
