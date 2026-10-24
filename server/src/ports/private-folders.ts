/** Private folders (lib/private-folders.ts): scopes with their own repository. */
export interface PrivateFolderRepository {
  /** The paths of the company's private folders, as stored. */
  paths(companyId: string): string[]
}
