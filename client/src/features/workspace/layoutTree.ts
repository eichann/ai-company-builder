// The screen's panes as a tree of row / column splits (owner decision D8):
// the chat is one leaf, so a later version can split it into two or four
// panes by changing the tree, not the skeleton. Sizes are saved per company;
// every size rule lives here (2026-11-22 layout proposal, B1):
//
//   - the consultation keeps the width the member chose; widening the window grows the middle;
//   - the left column is 200 px up to half the window (at most 720 px);
//   - the middle is never narrower than MIDDLE_MIN while the window has room for every minimum;
//     a smaller window takes the room from the consultation first, then the left column, never
//     below their minimums (what is saved stays: a wider window shows it again).
//
// What is saved is stale input (another window, another version): checked and clamped when read
// (`parseLayout`), and fitted to the window every time it is drawn (`fitLayout`).
import { clampWidth, collapsingDrag } from './panelResize'

export type SplitDirection = 'row' | 'column'
export interface PaneNode { type: 'pane'; id: string }
export interface SplitNode {
  type: 'split'
  id: string
  direction: SplitDirection
  children: LayoutNode[]
  /** px along the split's direction per child; null = takes the remaining space. */
  sizes: Array<number | null>
}
export type LayoutNode = PaneNode | SplitNode

export interface PaneLimits {
  min?: number
  max?: number
  /** Dragging this pane this far under its min hides it (the consultation). */
  collapseAfter?: number
}

/** The splits of the screen: `screen` (the whole window) and `files` (the left column and the middle). */
export interface WorkspaceLayout { screen: SplitNode; files: SplitNode }

/** Which panes are on screen: the member hid the left column or the consultation; a wide left tab covers the middle. */
export interface PaneView { leftShown: boolean; chatShown: boolean; middleShown: boolean }

/** 2: the consultation has the fixed width, the side the rest (1: the side was fixed). */
export const LAYOUT_VERSION = 2

/** The middle (open files and records) never gets narrower than this while the window has room. */
export const MIDDLE_MIN = 360
const LEFT_MAX = 720
const LEFT_MAX_SHARE = 0.5
// What the window spends besides the panes: a divider (ResizeHandle, w-1) and a hidden pane's strip (w-6).
const DIVIDER = 4
const STRIP = 24

export const PANE_LIMITS: Readonly<Record<string, PaneLimits>> = {
  // The side (left column + middle) takes what the consultation leaves; with a wide left tab it is all left column.
  side: { min: 300 },
  chat: { min: 280, collapseAfter: 60 },
  // min: the five standard left tabs fit stacked (icon over an 11 px name) without scrolling.
  fileTree: { min: 200, max: LEFT_MAX },
}

/** `hidden` with `paneId` shown or hidden (toggled when `shown` is not given); the same set when nothing changes. */
export function withPaneShown(hidden: ReadonlySet<string>, paneId: string, shown = hidden.has(paneId)): ReadonlySet<string> {
  if (shown === !hidden.has(paneId)) return hidden
  const next = new Set(hidden)
  if (shown) next.delete(paneId)
  else next.add(paneId)
  return next
}

const pane = (id: string): PaneNode => ({ type: 'pane', id })

/**
 * The look of a first start, of 「いつもの形に戻す」 and of a double-clicked divider (that pane only):
 * version 1's first look (the side = window − 420, so 416 px of consultation after the divider).
 */
export const DEFAULT_LAYOUT: WorkspaceLayout = {
  screen: { type: 'split', id: 'screen', direction: 'row', children: [pane('side'), pane('chat')], sizes: [null, 416] },
  files: { type: 'split', id: 'files', direction: 'row', children: [pane('fileTree'), pane('editor')], sizes: [260, null] },
}

export function paneSize(split: SplitNode, paneId: string): number | null {
  const index = split.children.findIndex(child => child.id === paneId)
  return index < 0 ? null : split.sizes[index]
}

export function withPaneSize(split: SplitNode, paneId: string, size: number): SplitNode {
  const index = split.children.findIndex(child => child.id === paneId)
  if (index < 0 || split.sizes[index] === size) return split
  return { ...split, sizes: split.sizes.map((s, i) => (i === index ? size : s)) }
}

/**
 * The pane a divider resizes: the fixed-size one beside it, and whether the
 * pointer offset grows it (it is before the divider) or shrinks it (after).
 */
