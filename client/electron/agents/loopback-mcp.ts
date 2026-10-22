import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ZodRawShape } from 'zod'

export interface LoopbackTool {
  name: string
  description: string
  inputSchema: ZodRawShape
  execute(args: Record<string, unknown>): Promise<string>
}

/**
 * Request-scoped loopback MCP endpoint for Codex (it takes MCP servers as
 * config, not in-process objects): read-only tools, a random bearer token,
 * 127.0.0.1 only, no persistent process or global configuration.
 * `toolTimeoutSec`: Codex's per-call limit (ask_user waits for the member).
 */
export async function startLoopbackMcp(serverName: string, tools: LoopbackTool[], options: { toolTimeoutSec?: number } = {}) {
  const token = randomBytes(32).toString('hex')
  const active = new Set<McpServer>()
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin || req.url !== '/mcp') { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const mcp = new McpServer({ name: serverName, version: '1.0.0' })
    for (const t of tools) mcp.registerTool(t.name, {
      description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (args: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: await t.execute(args) }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    active.add(mcp)
    res.on('close', () => { active.delete(mcp); void mcp.close() })
    try { await mcp.connect(transport); await transport.handleRequest(req, res) }
    catch { if (!res.headersSent) res.writeHead(500).end(); else res.end() }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('参照ツールを起動できません')
  return {
    config: { url: `http://127.0.0.1:${address.port}/mcp`, http_headers: { Authorization: `Bearer ${token}` }, startup_timeout_sec: 10, tool_timeout_sec: options.toolTimeoutSec ?? 30 },
    close: () => { server.closeAllConnections(); server.close(); for (const mcp of active) void mcp.close(); active.clear() },
  }
}

export type LoopbackMcp = Awaited<ReturnType<typeof startLoopbackMcp>>
