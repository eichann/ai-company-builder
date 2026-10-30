// How the editor shows a file, by its extension.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return IMAGE_EXTENSIONS.has(ext)
}

export function isPdfFile(filePath: string): boolean {
  return filePath.split('.').pop()?.toLowerCase() === 'pdf'
}

/** Images and PDFs: shown from disk (local-file:// URL or bytes), never loaded as text. */
export function isBinaryFile(filePath: string): boolean {
  return isImageFile(filePath) || isPdfFile(filePath)
}

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return ext === 'md' || ext === 'mdx'
}

export const fileNameOf = (path: string) => path.split('/').pop() || ''
