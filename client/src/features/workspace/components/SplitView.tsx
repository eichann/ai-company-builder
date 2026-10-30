import { Fragment, type ReactNode } from 'react'
import { ResizeHandle } from './ResizeHandle'
import type { PaneLimits, SplitNode } from '../layoutTree'

interface SplitViewProps {
  split: SplitNode
  limits: Readonly<Record<string, PaneLimits>>
  /** A pane hidden (still mounted); its fixed-size sibling takes the room. */
  collapsed?: string | null
  className?: string
  paneClassName?: (paneId: string) => string
  renderPane: (paneId: string) => ReactNode
  /** Shown where the divider was, next to a hidden pane (the control that shows it again). */
  renderCollapsed?: (paneId: string) => ReactNode
  /** Accessible name of the divider after child `index` of split `splitId`. */
  dividerLabel: (splitId: string, index: number) => string
  onResizeStart: (splitId: string, dividerIndex: number) => void
  onResize: (splitId: string, dividerIndex: number, offset: number) => void
}

/** One split of the layout tree: its children in order with a divider between each two. */
export function SplitView(props: SplitViewProps) {
  const { split, limits, collapsed, className = '', paneClassName, renderPane, renderCollapsed, dividerLabel, onResizeStart, onResize } = props
  const row = split.direction === 'row'
  const anyCollapsed = split.children.some(child => child.id === collapsed)
  return (
    <div className={`flex ${row ? '' : 'flex-col'} ${className}`}>
      {split.children.map((child, i) => {
        const size = split.sizes[i]
        const isCollapsed = child.id === collapsed
        const min = limits[child.id]?.min
        const fills = !isCollapsed && (size == null || anyCollapsed)
        const sizing = isCollapsed ? 'hidden' : fills ? 'flex-1' : 'flex-shrink-0'
        // A pane taking the remaining space stops at its limit, never at its content's width
        // (wide tabs or lines would push it past the window: flex items default to min-width auto).
        const style = isCollapsed
          ? undefined
          : fills
            ? (row ? { minWidth: min ?? 0 } : { minHeight: min ?? 0 })
            : (row ? { width: size! } : { height: size! })
        const next = split.children[i + 1]
        const nextIsCollapsed = next != null && next.id === collapsed
        return (
          <Fragment key={child.id}>
            <div className={`${paneClassName?.(child.id) ?? ''} ${sizing}`} style={style}>
              {child.type === 'pane' ? renderPane(child.id) : <SplitView {...props} split={child} className="h-full w-full" />}
            </div>
            {next != null && (isCollapsed || nextIsCollapsed
              ? renderCollapsed?.((isCollapsed ? child : next).id)
              : (
                <ResizeHandle
                  onResizeStart={() => onResizeStart(split.id, i)}
                  onResize={offset => onResize(split.id, i, offset)}
                  direction={row ? 'horizontal' : 'vertical'}
                  label={dividerLabel(split.id, i)}
                />
              ))}
          </Fragment>
        )
      })}
    </div>
  )
}
