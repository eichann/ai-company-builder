import { useId, type CSSProperties, type ReactNode } from 'react'
import { WATCH_NAME } from '../../../../shared/thing-words'
import { watchFigure, watchPartsFor, type WatchNode, type WatchSeed, type WatchSize, type WatchState } from '../../../../shared/watch-character'
import '../watch-character.css'

interface Props extends WatchSeed {
  size: WatchSize
  state: WatchState
}

/**
 * The watch AI's character (.claude/rules/watch.md): the member's own one, drawn from the bundled
 * parts only. Its state is motion; the result is always the words placed beside it.
 */
export function WatchCharacter({ memberId, rerolls, version, size, state }: Props) {
  const clipId = `watch-clip-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const parts = watchPartsFor({ memberId, rerolls, version })
  if (!parts) return null
  const figure = watchFigure(parts, size)
  return (
    <svg
      className="watch-character"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={figure.viewBox}
      width={size}
      height={size}
      role="img"
      aria-label={WATCH_NAME}
      data-state={state}
      style={{ '--watch-hue': `var(--data-department-${figure.hue})` } as CSSProperties}
    >
      <defs><clipPath id={clipId}><path d={figure.bodyPath} /></clipPath></defs>
      {figure.nodes.map((n, i) => drawNode(n, i, clipId))}
    </svg>
  )
}

function drawNode(n: WatchNode, key: number, clipId: string): ReactNode {
  if (n.tag === 'g') {
    return (
      <g
        key={key}
        className={n.group ? `wc-g-${n.group}` : undefined}
        transform={n.transform}
        clipPath={n.clipToBody ? `url(#${clipId})` : undefined}
        style={n.origin ? { transformOrigin: `${n.origin[0]}px ${n.origin[1]}px` } : undefined}
      >
        {n.children.map((c, i) => drawNode(c, i, clipId))}
      </g>
    )
  }
  const paint = { className: `wc-${n.paint}`, strokeWidth: n.strokeWidth, transform: n.transform }
  switch (n.tag) {
    case 'path': return <path key={key} {...paint} d={n.d} />
    case 'circle': return <circle key={key} {...paint} cx={n.cx} cy={n.cy} r={n.r} />
    case 'ellipse': return <ellipse key={key} {...paint} cx={n.cx} cy={n.cy} rx={n.rx} ry={n.ry} />
    case 'rect': return <rect key={key} {...paint} x={n.x} y={n.y} width={n.width} height={n.height} rx={n.rx} />
  }
}
