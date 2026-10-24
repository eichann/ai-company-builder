/**
 * Where the companies' git repositories live, and the server's own changes
 * to them. The implementation (adapters/git-repo-store.ts) keeps bare
 * repositories under REPOS_DIR and working clones under WORKDIR_DIR, runs git
 * asynchronously (never execFileSync in a request) and serializes
 * working-clone work per company (lib/company-lock.ts).
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
}
