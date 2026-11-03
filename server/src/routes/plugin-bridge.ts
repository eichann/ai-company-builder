/**
 * A plugin screen's bridge, the server end (plan 4b B6 「橋の関所」,
 * `.claude/rules/plugin-frame.md`). Mounted at /api/companies/:companyId.
 * Contract: shared/types/plugin-bridge.ts; rules: services/plugin-bridge.ts.
 *
 *   POST /plugin-bridge   { pluginId, version, op, args }   any member, with their session
 *
 * The app's main process calls it for the frame (which has no network). Every
 * call runs as the member; the bridge refuses with one answer (403
 * PLUGIN_BRIDGE_REFUSED). Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { PLUGIN_BRIDGE_OPS } from '../../shared/types/plugin-bridge'
import { services } from '../composition'
import { body, companyMember } from './guards'
import { refusal } from './respond'

export const pluginBridgeRoute = new Hono()
const { pluginBridge } = services

const BridgeCall = z.object({
  pluginId: z.string().min(1).max(40),
  version: z.string().min(1).max(20),
  op: z.enum(PLUGIN_BRIDGE_OPS),
  args: z.record(z.string(), z.unknown()),
}).strict()

pluginBridgeRoute.post('/plugin-bridge', companyMember, body(BridgeCall), async (c) => {
  const result = await pluginBridge.call(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value.value }, result.value.status)
})
