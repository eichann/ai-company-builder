// The screen's panes as a tree of row / column splits (owner decision D8):
// the chat is one leaf, so a later version can split it into two or four
// panes by changing the tree, not the skeleton. Sizes are saved per company;
// limits stay in code, so a saved layout can never push a pane out of them.
import { clampWidth, leftPanelDrag } from './panelResize'

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
  /** px the window keeps for the rest of the split (the chat) while this pane grows. */
  keepForSiblings?: number
  /** Dragging this far past the max hides the flexible sibling. */
  collapseSiblingAfter?: number
}

/** The splits of the screen: `screen` (the whole window) and `files` (inside the ファイル tab). */
export interface WorkspaceLayout { screen: SplitNode; files: SplitNode }

export const LAYOUT_VERSION = 1

const pane = (id: string): PaneNode => ({ type: 'pane', id })

/** Today's look, also what a first start and an unreadable saved layout get. */
export const DEFAULT_LAYOUT: WorkspaceLayout = {
  screen: { type: 'split', id: 'screen', direction: 'row', children: [pane('side'), pane('chat')], sizes: [550, null] },
  files: { type: 'split', id: 'files', direction: 'row', children: [pane('fileTree'), pane('editor')], sizes: [200, null] },
}

export const PANE_LIMITS: Readonly<Record<string, PaneLimits>> = {
  side: { min: 300, max: 1200, keepForSiblings: 280 + 10, collapseSiblingAfter: 60 },
  chat: { min: 280 },
  fileTree: { min: 120, max: 400 },
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

/**
 * Size for a drag `offset` px from a pane's `startSize`, within its limits;
 * `collapseSibling` when it went far enough past the max to hide the other pane.
 */
export function dragPane(startSize: number, offset: number, limits: PaneLimits, windowSize: number): { size: number; collapseSibling: boolean } {
  const staticMax = limits.max ?? Number.POSITIVE_INFINITY
  const max = limits.keepForSiblings == null ? staticMax : Math.min(staticMax, windowSize - limits.keepForSiblings)
  const { width, collapse } = leftPanelDrag(startSize, offset, {
    min: limits.min ?? 0, max, collapseAfter: limits.collapseSiblingAfter ?? Number.POSITIVE_INFINITY,
  })
  return { size: width, collapseSibling: collapse }
}

/** Saved sizes laid onto the default tree: same shape or nothing, each size within its limits. */
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

/** What a company saved, or today's look when nothing (or nothing usable) was saved. */
export function parseLayout(raw: string | null): WorkspaceLayout {
  if (!raw) return DEFAULT_LAYOUT
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; trees?: Record<string, unknown> } | null
    if (!parsed || parsed.version !== LAYOUT_VERSION || !parsed.trees || typeof parsed.trees !== 'object') return DEFAULT_LAYOUT
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
