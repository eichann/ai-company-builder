import { createUIMessageStreamResponse, type UIMessageChunk, type UIMessageStreamOptions, type UIMessage } from 'ai'

/**
 * Bounds the tool payloads (outputs, inputs, provider metadata) that leave the
 * chat server in the UI message stream.
 *
 * Why this exists: one turn that transcribed a book from page images ran 980
 * tool calls (902 of them inside subagents, 703 of those `Read`s of page
 * JPGs) and streamed 277MB of base64 tool results to the renderer.
 * `ai-sdk-provider-claude-code` only truncates *string* array elements, so an
 * image result `[{ type: 'image', source: { type: 'base64', data } }]` passes
 * through whole, and `@ai-sdk/react` structuredClones the entire in-progress
 * message on every chunk (~273ms per clone at that size). The renderer froze
 * and the session was never saved.
 *
 * The UI only ever shows tool output as text/JSON when a row is expanded, so
 * nothing visible is lost: binary content becomes a short descriptor, strings
 * are clipped with a marker, and nested structures are summarised within a
 * total budget — recursively, which is exactly what the provider does not do.
 *
 * Pure module (no Electron imports) so it can be unit tested.
 */

export interface PayloadLimits {
  /** Longest string kept verbatim, in UTF-16 code units. */
  maxString: number
  /** Hard cap on `JSON.stringify(summary).length`. */
  maxTotal: number
}

/** CLI-backed agents (Claude Code / Codex): the agent owns the conversation and
 * tool parts are never replayed to a model, so outputs only feed the UI. */
export const AGENT_OUTPUT_LIMITS: PayloadLimits = { maxString: 4_000, maxTotal: 12_000 }

/** Consultation reference tools must stay parseable by `referenceFromTool`
 * (the history store derives `consultationReferences` from them). They are
 * already bounded by ConsultationReferences (8KB content, 20KB per turn). */
export const CONSULTATION_OUTPUT_LIMITS: PayloadLimits = { maxString: 32_000, maxTotal: 40_000 }

/** api-key mode replays the last few messages' tool parts to the model via
 * convertToModelMessages, and its local tools already cap reads at 50KB. Keep
 * those outputs verbatim; only pathological payloads get summarised. */
export const API_KEY_OUTPUT_LIMITS: PayloadLimits = { maxString: 64_000, maxTotal: 128_000 }

/** Provider metadata only needs `parentToolCallId`; `rawInput`/`rawResult`
 * duplicate the full payload and get clipped hard. */
const METADATA_LIMITS: PayloadLimits = { maxString: 1_000, maxTotal: 2_000 }

const MAX_DEPTH = 12
/** Strings at least this long consisting only of base64 characters are binary. */
const BASE64_MIN_LENGTH = 1_024
const BASE64_RE = /^[A-Za-z0-9+/\-_\r\n]+={0,2}$/
const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+=[\w.+-]+)*);base64,/i

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function base64Bytes(length: number): number {
  return Math.floor((length * 3) / 4)
}

function kindFor(mediaType: string | undefined, fallback?: string): string {
  if (mediaType?.startsWith('image/')) return 'image'
  if (mediaType?.startsWith('audio/')) return 'audio'
  if (mediaType?.startsWith('video/')) return 'video'
  if (mediaType === 'application/pdf') return 'document'
  return fallback && /^[a-z][\w-]{0,30}$/i.test(fallback) ? fallback : 'binary'
}

function describe(kind: string, mediaType: string | undefined, bytes: number): string {
  return `[${kind}: ${mediaType ? `${mediaType}, ` : ''}${formatBytes(bytes)}]`
}

function isBase64Like(value: string, minLength: number): boolean {
  return value.length >= minLength && BASE64_RE.test(value)
}

/** Descriptor for a string that is really binary data, else undefined. */
function describeBinaryString(value: string): string | undefined {
  const dataUrl = DATA_URL_RE.exec(value.slice(0, 200))
  if (dataUrl) {
    const mediaType = dataUrl[1]?.toLowerCase()
    return describe(kindFor(mediaType), mediaType, base64Bytes(value.length - dataUrl[0].length))
  }
  if (isBase64Like(value, BASE64_MIN_LENGTH)) return describe('base64', undefined, base64Bytes(value.length))
  return undefined
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof obj[key] === 'string') return obj[key] as string
  return undefined
}