export function resizedBy(split: SplitNode, dividerIndex: number): { paneId: string; sign: 1 | -1 } | null {
  const before = split.children[dividerIndex]
  const after = split.children[dividerIndex + 1]
  if (before && split.sizes[dividerIndex] != null) return { paneId: before.id, sign: 1 }
  if (after && split.sizes[dividerIndex + 1] != null) return { paneId: after.id, sign: -1 }
  return null
}

const leftMax = (windowWidth: number) =>
  Math.max(PANE_LIMITS.fileTree.min!, Math.min(LEFT_MAX, Math.floor(windowWidth * LEFT_MAX_SHARE)))

/** Room the side needs besides a shown left column: the middle's minimum, or the side's with a wide left tab. */
const sideNeed = (view: PaneView) => (view.middleShown ? MIDDLE_MIN : PANE_LIMITS.side.min!)
/** The window's width taken by the left column (its divider or strip included) when the middle is beside it. */
const leftRoom = (fileTree: number, view: PaneView) => (!view.middleShown ? 0 : view.leftShown ? fileTree + DIVIDER : STRIP)
const chatRoom = (chat: number, view: PaneView) => (view.chatShown ? chat + DIVIDER : STRIP)

/**
 * The sizes drawn in a window this wide: the saved ones within the limits, the left column at most
 * half the window, and, when the panes do not fit, the consultation then the left column made
 * smaller (never below their minimums) so the middle keeps MIDDLE_MIN. Never written back.
 */
export function fitLayout(layout: WorkspaceLayout, windowWidth: number, view: PaneView): WorkspaceLayout {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return layout
  const chatMin = PANE_LIMITS.chat.min!
  const treeMin = PANE_LIMITS.fileTree.min!
  let chat = Math.max(chatMin, paneSize(layout.screen, 'chat') ?? chatMin)
  let tree = clampWidth(paneSize(layout.files, 'fileTree') ?? treeMin, treeMin, leftMax(windowWidth))
  let over = leftRoom(tree, view) + chatRoom(chat, view) + sideNeed(view) - windowWidth
  if (over > 0 && view.chatShown) {
    const smaller = Math.max(chatMin, chat - over)
    over -= chat - smaller
    chat = smaller
  }
  if (over > 0 && view.leftShown && view.middleShown) tree = Math.max(treeMin, tree - over)
  return { screen: withPaneSize(layout.screen, 'chat', chat), files: withPaneSize(layout.files, 'fileTree', tree) }
}

/**
 * How far a pane may be dragged in this window, given what the others show now (`shown`, from
 * `fitLayout`): dragging one divider never moves another pane, and the middle keeps MIDDLE_MIN.
 */
export function paneRange(paneId: string, shown: WorkspaceLayout, windowWidth: number, view: PaneView): { min: number; max: number } {
  const min = PANE_LIMITS[paneId]?.min ?? 0
  if (paneId === 'fileTree') {
    const room = windowWidth - chatRoom(paneSize(shown.screen, 'chat') ?? 0, view) - MIDDLE_MIN - DIVIDER
    return { min, max: Math.max(min, Math.min(leftMax(windowWidth), room)) }
  }
  if (paneId === 'chat') {
    const room = windowWidth - leftRoom(paneSize(shown.files, 'fileTree') ?? 0, view) - sideNeed(view) - DIVIDER
    return { min, max: Math.max(min, room) }
  }
  return { min, max: Math.max(min, PANE_LIMITS[paneId]?.max ?? windowWidth) }
}

/**
 * What is saved after the member sets one pane's size: the sizes drawn now (`drawn`, from
 * `fitLayout`) with that pane changed, so a pane drawn smaller than saved stays as drawn and one
 * divider never moves another. `saved` itself when nothing changes.
 */
export function layoutAfterResize(saved: WorkspaceLayout, drawn: WorkspaceLayout, splitId: 'screen' | 'files', paneId: string, size: number): WorkspaceLayout {
  const next = { ...drawn, [splitId]: withPaneSize(drawn[splitId], paneId, size) }
  const same = (a: SplitNode, b: SplitNode) => a.sizes.every((s, i) => s === b.sizes[i])
  return same(next.screen, saved.screen) && same(next.files, saved.files) ? saved : next
}

