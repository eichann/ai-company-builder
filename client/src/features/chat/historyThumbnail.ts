// Images attached to a message are shown as 80 px thumbnails in the bubble and
// stored in the chat history as data URLs. The full image (often a 1–2 MB
// screenshot) goes to the AI only; history keeps a small copy, so one
// screenshot no longer adds megabytes to every save of the history file.
// Entries saved by older versions (full-size data URLs) still load as before.

/** Longest side of the stored copy: 80 px thumbnails at up to 4× pixel density. */
export const HISTORY_THUMBNAIL_MAX = 320

/** Target size; a data URL already below it is kept as it is. */
const KEEP_BELOW_CHARS = 64 * 1024

export function thumbnailSize(width: number, height: number, max = HISTORY_THUMBNAIL_MAX): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export async function historyThumbnail(dataUrl: string): Promise<string> {
  if (dataUrl.length <= KEEP_BELOW_CHARS) return dataUrl
  try {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const { width, height } = thumbnailSize(image.naturalWidth, image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return dataUrl
    context.drawImage(image, 0, 0, width, height)
    // WebP keeps transparency (JPEG would turn it black).
    const small = canvas.toDataURL('image/webp', 0.85)
    return small.startsWith('data:image/webp') && small.length < dataUrl.length ? small : dataUrl
  } catch {
    return dataUrl
  }
}
