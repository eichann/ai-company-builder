// Department folder names: the server's own rule (shared/core/names.ts) —
// ASCII word characters and Japanese, plus "." "_" "-" after the first
// character. The admin image copies shared/ into its build (admin/Dockerfile).
export { isValidFolderName, suggestFolderName } from '../../../shared/core/names'
