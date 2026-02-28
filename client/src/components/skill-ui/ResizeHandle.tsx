import { useCallback, useEffect, useState } from 'react'

interface ResizeHandleProps {
  onResize: (delta: number) => void
  direction?: 'horizontal' | 'vertical'
}

export function ResizeHandle({ onResize, direction = 'horizontal' }: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [startPos, setStartPos] = useState(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    setStartPos(direction === 'horizontal' ? e.clientX : e.clientY)
  }, [direction])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = currentPos - startPos
      onResize(delta)
      setStartPos(currentPos)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, startPos, direction, onResize])

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`
        group flex-shrink-0 relative
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
