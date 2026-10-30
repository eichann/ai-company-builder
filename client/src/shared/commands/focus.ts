import { COMMAND_AREAS, type CommandArea } from '../../../shared/commands/define'
import type { FocusScope } from '../../../shared/commands/registry'

/** The element type this needs from the DOM, so the walk runs in node tests too. */
export interface AreaElement {
  getAttribute(name: string): string | null
  readonly parentElement: AreaElement | null
}

const isArea = (value: string | null): value is CommandArea =>
  value !== null && (COMMAND_AREAS as readonly string[]).includes(value)

/**
 * The focus areas around an element, innermost first, ending with `app`
 * (marked with `data-command-area` / `data-command-target`, commandArea()).
 */
export function focusChainOf(start: unknown): FocusScope[] {
  const chain: FocusScope[] = []
  let node = isAreaElement(start) ? start : null
  while (node) {
    const area = node.getAttribute('data-command-area')
    if (isArea(area) && area !== 'app') {
      const target = node.getAttribute('data-command-target')
      chain.push(target === null ? { area } : { area, target })
    }
    node = node.parentElement
  }
  chain.push({ area: 'app' })
  return chain
}

function isAreaElement(value: unknown): value is AreaElement {
  return typeof value === 'object' && value !== null
    && typeof (value as AreaElement).getAttribute === 'function' && 'parentElement' in value
}