/**
 * Descriptor for an object that is a binary content block, else undefined.
 * Covers the shapes seen in practice: Anthropic image/document blocks
 * (`source: { type: 'base64', media_type, data }`), MCP image content
 * (`{ type: 'image', data, mimeType }`), AI SDK parts (`image-data`, `media`,
 * `file-data`, `{ type: 'image', image }`), Node Buffers and typed arrays.
 */
function describeBinaryObject(obj: object): string | undefined {
  if (obj instanceof ArrayBuffer) return describe('binary', undefined, obj.byteLength)
  if (ArrayBuffer.isView(obj)) return describe('binary', undefined, obj.byteLength)
  const record = obj as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : undefined
  if (type === 'Buffer' && Array.isArray(record.data)) return describe('binary', undefined, record.data.length)

  const source = record.source
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const src = source as Record<string, unknown>
    if (src.type === 'base64' && typeof src.data === 'string') {
      const mediaType = stringField(src, 'media_type', 'mediaType', 'mimeType')
      return describe(kindFor(mediaType, type), mediaType, base64Bytes(src.data.length))
    }
  }

  const mediaType = stringField(record, 'mediaType', 'mimeType', 'media_type')
  for (const key of ['data', 'image', 'base64']) {
    const payload = record[key]
    if (typeof payload !== 'string') continue
    if (payload.startsWith('data:')) {
      const dataUrl = describeBinaryString(payload)
      if (dataUrl) return dataUrl
    }
    if (mediaType && isBase64Like(payload, 16)) return describe(kindFor(mediaType, type), mediaType, base64Bytes(payload.length))
  }
  // Anything else that hides base64 in a field is caught by the string rule
  // when the walk reaches that field.
  return undefined
}

function clip(value: string, keep: number): string {
  let end = Math.max(0, keep)
  // Do not split a surrogate pair.
  if (end > 0 && end < value.length) {
    const code = value.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
  }
  return `${value.slice(0, end)}…[truncated ${value.length - end} chars]`
}

/**
 * Returns a JSON-safe summary of `value` whose `JSON.stringify` length is at
 * most `limits.maxTotal`. Values already within the limits come back
 * structurally equal (binary content excepted, which is always replaced).
 */
export function summarizeToolPayload(value: unknown, limits: PayloadLimits = AGENT_OUTPUT_LIMITS): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string' && value.length <= Math.min(limits.maxString, (limits.maxTotal - 2) / 2) && value.length < BASE64_MIN_LENGTH) return value

  let summary = summarizeWithin(value, limits, limits.maxTotal - Math.min(256, Math.floor(limits.maxTotal / 8)))
  // Budget accounting ignores JSON escaping and marker overhead, so enforce the
  // hard cap exactly: retry with a smaller budget, then fall back to a string.
  for (let budget = limits.maxTotal / 2; budget >= 64; budget /= 2) {
    const length = jsonLength(summary)
    if (length !== undefined && length <= limits.maxTotal) return summary
    summary = summarizeWithin(value, limits, Math.floor(budget))
  }
  const length = jsonLength(summary)
  if (length !== undefined && length <= limits.maxTotal) return summary
  return `[output omitted: ${formatBytes(length ?? 0)}]`
}

function jsonLength(value: unknown): number | undefined {
  try { return JSON.stringify(value)?.length } catch { return undefined }
}

