import { useCallback, useRef } from 'react'
import type { BridgeUiOpenArgs, PluginBridgeAnswer } from '../../../../shared/plugin-bridge-ops'
import { pluginFrameUrl, type BridgeFrameContext, type PluginPackageRef } from '../../../../shared/plugin-bridge'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { callPluginBridge, type PluginBridgePort } from '../api'
import { createBridgeHost, type BridgeHost } from '../bridge-host'

interface Props {
  companyId: string
  plugin: PluginPackageRef
  /** The package's `ui/` file the declaration names (`ui.tab.entry`, a record section's `entry`). */
  entry: string
  /** The frame's accessible name (the tab's or section's label). */
  title: string
  /** `ui.open`: the core app opens it (only what the person may open there). */
  onOpen: (target: BridgeUiOpenArgs) => PluginBridgeAnswer | Promise<PluginBridgeAnswer>
  /** Where it is shown (A6's slots), handed in the hello; fixed for the frame's life. */
  context?: BridgeFrameContext
  className?: string
  port?: PluginBridgePort
  /** Preview pages only: where the `acb-plugin://` address is served (Chromium there cannot load the scheme). */
  frameUrl?: (src: string) => string
}

/**
 * A plugin's screen (plugin-frame.md): its `ui/` page in a sandboxed frame,
 * talking only through the bridge handed over once. One frame per page: a
 * new plugin or entry mounts a new frame (a frame showing a plugin's page
 * may not navigate), so the bridge is never handed twice to one frame.
 */
export function PluginFrame(props: Props) {
  const src = pluginFrameUrl(props.plugin, props.entry)
  if (!src) return <div className={props.className} role="status">この画面は表示できません。</div>
  // A new place (another record, another file) is a new frame: its hello is handed once.
  return <PluginFrameView key={`${src}#${JSON.stringify(props.context ?? null)}`} {...props} src={props.frameUrl ? props.frameUrl(src) : src} />
}

/**
 * The frame itself, for a given address (the preview page passes its own).
 * `sandbox="allow-scripts"` only: no `allow-same-origin` (the page gets an
 * opaque origin: no storage, cookies or the app's window), no popups, forms,
 * top navigation or downloads; `allow=""` grants no device or feature.
 */
export function PluginFrameView({ companyId, plugin, title, onOpen, context, className, port, src }: Props & { src: string }) {
  const latest = useLatestRef({ companyId, plugin, onOpen, port, context })
  const host = useRef<BridgeHost | null>(null)
  const frame = useRef<HTMLIFrameElement | null>(null)

  // A callback ref, not an effect: the host lives exactly as long as the frame element.
  const attach = useCallback((node: HTMLIFrameElement | null) => {
    if (node) {
      frame.current = node
      host.current = createBridgeHost({
        call: (op, args) => {
          const now = latest.current
          return callPluginBridge(now.companyId, now.plugin, op, args, now.port)
        },
        open: target => latest.current.onOpen(target),
        context: latest.current.context,
      })
      return
    }
    host.current?.close()
    host.current = null
    frame.current = null
  }, [latest])

  return (
    <iframe
      ref={attach}
      src={src}
      title={title}
      className={className}
      sandbox="allow-scripts"
      allow=""
      referrerPolicy="no-referrer"
      onLoad={() => { host.current?.handOver(frame.current?.contentWindow) }}
    />
  )
}
