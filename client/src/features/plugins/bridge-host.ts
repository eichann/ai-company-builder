/**
 * The core app's end of a plugin screen's bridge (stage 4b, plan A5,
 * plugin-frame.md). Pure apart from `MessageChannel` (a browser and Node
 * global), so it is tested under Node.
 *
 * - `handOver(frameWindow)` creates one `MessageChannel` and posts one end to
 *   the frame with the hello message. Once per host: a second call (the frame
 *   loaded again, or anything else) hands nothing.
 * - Only messages on that port are read; the window's own `message` events
 *   are never listened to, so `parent.postMessage` from the frame reaches
 *   nothing.
 * - Each message is read with `parseBridgeMessage` (bridge 1's ops, exactly
 *   their keys); refused ones are answered with the reason and go nowhere.
 *   `ui.open` is the core screen's (`open`); every other op goes to main
 *   (`call`), which adds the session — the frame never sees it.
 * - At most `maxInFlight` calls at once (`BUSY` beyond).
 */
import { BRIDGE_ERROR, type BridgeUiOpenArgs, type PluginBridgeAnswer } from '../../../shared/plugin-bridge-ops'
import { bridgeHello, parseBridgeMessage, type BridgeCallId, type BridgeFrameContext, type BridgeReply } from '../../../shared/plugin-bridge'

/** What the host needs of the frame's window: only `postMessage`. */
export interface FrameTarget {
  postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void
}

export interface BridgeHostDeps {
  /** A server operation, sent through main (`plugins:bridge`). */
  call: (op: string, args: unknown) => Promise<PluginBridgeAnswer>
  /** `ui.open`: the core app opens it, only what the person may open. */
  open: (target: BridgeUiOpenArgs) => PluginBridgeAnswer | Promise<PluginBridgeAnswer>
  /** Where the frame is shown, handed once in the hello (A6). */
  context?: BridgeFrameContext
  maxInFlight?: number
}

export function createBridgeHost(deps: BridgeHostDeps) {
  const maxInFlight = deps.maxInFlight ?? 8
  let port: MessagePort | null = null
  let handed = false
  let closed = false
  let inFlight = 0

  const reply = (id: BridgeCallId, answer: PluginBridgeAnswer) => {
    if (closed || !port) return
    const message: BridgeReply = { id, ...answer }
    port.postMessage(message)
  }

  async function onMessage(data: unknown): Promise<void> {
    const envelope = parseBridgeMessage(data)
    if (!envelope.ok) {
      if (envelope.id !== null) reply(envelope.id, { ok: false, error: { code: envelope.code, message: envelope.message } })
      return
    }
    if (inFlight >= maxInFlight) {
      reply(envelope.id, { ok: false, error: { code: BRIDGE_ERROR.busy, message: 'too many calls at once' } })
      return
    }
    inFlight++
    try {
      const { call } = envelope
      const answer = call.op === 'ui.open' ? await deps.open(call.args) : await deps.call(call.op, call.args)
      reply(envelope.id, answer)
    } catch {
      reply(envelope.id, { ok: false, error: { code: BRIDGE_ERROR.failed, message: 'the call failed' } })
    } finally {
      inFlight--
    }
  }

  return {
    /** Hand the frame its one port. True only the first time. */
    handOver(frame: FrameTarget | null | undefined): boolean {
      if (handed || closed || !frame) return false
      handed = true
      const channel = new MessageChannel()
      port = channel.port1
      port.onmessage = (event: MessageEvent) => { void onMessage(event.data) }
      // The frame's origin is opaque (sandboxed without allow-same-origin): `*` is the only target
      // that reaches it. What is sent is the hello and the port, nothing of the app's.
      frame.postMessage(bridgeHello(deps.context), '*', [channel.port2])
      return true
    },
    /** The frame is gone: no more answers; the port is closed. */
    close(): void {
      closed = true
      if (port) { port.onmessage = null; port.close() }
      port = null
    },
  }
}

export type BridgeHost = ReturnType<typeof createBridgeHost>
