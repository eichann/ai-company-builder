/**
 * Where the companies' git repositories live, and the server's own changes
 * to them. The implementation (adapters/git-repo-store.ts) keeps bare
 * repositories under REPOS_DIR and working clones under WORKDIR_DIR, runs git
 * asynchronously (never execFileSync in a request) and serializes
 * working-clone work per company (lib/company-lock.ts).
 *
 * Reads come from the shared branch of the bare repository (no working
 * clone, no pull). Writes happen in the working clone — pulled first, under
 * the company lock — and are pushed as the server's own push.
 */
export interface RepoStore {
  /**
   * Create the company's bare repository when it does not exist yet (branch
   * main, HTTP push, force-push protection, pre-receive hook). Returns its
   * path.
   */
  createCompanyRepo(companyId: string): Promise<string>
  /**
   * The new company's first commit: `.gitattributes` (LF everywhere) and one
   * department folder (`.gitkeep`, `.personal/.gitignore`) per name, pushed
   * as the server's own push, under the company lock.
   */
  seedCompanyRepo(companyId: string, bareRepoPath: string, departmentFolders: string[]): Promise<void>

  companyRepoExists(companyId: string): boolean
  /** The non-hidden root folders of the shared branch. Throws 'Repository not found' without a repository. */
  listRootFolders(companyId: string): Promise<string[]>
  /** Files and folders under a folder of the shared branch, or null when it is not there. */
  countFilesInFolder(companyId: string, folder: string): Promise<{ files: number; folders: number } | null>

  /** Add a department folder (`.gitkeep`, `.personal/.gitignore`), commit, push. False when the folder exists. */
  createDepartmentFolder(companyId: string, folder: string, commitMessage: string): Promise<boolean>
  /** `git mv` a department folder (when it exists), commit, push. False when the target exists. */
  renameDepartmentFolder(companyId: string, from: string, to: string, commitMessage: string): Promise<boolean>
  /** Delete a department folder, commit, push. Counts what was deleted (0/0 when it was not there). */
  deleteDepartmentFolder(companyId: string, folder: string, commitMessage: string): Promise<{ deletedFiles: number; deletedFolders: number }>
}
