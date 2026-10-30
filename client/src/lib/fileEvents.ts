/**
 * The renderer's single subscription to file-watcher events (`fs:changes`,
 * sent by the company's recursive watcher in batches of ≤ ~100 ms).
 * Consumers subscribe here instead of each adding their own IPC listener;
 * per-path versions (fileVersions) are bumped before any consumer runs, so a
 * consumer that re-renders on an event already sees the new version.
 */
import { isPerfCutEnabled, perfMark } from './perfDiagnostics'
import { fileVersions } from './fileVersions'
import { listenToFileChanges } from '../shared/ipc/file-events'
import type { FileChangeEvent } from '../../shared/ipc-contract'

type Listener = (changes: FileChangeEvent[]) => void

const listeners = new Set<Listener>()
let unsubscribeIpc: (() => void) | null = null

/** Deliver a batch to every subscriber. Exported for previews and tests. */
export function dispatchFileChanges(changes: FileChangeEvent[]): void {
  if (changes.length === 0) return
  perfMark('file_events.batch')
  if (isPerfCutEnabled('fsEvents')) {
    perfMark('file_events.batch.skipped')
    return
  }
  fileVersions.bump(changes)
  for (const listener of [...listeners]) {
    try {
      listener(changes)
    } catch (error) {
      console.warn('[file-events] listener failed:', error)
    }
  }
}

function ensureIpcSubscription(): void {
  if (unsubscribeIpc || typeof window === 'undefined') return
  unsubscribeIpc = listenToFileChanges(dispatchFileChanges)
}

/** Receive every batch of file changes; returns the unsubscribe function. */
export function subscribeFileChanges(listener: Listener): () => void {
  ensureIpcSubscription()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
