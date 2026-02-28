import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  divider?: boolean
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  position: { x: number; y: number }
  onClose: () => void
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // Adjust position to stay within viewport
  const adjustedPosition = { ...position }
  if (menuRef.current) {
    const rect = menuRef.current.getBoundingClientRect()
    if (position.x + rect.width > window.innerWidth) {
      adjustedPosition.x = window.innerWidth - rect.width - 8
    }
    if (position.y + rect.height > window.innerHeight) {
      adjustedPosition.y = window.innerHeight - rect.height - 8
    }
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] py-1 bg-sidebar-bg border border-border rounded-lg shadow-xl"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
    >
      {items.map((item, index) =>
        item.divider ? (
          <div key={index} className="my-1 border-t border-border" />
        ) : (
          <button
            key={index}
            onClick={() => {
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
            className={`w-full flex items-center justify-between px-3 py-1.5 text-sm transition-colors
              ${item.disabled ? 'text-text-secondary cursor-not-allowed' : ''}
              ${item.danger && !item.disabled ? 'text-red-400 hover:bg-red-500/10' : ''}
              ${!item.danger && !item.disabled ? 'text-text-primary hover:bg-activitybar-bg' : ''}
            `}
          >
            <span className="flex items-center gap-2">
              {item.icon && <span className="w-4 h-4">{item.icon}</span>}
              {item.label}
            </span>
            {item.shortcut && (
              <span className="text-xs text-text-secondary ml-4">{item.shortcut}</span>
            )}
          </button>
        )
      )}
    </div>
  )
}
