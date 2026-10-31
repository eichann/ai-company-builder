import { appendHistoryLine } from '../../shared/core/records'
import { commitFileEdit, type CommitIdentity } from '../lib/bare-commit'
import { withCompanyLock } from '../lib/company-lock'
import { companyRepoPath } from '../lib/config'
import { gitAsync } from '../lib/git-exec'
import { privateRepoPath } from '../lib/private-folders'
import { readRecordFiles } from '../lib/record-files'
import type { RecordFileCreator, RecordFileRepo, RecordFileSource, RecordFileWriter } from '../ports/record-files'

const repoPath = (companyId: string, repo: RecordFileRepo) =>
  (repo.kind === 'company' ? companyRepoPath(companyId) : privateRepoPath(companyId, repo.repoId))

/** Record files from the company's bare repositories (lib/record-files.ts). */
export function gitRecordFileSource(): RecordFileSource {
  return {
    read: (companyId, repo, since) => readRecordFiles(repoPath(companyId, repo), since),
  }
}

const HISTORY_IDENTITY: CommitIdentity = { name: 'AI Company Builder', email: 'system@ai-company-builder' }
// As the department commits (adapters/git-repo-store.ts): the push runs the checker.
const TIMEOUTS = { local: 60_000, push: 300_000 }

/** The engine's history lines as the server's own commits (lib/bare-commit.ts commitFileEdit). */
export function gitRecordFileWriter(): RecordFileWriter {
  return {
    appendHistoryLine: (companyId, repo, path, line) =>
      withCompanyLock(companyId, () => commitFileEdit(repoPath(companyId, repo), path, {
        message: '経緯に1行を追加しました',
        identity: HISTORY_IDENTITY,
        timeouts: TIMEOUTS,
      }, current => (current === null ? null : appendHistoryLine(current, line)))),
    async fileAtCommit(companyId, repo, path, commit) {
      if (!/^[0-9a-f]{40,64}$/.test(commit) || path.includes('\n')) return false
      try {
        const type = await gitAsync(['-C', repoPath(companyId, repo), 'cat-file', '-t', `${commit}:${path}`], { timeoutMs: TIMEOUTS.local })
        return type.trim() === 'blob'
      } catch {
        return false
      }
    },
  }
}

/** Record files the server writes itself (decisions): one commit, under the company lock, through the push checker. */
export function gitRecordFileCreator(): RecordFileCreator {
  return {
    createFile: (companyId, path, text, message) =>
      withCompanyLock(companyId, () => commitFileEdit(companyRepoPath(companyId), path, {
        message,
        identity: HISTORY_IDENTITY,
        timeouts: TIMEOUTS,
      }, current => (current === null ? text : null))),
  }
}
