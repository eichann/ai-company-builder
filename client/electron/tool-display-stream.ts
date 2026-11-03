import type { UIMessageChunk } from 'ai'
import { TOOL_LINE_METADATA_KEY, toolLineOf, type ToolDisplay } from '../shared/tool-display'
import { ACB_TOOL_DISPLAYS } from '../shared/acb-tool-displays'
import { recordToolId, type RecordToolDescriptor } from './records/tools'

/**
 * Plain-Japanese lines for the chat's tool rows (chat-ui-and-history.md 「Tool rows」).
 * The renderer names every ACB tool by itself (client/shared/acb-tool-displays.ts); main adds
 * what only it knows — the company's own type and plugin labels, the input's detail with the
 * company folder — on the tool part as `callProviderMetadata.acb.display`.
 */

/** Every ACB tool the turn may call, by the name the agent reports (`mcp__<server>__<tool>`). */
export function acbToolDisplays(records?: { specs: readonly RecordToolDescriptor[] }): Map<string, ToolDisplay> {
  const displays = new Map<string, ToolDisplay>(Object.entries(ACB_TOOL_DISPLAYS))
  for (const spec of records?.specs ?? []) displays.set(recordToolId(spec.name), spec.display)
  return displays
}

/** Adds each call's line to its `tool-input-available` / `tool-input-error` chunk. */
export function toolDisplayTransform(displays: ReadonlyMap<string, ToolDisplay>, root?: string): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type !== 'tool-input-available' && chunk.type !== 'tool-input-error') { controller.enqueue(chunk); return }
      let display
      try { display = toolLineOf(chunk.toolName, chunk.input, displays.get(chunk.toolName), { root }) } catch { controller.enqueue(chunk); return }
      // A tool the app does not know: the renderer works its line out (and keeps the name out of it).
      if (display.muted) { controller.enqueue(chunk); return }
      const { detail, ...rest } = display
      const line = { ...rest, ...(detail ? { detail } : {}) }
      controller.enqueue({ ...chunk, providerMetadata: { ...chunk.providerMetadata, [TOOL_LINE_METADATA_KEY]: { display: line } } })
    },
  })
}
