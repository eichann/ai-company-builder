// How the editor shows a file, by its extension.
import { isVideoFileName } from '../../../shared/video-files'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return IMAGE_EXTENSIONS.has(ext)
}

export function isPdfFile(filePath: string): boolean {
  return filePath.split('.').pop()?.toLowerCase() === 'pdf'
}

/** A video the editor plays (`.mp4`, `.mov`): streamed from disk by `acb-media://`. */
export function isVideoFile(filePath: string): boolean {
  return isVideoFileName(filePath.split('/').pop() || '')
}

/** Images, PDFs and videos: shown from disk (a URL or bytes), never loaded as text. */
export function isBinaryFile(filePath: string): boolean {
  return isImageFile(filePath) || isPdfFile(filePath) || isVideoFile(filePath)
}

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return ext === 'md' || ext === 'mdx'
}

/** An HTML document: shown (見る) in a view of its own by default, its source (中身) in the editor. */
export function isHtmlFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return ext === 'html' || ext === 'htm'
}

export const fileNameOf = (path: string) => path.split('/').pop() || ''
