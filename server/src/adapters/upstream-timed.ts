/**
 * The way out, timed (server.md "Request log"): from sending a request to
 * another service until its response headers arrive (or it fails), reported
 * to the OperationMetrics port as `ext`. The body streams to the caller
 * afterwards and is not counted. Nothing about the request is kept.
 */
import type { OperationMetrics } from '../ports/operation-metrics'
import type { UpstreamClient } from '../ports/upstream'

export function timedUpstream(inner: UpstreamClient, metrics: OperationMetrics): UpstreamClient {
  return {
    async send(request) {
      const end = metrics.start('ext')
      try {
        return await inner.send(request)
      } finally {
        end()
      }
    },
  }
}
