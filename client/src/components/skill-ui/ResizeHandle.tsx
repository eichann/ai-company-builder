import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createResizeDrag } from '../../lib/panelResize'

interface ResizeHandleProps {
  /** Drag started: the parent snapshots the panel's current width. */
  onResizeStart: () => void
  /**
   * Pointer offset in px from where the drag started (not a per-event delta).
   * The parent computes width = startWidth + offset, so fast pointer moves
   * between renders cannot make the panel overshoot the pointer.
   */
  onResize: (offset: number) => void
  direction?: 'horizontal' | 'vertical'
}

type Drag = ReturnType<typeof createResizeDrag> & { pointerId: number; restore: () => void }

export function ResizeHandle({ onResizeStart, onResize, direction = 'horizontal' }: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<Drag | null>(null)
  // Latest callback without restarting a drag in progress when the parent re-renders.
  const onResizeRef = useRef(onResize)
  useLayoutEffect(() => { onResizeRef.current = onResize }, [onResize])

  const position = useCallback((e: { clientX: number; clientY: number }) => direction === 'horizontal' ? e.clientX : e.clientY, [direction])

  const finish = useCallback((apply: boolean, pointer?: number) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (apply) drag.end(pointer)
    else drag.dispose()
    drag.restore()
    setIsDragging(false)
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || dragRef.current) return
    e.preventDefault()
    const element = e.currentTarget
    // Keep receiving moves when the pointer leaves the 4px handle or crosses an
    // iframe (PDF preview, tool viewer) that would otherwise swallow them.
    try { element.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    const body = document.body.style
    const previous = { cursor: body.cursor, userSelect: body.userSelect }
    body.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    body.userSelect = 'none'
    onResizeStart()
    dragRef.current = Object.assign(
      createResizeDrag(position(e), {
        onResize: offset => onResizeRef.current(offset),
        schedule: callback => requestAnimationFrame(callback),
        cancel: handle => cancelAnimationFrame(handle),
      }),
      {
        pointerId: e.pointerId,
        restore: () => {
          body.cursor = previous.cursor
          body.userSelect = previous.userSelect
          try { if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId) } catch { /* element detached */ }
        },
      },
    )
    setIsDragging(true)
  }, [direction, onResizeStart, position])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag && e.pointerId === drag.pointerId) drag.move(position(e))
  }, [position])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current && e.pointerId === dragRef.current.pointerId) finish(true, position(e))
  }, [finish, position])

  const handleCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current && e.pointerId === dragRef.current.pointerId) finish(false)
  }, [finish])

  // The divider unmounts mid-drag when over-dragging collapses the chat.
  useEffect(() => () => finish(false), [finish])

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handleCancel}
      onLostPointerCapture={handleCancel}
      className={`
        group flex-shrink-0 relative touch-none
        ${direction === 'horizontal'
          ? 'w-1 cursor-col-resize hover:w-1'
          : 'h-1 cursor-row-resize hover:h-1'
        }
        ${isDragging ? 'bg-accent' : 'bg-transparent hover:bg-zinc-700'}
        transition-colors
      `}
    >
      {/* Wider hit area */}
      <div
        className={`
          absolute
          ${direction === 'horizontal'
            ? 'inset-y-0 -left-1 -right-1'
            : 'inset-x-0 -top-1 -bottom-1'
          }
        `}
      />
      {/* Visual indicator on hover/drag */}
      <div
        className={`
          absolute opacity-0 group-hover:opacity-100
          ${isDragging ? 'opacity-100' : ''}
          ${direction === 'horizontal'
            ? 'inset-y-0 left-0 w-0.5 bg-accent'
            : 'inset-x-0 top-0 h-0.5 bg-accent'
          }
          transition-opacity
        `}
      />
    </div>
  )
}
