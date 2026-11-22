/**
 * The HTML viewer's rules (doc-frame.md "The viewer (A2)"): where its document
 * view goes, the zoom steps, which file changes reload it. The document is a native view drawn ABOVE the app's page: a menu,
 * a dialog, ⌘K or a toast the app draws over its area would be hidden behind
 * it. So the view is shown only while nothing of the app covers its area —
 * judged by hit-testing a grid of points over the area: the first thing at
 * each point must be the area itself (or inside it). Tooltips do not count
 * (they would make the document blink while the pointer moves over the
 * toolbar); they are drawn behind the document where they overlap it.
 */
import { docFileType, type DocViewBounds } from '../../../shared/doc-frame'
import { isPathWithin, normalizePathSeparators } from '../../shared/lib/path'

/** Grid spacing (CSS px): an overlay smaller than this both ways can slip between the points. */
export const COVER_STEP = 48
/** At most this many points per check (a very large area gets a coarser grid). */
const MAX_POINTS = 640

/** Points over `rect` (2 px inside its edges), about `COVER_STEP` apart, corners and middle included. */
export function samplePoints(rect: DocViewBounds, step = COVER_STEP): Array<[number, number]> {
  const inner = { x: rect.x + 2, y: rect.y + 2, width: Math.max(0, rect.width - 4), height: Math.max(0, rect.height - 4) }
  let columns = Math.max(1, Math.ceil(inner.width / step))
  let rows = Math.max(1, Math.ceil(inner.height / step))
  const scale = Math.sqrt(Math.max(1, ((columns + 1) * (rows + 1)) / MAX_POINTS))
  columns = Math.max(1, Math.floor(columns / scale))
  rows = Math.max(1, Math.floor(rows / scale))
  const points: Array<[number, number]> = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) points.push([inner.x + (inner.width * c) / columns, inner.y + (inner.height * r) / rows])
  }
  return points
}

/** What is stacked at a point, topmost first (`document.elementsFromPoint`). */
export type StackAt = (x: number, y: number) => readonly Element[]

const isTooltip = (el: Element) => el.closest('[role="tooltip"]') !== null

/** The app's overlays that say what they are: found by their box, however small. */
export const OVERLAY_SELECTOR = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'

const overlaps = (a: DocViewBounds, b: DOMRect) => b.width > 0 && b.height > 0
  && b.left < a.x + a.width && b.right > a.x && b.top < a.y + a.height && b.bottom > a.y

/**
 * True when something of the app is drawn over `area`: a menu or dialog whose
 * box overlaps it, or anything at a grid point (overlays without a role).
 */
export function areaCovered(area: Element, rect: DocViewBounds, stackAt: StackAt, overlays: Iterable<Element> = []): boolean {
  for (const el of overlays) {
    if (el !== area && !area.contains(el) && !el.contains(area) && overlaps(rect, el.getBoundingClientRect())) return true
  }
  for (const [x, y] of samplePoints(rect)) {
    const top = stackAt(x, y).find(el => !isTooltip(el))
    if (top && top !== area && !area.contains(top)) return true
  }
  return false
}

/**
 * The placement to ask for: the area's rectangle, or null (hide) when it is
 * not on screen — removed, not laid out (another tab, a wide panel), the page
 * hidden — or covered.
 */
export function placementOf(area: Element | null, doc: Pick<Document, 'visibilityState' | 'elementsFromPoint' | 'querySelectorAll'>): DocViewBounds | null {
  if (!area || !area.isConnected || doc.visibilityState === 'hidden') return null
  const box = area.getBoundingClientRect()
  const rect = { x: box.left, y: box.top, width: box.width, height: box.height }
  if (rect.width < 1 || rect.height < 1) return null
  return areaCovered(area, rect, (x, y) => doc.elementsFromPoint(x, y), doc.querySelectorAll(OVERLAY_SELECTOR)) ? null : rect
}

export function sameBounds(a: DocViewBounds | null, b: DocViewBounds | null): boolean {
  if (a === null || b === null) return a === b
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y)
    && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height)
}

/** The next zoom step from `factor` (1 = 「元の大きさ」). */
export function nextZoom(steps: readonly number[], factor: number, direction: 1 | -1): number {
  if (direction > 0) return steps.find(s => s > factor + 1e-6) ?? steps[steps.length - 1]
  return [...steps].reverse().find(s => s < factor - 1e-6) ?? steps[0]
}

/**
 * Whether a file change shows in the document: the file itself, or a file it
 * can load (a served type: its styles, scripts, pictures, other pages) in its
 * folder or below. Data files and anything elsewhere do not reload it.
 */
export function changeShowsIn(documentPath: string, changedPath: string): boolean {
  const doc = normalizePathSeparators(documentPath)
  const changed = normalizePathSeparators(changedPath)
  if (changed === doc) return true
  const folder = doc.slice(0, doc.lastIndexOf('/'))
  return folder !== '' && changed !== folder && isPathWithin(changed, folder) && docFileType(changed.slice(changed.lastIndexOf('/') + 1)) !== null
}
