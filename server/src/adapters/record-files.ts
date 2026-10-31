import { companyRepoPath } from '../lib/config'
import { privateRepoPath } from '../lib/private-folders'
import { readRecordFiles } from '../lib/record-files'
import type { RecordFileSource } from '../ports/record-files'

/** Record files from the company's bare repositories (lib/record-files.ts). */
export function gitRecordFileSource(): RecordFileSource {
  return {
    read: (companyId, repo, since) =>
      readRecordFiles(repo.kind === 'company' ? companyRepoPath(companyId) : privateRepoPath(companyId, repo.repoId), since),
  }
}
