import { startLoopbackMcp } from '../agents/loopback-mcp'
import { referenceSchemas, referenceDescriptions, type ReferenceTools, type ReferenceToolName } from './tools'

/** Request-scoped loopback endpoint. No persistent MCP process or global configuration. */
export function startReferenceMcp(tools: ReferenceTools) {
  return startLoopbackMcp('acb_consultations', (Object.keys(referenceSchemas) as ReferenceToolName[]).map(name => ({
    name, description: referenceDescriptions[name], inputSchema: referenceSchemas[name].shape,
    execute: args => tools.execute(name, args),
  })))
}
