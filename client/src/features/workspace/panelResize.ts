// Width computation and drag bookkeeping for the resizable panels (file tree,
// editor ↔ chat). Kept free of React and the DOM so it can be unit tested.
//
// The width is always derived from a snapshot taken when the drag starts:
// width = startWidth + (pointerX - startPointerX), clamped. It is never built
// up from per-event deltas — the previous handler kept its start position in
// React state, so every mousemove that fired before the next render reused the
// stale position and the panel moved several times further than the mouse.

export function clampWidth(width: number, min: number, max: number): number {
  // A max below min (tiny window) must not produce a width below min.
  return Math.max(min, Math.min(Math.max(min, max), width))
}

/** Width for a drag `offset` px away from where it started. */
export function dragWidth(startWidth: number, offset: number, min: number, max: number): number {
  return clampWidth(startWidth + offset, min, max)
}

/**
 * The editor ↔ chat divider: dragging `collapseAfter` px or more past the max
 * collapses the chat (the width stays at the max, so expanding the chat again
 * restores it there).
 */
export function leftPanelDrag(startWidth: number, offset: number, limits: { min: number; max: number; collapseAfter: number }): { width: number; collapse: boolean } {
  const raw = startWidth + offset
  const width = clampWidth(raw, limits.min, limits.max)
  return { width, collapse: raw - Math.max(limits.min, limits.max) >= limits.collapseAfter }
}

export interface ResizeDragOptions {
  /** Offset in px from the pointer position at the start of the drag. */
  onResize: (offset: number) => void
  /** Frame scheduler (requestAnimationFrame in the browser). */
  schedule: (callback: () => void) => number
  cancel: (handle: number) => void
}

/**
 * One drag of a resize handle. Pointer moves are coalesced to one `onResize`
 * per frame with the latest position; `end` flushes the final position so the
 * panel lands exactly where the pointer was released.
 */
export function createResizeDrag(startPointer: number, options: ResizeDragOptions) {
  let latest = startPointer
  let lastReported = startPointer
  let frame: number | null = null
  let ended = false
  const flush = () => {
    frame = null
    if (latest === lastReported) return
    lastReported = latest
    options.onResize(latest - startPointer)
  }
  return {
    move(pointer: number) {
      if (ended) return
      latest = pointer
      if (frame === null) frame = options.schedule(flush)
    },
    /** Pointer released: apply the final position (if any) and stop. */
    end(pointer?: number) {
      if (ended) return
      if (pointer !== undefined) latest = pointer
      if (frame !== null) options.cancel(frame)
      flush()
      ended = true
    },
    /** Drag torn down (unmount, cancel): drop any pending frame without applying it. */
    dispose() {
      if (frame !== null) options.cancel(frame)
      frame = null
      ended = true
    },
  }
}
