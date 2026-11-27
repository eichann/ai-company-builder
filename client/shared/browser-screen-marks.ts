/**
 * The operator's screen image of 「ブラウザ操作」 (agent-browser.md "The operator sees the screen"): numbered marks drawn
 * onto the captured pixels — never into the page — so each usable element the operator is shown in text (`ref`) is found
 * on the picture by the same number (set-of-marks). Pure (no Node, DOM or Electron): the shell captures the window and hands
 * its bitmap here; nothing is stored.
 *
 * Why marks on the pixels: the model reads a number next to a box far more reliably than it maps coordinates in text onto
 * a picture, and drawing on the captured bitmap leaves the page's DOM untouched (an overlay in the page would be seen and
 * could be moved or hidden by the page's own script, and an SPA may re-render around it).
 */
import type { BrowserPageSnapshot } from './browser-browse'

/** One mark in the image's own pixels. */
export interface BrowserScreenMark {
  ref: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * The marks for an image of `imageWidth` × `imageHeight` pixels of the page's viewport: each on-screen element's box
 * scaled by the image's width over the viewport's (CSS pixels), clipped to the image; none when the page gave no viewport.
 */
export function screenMarks(page: BrowserPageSnapshot, imageWidth: number, imageHeight: number): BrowserScreenMark[] {
  if (!page.viewport || imageWidth <= 0 || imageHeight <= 0) return []
  const scale = imageWidth / page.viewport[0]
  const marks: BrowserScreenMark[] = []
  for (const e of page.elements) {
    if (!e.box) continue
    const x0 = Math.max(0, Math.round(e.box[0] * scale))
    const y0 = Math.max(0, Math.round(e.box[1] * scale))
    const x1 = Math.min(imageWidth - 1, Math.round((e.box[0] + e.box[2]) * scale))
    const y1 = Math.min(imageHeight - 1, Math.round((e.box[1] + e.box[3]) * scale))
    if (x1 <= x0 || y1 <= y0) continue
    marks.push({ ref: e.ref, x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }
  return marks
}

// 3 × 5 digits, one row per string.
const DIGITS: readonly (readonly string[])[] = [
  ['111', '101', '101', '101', '111'], ['010', '110', '010', '010', '111'], ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'], ['101', '101', '111', '001', '001'], ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'], ['111', '001', '010', '010', '010'], ['111', '101', '111', '101', '111'],
  ['111', '101', '111', '001', '111'],
]
const SCALE = 3
const PAD = 2
/** BGRA (the bitmap order Chromium hands out on little-endian machines). */
const MARK = [0x20, 0x20, 0xe0, 0xff] as const
const TEXT = [0xff, 0xff, 0xff, 0xff] as const

/** The size of a label for `ref` (pixels). */
export function markLabelSize(ref: number): { w: number; h: number } {
  const digits = String(ref).length
  return { w: PAD * 2 + digits * 3 * SCALE + (digits - 1) * SCALE, h: PAD * 2 + 5 * SCALE }
}

/**
 * Draws each mark onto a BGRA bitmap of `width` × `height` in place: a 2-pixel outline and, at its top-left corner (above
 * the box when there is room), its number in white on the mark's colour. Pixels outside the bitmap are never touched.
 */
export function drawScreenMarks(bitmap: Uint8Array, width: number, height: number, marks: readonly BrowserScreenMark[]): void {
  if (bitmap.length < width * height * 4) return
  const put = (x: number, y: number, c: readonly number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const o = (y * width + x) * 4
    bitmap[o] = c[0]; bitmap[o + 1] = c[1]; bitmap[o + 2] = c[2]; bitmap[o + 3] = c[3]
  }
  const fill = (x: number, y: number, w: number, h: number, c: readonly number[]) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c)
  }
  for (const m of marks) {
    fill(m.x, m.y, m.w, 2, MARK)
    fill(m.x, m.y + m.h - 1, m.w, 2, MARK)
    fill(m.x, m.y, 2, m.h, MARK)
    fill(m.x + m.w - 1, m.y, 2, m.h, MARK)
    const label = markLabelSize(m.ref)
    const lx = m.x
    const ly = m.y - label.h >= 0 ? m.y - label.h : m.y
    fill(lx, ly, label.w, label.h, MARK)
    String(m.ref).split('').forEach((d, k) => {
      const glyph = DIGITS[Number(d)]
      const gx = lx + PAD + k * 4 * SCALE
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) if (glyph[row][col] === '1') fill(gx + col * SCALE, ly + PAD + row * SCALE, SCALE, SCALE, TEXT)
      }
    })
  }
}