function summarizeWithin(value: unknown, limits: PayloadLimits, budget: number): unknown {
  let remaining = budget
  const seen = new WeakSet<object>()

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null) { remaining -= 4; return null }
    switch (typeof input) {
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined
      case 'number':
      case 'boolean':
        remaining -= String(input).length
        return input
      case 'bigint':
        remaining -= String(input).length + 2
        return String(input)
      case 'string': {
        const binary = describeBinaryString(input)
        const text = binary ?? input
        const allowed = Math.min(limits.maxString, Math.max(0, remaining - 2))
        const result = text.length <= allowed ? text : clip(text, allowed)
        remaining -= result.length + 2
        return result
      }
    }

    const obj = input as object
    if (seen.has(obj)) { remaining -= 12; return '[circular]' }
    const binary = describeBinaryObject(obj)
    if (binary) { remaining -= binary.length + 2; return binary }
    if (obj instanceof Date) { remaining -= 26; return Number.isNaN(obj.getTime()) ? null : obj.toISOString() }
    if (depth >= MAX_DEPTH) {
      const marker = Array.isArray(obj) ? '[nested array]' : '[nested object]'
      remaining -= marker.length + 2
      return marker
    }

    seen.add(obj)
    try {
      if (Array.isArray(obj)) {
        remaining -= 2
        const out: unknown[] = []
        for (let i = 0; i < obj.length; i++) {
          if (remaining <= 0) {
            const marker = `…[${obj.length - i} more items]`
            remaining -= marker.length + 3
            out.push(marker)
            break
          }
          const item = walk(obj[i], depth + 1)
          out.push(item === undefined ? null : item)
          remaining -= 1
        }
        return out
      }

      remaining -= 2
      const out: Record<string, unknown> = {}
      const entries = Object.entries(obj)
      for (let i = 0; i < entries.length; i++) {
        const [key, item] = entries[i]
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
        if (remaining <= 0) {
          out['…'] = `[${entries.length - i} more keys]`
          remaining -= 24
          break
        }
        remaining -= key.length + 4
        out[key] = walk(item, depth + 1)
      }
      return out
    } finally {
      seen.delete(obj)
    }
  }

  return walk(value, 0)
}

/** Keeps provider metadata a `Record<string, Record<string, JSONValue>>` (the
 * UI chunk schema rejects anything else) while clipping each field. */
function limitProviderMetadata<T>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object') return metadata
  const out: Record<string, unknown> = {}
  for (const [provider, fields] of Object.entries(metadata as Record<string, unknown>)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { out[provider] = fields; continue }
    const limited: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(fields as Record<string, unknown>)) {
      if (field === undefined) continue
      limited[key] = summarizeToolPayload(field, METADATA_LIMITS)
    }
    out[provider] = limited
  }
  return out as T
}

export interface StreamLimits {
  output: PayloadLimits
  input: PayloadLimits
  /** Streamed tool-input text forwarded per call; the final
   * `tool-input-available` chunk still carries the (bounded) full input. */
  maxInputDeltaChars: number
  /**
   * Whole-turn budget for tool payloads (inputs, outputs, streamed input
   * text; JSON characters). The per-call caps alone still let a turn with
   * ~1,000 tool calls grow the in-progress message to ~25 MB — and
   * @ai-sdk/react structuredClones that message on every chunk. Past the
   * budget, later payloads use `overBudget` (and input deltas stop): the
   * rows, their states and errors stay, only the expanded detail is shorter.
   * Text and data parts (the answer, choice prompts, steering) never count.
   */
  turnBudget: number
  overBudget: PayloadLimits
}

/** What a tool payload keeps once its turn is over budget: enough to recognise it when expanded. */
export const OVER_BUDGET_LIMITS: PayloadLimits = { maxString: 400, maxTotal: 1_000 }

export const AGENT_STREAM_LIMITS: StreamLimits = { output: AGENT_OUTPUT_LIMITS, input: AGENT_OUTPUT_LIMITS, maxInputDeltaChars: 8_000, turnBudget: 2_000_000, overBudget: OVER_BUDGET_LIMITS }
/** api-key mode replays recent tool parts to the model, so it keeps far more before tightening. */
export const API_KEY_STREAM_LIMITS: StreamLimits = { output: API_KEY_OUTPUT_LIMITS, input: API_KEY_OUTPUT_LIMITS, maxInputDeltaChars: 8_000, turnBudget: 8_000_000, overBudget: AGENT_OUTPUT_LIMITS }

const CONSULTATION_TOOL_PREFIX = 'mcp__acb_consultations__'

function outputLimitsFor(toolName: string | undefined, limits: StreamLimits, overBudget: boolean): PayloadLimits {
  // Consultation references must stay parseable; they are bounded per turn on their own (20KB).
  if (toolName?.startsWith(CONSULTATION_TOOL_PREFIX) && limits.output.maxTotal < CONSULTATION_OUTPUT_LIMITS.maxTotal) return CONSULTATION_OUTPUT_LIMITS
  return overBudget ? limits.overBudget : limits.output
}

