// Names a member types for a new file, a new folder or a rename in the file
// tree. The company folder is shared with Macs and Windows PCs, so a name one
// of them cannot hold would break every teammate's sync there. Pure; the
// messages are shown as they are.

/** A new file, rename, move or copy would replace what is already there (main refuses it too). */
export const NAME_TAKEN_MESSAGE = '同じ名前のファイルまたはフォルダがすでにあります。別の名前にしてください。'

const WINDOWS_INVALID = /[<>:"|?*]/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_NAME_BYTES = 255

/**
 * Why `name` (one file or folder name, no '/') cannot be used, in the
 * member's words; null when it can.
 */
export function fileNameProblem(name: string): string | null {
  if (name.trim() === '') return '名前を入力してください。'
  if (/[/\\]/.test(name)) return '名前に「/」や「\\」は使えません。'
  if (name === '.' || name === '..' || name.toLowerCase() === '.git') return 'この名前は使えません。別の名前にしてください。'
  if (CONTROL.test(name)) return '名前に使えない文字が含まれています。'
  if (WINDOWS_INVALID.test(name)) return '名前に < > : " | ? * は使えません（Windows のパソコンで開けなくなります）。'
  if (/[ .]$/.test(name)) return '名前の最後に空白や「.」は使えません（Windows のパソコンで開けなくなります）。'
  if (WINDOWS_RESERVED.test(name)) return `「${name}」は Windows のパソコンで使えない名前です。別の名前にしてください。`
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return '名前が長すぎます。短くしてください。'
  return null
}

/** A folder path typed into 「新しいフォルダ」 may contain '/' (nested folders): each part is checked. */
export function folderPathProblem(value: string): string | null {
  const parts = value.split('/')
  if (parts.some(p => p === '')) return value.trim() === '' ? '名前を入力してください。' : '「/」の前後に名前を入れてください。'
  for (const part of parts) {
    const problem = fileNameProblem(part)
    if (problem) return problem
  }
  return null
}
