import { memo, useCallback, useEffect, useRef } from 'react'
import { Lightning } from '@phosphor-icons/react'

export interface SlashCommandItem {
  /** Folder name used as the slash command (e.g., "create-proposal") */
  command: string
  /** Display name of the skill */
  name: string
  /** Short description */
  description?: string
  /** Department color */
  color?: string
}

interface SlashCommandDropdownProps {
  items: SlashCommandItem[]
  query: string
  selectedIndex: number
  onSelect: (item: SlashCommandItem) => void
  onClose: () => void
}

export const SlashCommandDropdown = memo(function SlashCommandDropdown({
  items,
  query,
  selectedIndex,
  onSelect,
}: SlashCommandDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const selected = list.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleItemClick = useCallback((item: SlashCommandItem) => {
    onSelect(item)
  }, [onSelect])

  if (items.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50">
      <div className="mx-2 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl shadow-lg overflow-hidden">
        {/* Header */}
        <div className="px-3 py-1.5 border-b border-gray-100 dark:border-zinc-700/50">
          <span className="text-[10px] font-medium text-gray-400 dark:text-zinc-500 uppercase tracking-wider">
            スキル
          </span>
          {query && (
            <span className="text-[10px] text-gray-400 dark:text-zinc-500 ml-2">
              /{query}
            </span>
          )}
        </div>

        {/* Items */}
        <div ref={listRef} className="max-h-[240px] overflow-y-auto py-1">
          {items.map((item, index) => (
            <button
              key={item.command}
              onMouseDown={(e) => {
                e.preventDefault() // Prevent editor blur
                handleItemClick(item)
              }}
              className={`
                w-full flex items-center gap-3 px-3 py-2 text-left transition-colors
                ${index === selectedIndex
                  ? 'bg-accent/10 dark:bg-accent/15'
                  : 'hover:bg-gray-50 dark:hover:bg-white/[0.03]'
                }
              `}
            >
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: item.color ? `${item.color}20` : 'rgba(99,102,241,0.12)' }}
              >
                <Lightning
                  size={14}
                  weight="fill"
                  style={{ color: item.color || '#6366f1' }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-zinc-100 truncate">
                    {item.name}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-zinc-500 font-mono flex-shrink-0">
                    /{item.command}
                  </span>
                </div>
                {item.description && (
                  <p className="text-xs text-gray-500 dark:text-zinc-400 truncate mt-0.5">
                    {item.description}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-1.5 border-t border-gray-100 dark:border-zinc-700/50 flex items-center gap-3">
          <span className="text-[10px] text-gray-400 dark:text-zinc-500">
            ↑↓ 選択
          </span>
          <span className="text-[10px] text-gray-400 dark:text-zinc-500">
            Tab / Enter 確定
          </span>
          <span className="text-[10px] text-gray-400 dark:text-zinc-500">
            Esc 閉じる
          </span>
        </div>
      </div>
    </div>
  )
})