/**
 * Size for a drag `offset` px (already signed: positive grows the pane) from its `startSize`,
 * within `range`; `collapse` when the pane was dragged far enough under its min to hide it.
 */
export function dragPane(paneId: string, startSize: number, offset: number, range: { min: number; max: number }): { size: number; collapse: boolean } {
  const collapseAfter = PANE_LIMITS[paneId]?.collapseAfter
  const { width, collapse } = collapsingDrag(startSize, offset, { ...range, collapseAfter: collapseAfter ?? Number.POSITIVE_INFINITY })
  return { size: width, collapse }
}

/** Saved sizes laid onto `fallback`: same shape or nothing, each size within its static limits. */
function restoreSizes(fallback: SplitNode, saved: unknown): SplitNode {
  if (!saved || typeof saved !== 'object') return fallback
  const node = saved as Partial<SplitNode>
  if (node.type !== 'split' || node.id !== fallback.id || node.direction !== fallback.direction) return fallback
  if (!Array.isArray(node.children) || !Array.isArray(node.sizes)) return fallback
  if (node.children.length !== fallback.children.length || node.sizes.length !== fallback.sizes.length) return fallback
  const sameLeaves = fallback.children.every((child, i) => {
    const other = node.children![i] as Partial<LayoutNode> | undefined
    return other?.type === child.type && other?.id === child.id
  })
  if (!sameLeaves) return fallback
  const sizes = fallback.sizes.map((size, i) => {
    const value = node.sizes![i]
    if (size == null || typeof value !== 'number' || !Number.isFinite(value)) return size
    const limits = PANE_LIMITS[fallback.children[i].id] ?? {}
    return clampWidth(value, limits.min ?? 0, limits.max ?? Number.POSITIVE_INFINITY)
  })
  return { ...fallback, sizes }
}

// Version 1's screen split: the side had the fixed width, the consultation the rest.
const V1_SCREEN: SplitNode = { ...DEFAULT_LAYOUT.screen, sizes: [550, null] }

/**
 * Version 1's screen read as version 2: the consultation keeps the width it had in this window
 * (window − side − divider), so the screen looks as it did; without a window, the default.
 */
function screenFromV1(saved: unknown, windowWidth: number | undefined): SplitNode {
  const v1 = restoreSizes(V1_SCREEN, saved)
  const raw = (saved as { sizes?: unknown[] } | null)?.sizes?.[0]
  const side = v1 === V1_SCREEN || typeof raw !== 'number' || !Number.isFinite(raw) ? null : v1.sizes[0]
  if (side == null || windowWidth === undefined || !Number.isFinite(windowWidth) || windowWidth <= 0) return DEFAULT_LAYOUT.screen
  return withPaneSize(DEFAULT_LAYOUT.screen, 'chat', Math.max(PANE_LIMITS.chat.min!, Math.round(windowWidth - side - DIVIDER)))
}

/**
 * What a company saved (version 2, or version 1 read for a window `windowWidth` wide), or the
 * first look when nothing usable was saved. Each split is used on its own when its shape matches.
 */
export function parseLayout(raw: string | null, windowWidth?: number): WorkspaceLayout {
  if (!raw) return DEFAULT_LAYOUT
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; trees?: Record<string, unknown> } | null
    if (!parsed || !parsed.trees || typeof parsed.trees !== 'object') return DEFAULT_LAYOUT
    if (parsed.version === 1) {
      return { screen: screenFromV1(parsed.trees.screen, windowWidth), files: restoreSizes(DEFAULT_LAYOUT.files, parsed.trees.files) }
    }
    if (parsed.version !== LAYOUT_VERSION) return DEFAULT_LAYOUT
    return {
      screen: restoreSizes(DEFAULT_LAYOUT.screen, parsed.trees.screen),
      files: restoreSizes(DEFAULT_LAYOUT.files, parsed.trees.files),
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function serializeLayout(layout: WorkspaceLayout): string {
  return JSON.stringify({ version: LAYOUT_VERSION, trees: layout })
}

/** The divider's size as the member reads it while dragging: 「340px（画面の 27%）」. */
export function sizeText(size: number, windowWidth: number): string {
  const share = windowWidth > 0 ? Math.round((size / windowWidth) * 100) : 0
  return `${Math.round(size)}px（画面の ${share}%）`
}
