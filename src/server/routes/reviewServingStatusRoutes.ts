import {Elysia} from 'elysia'

import {getActiveDuckdbExclusiveWorkSnapshot} from '../utils/duckdbExclusiveWork.ts'
import {getReviewServingProjectorPauseMarkerState} from '../utils/reviewServingProjectorPause.ts'
import {runtimeReviewServingStatusPath} from '../utils/runtimeReadyContract.ts'
import {getCurrentServerRole, shouldCurrentServerProxyApiToOwner} from '../utils/serverRuntimeRole.ts'

// This route deliberately reports process/control state only. Project reads and mutations stay owner-routed.
export const reviewServingStatusRoutes = new Elysia().get(runtimeReviewServingStatusPath, () => {
  const pauseMarker = getReviewServingProjectorPauseMarkerState()

  return {
    data: {
      owner: {proxyConfigured: shouldCurrentServerProxyApiToOwner(), readiness: 'not_probed' as const},
      pauseMarker: {
        createdAt: pauseMarker.exists ? new Date(pauseMarker.createdAtMs).toISOString() : null,
        exists: pauseMarker.exists,
        updatedAt: pauseMarker.exists ? new Date(pauseMarker.updatedAtMs).toISOString() : null,
      },
      queue: {exclusiveWorkActive: getActiveDuckdbExclusiveWorkSnapshot() !== null},
      role: getCurrentServerRole(),
      snapshot: {lastProgressedAt: null, readable: null as boolean | null},
    },
    error: null,
  }
})
