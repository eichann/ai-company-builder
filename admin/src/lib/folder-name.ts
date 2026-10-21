// Department folder names: same rule as the server (isValidFolderName in
// server/src/routes/departments.ts) — ASCII word characters and Japanese, plus
// "." "_" "-" after the first character.
const FOLDER_RE = /^[\w぀-ゟ゠-ヿ一-鿿][\w぀-ゟ゠-ヿ一-鿿._-]*$/

export function isValidFolderName(folder: string): boolean {
  return FOLDER_RE.test(folder)
}

/** A folder name suggested from a department name ("営業 企画部" -> "営業-企画部"). */
export function suggestFolderName(name: string): string {
  return name
    .trim()
    .replace(/[^\w぀-ゟ゠-ヿ一-鿿._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')
}
