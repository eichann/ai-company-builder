import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { referenceSchemas, referenceDescriptions, type ReferenceTools, type ReferenceToolName } from './tools'

/** Request-scoped loopback endpoint. No persistent MCP process or global configuration. */
export async function startReferenceMcp(tools: ReferenceTools) {
  const token = randomBytes(32).toString('hex')
  const active = new Set<McpServer>()
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin || req.url !== '/mcp') { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const mcp = new McpServer({ name: 'acb_consultations', version: '1.0.0' })
    for (const name of Object.keys(referenceSchemas) as ReferenceToolName[]) mcp.registerTool(name, {
      description: referenceDescriptions[name], inputSchema: referenceSchemas[name].shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (args: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: await tools.execute(name, args) }] }))
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
    config: { url: `http://127.0.0.1:${address.port}/mcp`, http_headers: { Authorization: `Bearer ${token}` }, startup_timeout_sec: 10, tool_timeout_sec: 20 },
    close: () => { server.closeAllConnections(); server.close(); for (const mcp of active) void mcp.close(); active.clear() },
  }
}
