import type { UIMessageChunk } from 'ai'
import { TOOL_LINE_METADATA_KEY, toolLineOf, type ToolDisplay } from '../shared/tool-display'
import { askUserDisplay } from './agents/choice-tools'
import { COMPANY_FILES_SERVER, companyFileDisplays } from './company-files/tools'
import { referenceDisplays } from './consultations/tools'
import { recordToolId, type RecordToolDescriptor } from './records/tools'
import { REVIEW_TOOL_ID, reviewDisplay } from './review/tools'
import { webResearchDisplay } from './web-research/tools'
import { WEB_RESEARCH_TOOL_ID } from '../shared/web-research'
import { CODEX_CHOICE_SERVER, CODEX_CHOICE_TOOL } from '../shared/choice-prompt'

/**
 * Plain-Japanese lines for the chat's tool rows (chat-ui-and-history.md 「Tool rows」).
 * The main process knows each ACB tool's definition — including the ones made per turn from
 * the company's record types and plugins — so it labels every call as it streams: the line
 * rides on the tool part as `callProviderMetadata.acb.display`, read by the renderer.
 */

/** Every ACB tool the turn may call, by the name the agent reports (`mcp__<server>__<tool>`). */
export function acbToolDisplays(records?: { specs: readonly RecordToolDescriptor[] }): Map<string, ToolDisplay> {
  const displays = new Map<string, ToolDisplay>()
  for (const [name, display] of Object.entries(referenceDisplays)) displays.set(`mcp__acb_consultations__${name}`, display)
  for (const [name, display] of Object.entries(companyFileDisplays)) displays.set(`mcp__${COMPANY_FILES_SERVER}__${name}`, display)
  displays.set(REVIEW_TOOL_ID, reviewDisplay)
  displays.set(WEB_RESEARCH_TOOL_ID, webResearchDisplay)
  displays.set(`mcp__${CODEX_CHOICE_SERVER}__${CODEX_CHOICE_TOOL}`, askUserDisplay)
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
      const { detail, muted, ...rest } = display
      const line = { ...rest, ...(detail ? { detail } : {}), ...(muted ? { muted } : {}) }
      controller.enqueue({ ...chunk, providerMetadata: { ...chunk.providerMetadata, [TOOL_LINE_METADATA_KEY]: { display: line } } })
    },
  })
}
