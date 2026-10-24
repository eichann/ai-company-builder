import type { PushRejectionRepository } from '../../ports/push-rejections'
import { listRecentPushRejections, listRejectionMarkers, queryPushRejections } from '../../lib/push-rejections'

/**
 * lib/push-rejections.ts behind the port. The rows are written there too,
 * by git-http after a rejected push (observeRejectedPush), off the request.
 */
export function sqlitePushRejectionRepository(): PushRejectionRepository {
  return {
    query: (companyId, q) => queryPushRejections(companyId, q),
    recent: (companyId, limit) => listRecentPushRejections(companyId, limit),
    markers: companyId => listRejectionMarkers(companyId),
  }
}