/**
 * Transform for a UI message stream that bounds every tool payload before it
 * reaches the renderer. `toolCallId`, `toolName`, state transitions,
 * `errorText`, and `parentToolCallId` in provider metadata pass through.
 */
export function limitToolPayloads(limits: StreamLimits = AGENT_STREAM_LIMITS): TransformStream<UIMessageChunk, UIMessageChunk> {
  const toolNames = new Map<string, string>()
  const deltaChars = new Map<string, number>()
  // Tool payload characters sent in this response (one stream = one turn).
  let spent = 0
  const overBudget = () => spent >= limits.turnBudget
  const spend = (value: unknown) => { spent += jsonLength(value) ?? 0 }
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      switch (chunk.type) {
        case 'tool-input-start': {
          toolNames.set(chunk.toolCallId, chunk.toolName)
          const limited = chunk.providerMetadata ? { ...chunk, providerMetadata: limitProviderMetadata(chunk.providerMetadata) } : chunk
          spend(limited.providerMetadata)
          controller.enqueue(limited)
          return
        }
        case 'tool-input-delta': {
          const sent = deltaChars.get(chunk.toolCallId) ?? 0
          if (sent >= limits.maxInputDeltaChars || overBudget()) return
          deltaChars.set(chunk.toolCallId, sent + chunk.inputTextDelta.length)
          spent += chunk.inputTextDelta.length
          controller.enqueue(chunk)
          return
        }
        case 'tool-input-available':
        case 'tool-input-error': {
          toolNames.set(chunk.toolCallId, chunk.toolName)
          deltaChars.delete(chunk.toolCallId)
          const input = summarizeToolPayload(chunk.input, overBudget() ? limits.overBudget : limits.input)
          const providerMetadata = chunk.providerMetadata ? limitProviderMetadata(chunk.providerMetadata) : undefined
          spend(input)
          spend(providerMetadata)
          controller.enqueue({ ...chunk, input, ...(providerMetadata ? { providerMetadata } : {}) })
          return
        }
        case 'tool-output-available': {
          const output = summarizeToolPayload(chunk.output, outputLimitsFor(toolNames.get(chunk.toolCallId), limits, overBudget()))
          spend(output)
          controller.enqueue({ ...chunk, output })
          return
        }
        default:
          controller.enqueue(chunk)
      }
    },
  })
}

/**
 * The chat server's response: `result.toUIMessageStream(...)` piped through
 * {@link limitToolPayloads}. Equivalent to `toUIMessageStreamResponse` apart
 * from the bounded tool payloads.
 */
export function limitedUIMessageStreamResponse(
  result: { toUIMessageStream(options?: UIMessageStreamOptions<UIMessage>): ReadableStream<UIMessageChunk> },
  options: { ownsConversation: boolean; onError: (error: unknown) => string; inject?: ChunkInjector },
): Response {
  const stream = result.toUIMessageStream({ sendReasoning: true, onError: options.onError })
    .pipeThrough(limitToolPayloads(options.ownsConversation ? AGENT_STREAM_LIMITS : API_KEY_STREAM_LIMITS))
  return createUIMessageStreamResponse({ stream: options.inject ? stream.pipeThrough(options.inject.transform) : stream })
}

/**
 * Lets the chat server add its own chunks (data parts such as a choice
 * prompt's outcome) to the response while the model stream is idle — e.g.
 * while a tool call waits for the member. Chunks pushed before the stream
 * starts wait for its `start` chunk; after it ends they are dropped.
 */
export interface ChunkInjector {
  transform: TransformStream<UIMessageChunk, UIMessageChunk>
  push(chunk: UIMessageChunk): void
}

export function createChunkInjector(): ChunkInjector {
  let controller: TransformStreamDefaultController<UIMessageChunk> | undefined
  let started = false
  let ended = false
  const queued: UIMessageChunk[] = []
  return {
    transform: new TransformStream<UIMessageChunk, UIMessageChunk>({
      start(c) { controller = c },
      transform(chunk, c) {
        c.enqueue(chunk)
        if (!started && chunk.type === 'start') {
          started = true
          for (const extra of queued.splice(0)) c.enqueue(extra)
        }
      },
      flush() { ended = true },
    }),
    push(chunk) {
      if (ended) return
      if (!started || !controller) { queued.push(chunk); return }
      try { controller.enqueue(chunk) } catch { ended = true }
    },
  }
}
